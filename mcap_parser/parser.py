"""
Multi-encoding MCAP / ROS bag parser.

Handles:
- ROS 2 CDR encoding  (rcl_interfaces/msg/Log, tf2_msgs/msg/TFMessage, …)
- Foxglove protobuf   (foxglove.Log)
- .db3 bags           (rosbags CDR path, unchanged)

Unknown encodings are skipped with a warning; the caller receives the
warnings list in the response so the UI can surface them.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# ── Schema helpers ────────────────────────────────────────────────────────────

# All schema names that represent a ROS log message.
_LOG_SCHEMAS = frozenset([
    "rcl_interfaces/msg/Log",   # ROS 2 standard (/rosout)
    "rosgraph_msgs/Log",        # ROS 1 compat
    "foxglove.Log",             # Foxglove Studio (protobuf)
])

# Schema names for TF transforms.
_TF_SCHEMAS = frozenset([
    "tf2_msgs/msg/TFMessage",
    "geometry_msgs/msg/TransformStamped",
])

# Schema names for diagnostics.
_DIAGNOSTIC_SCHEMAS = frozenset([
    "diagnostic_msgs/DiagnosticArray",
    "diagnostic_msgs/msg/DiagnosticArray",
])

def _extract_sensor_info(topic_name: str, msg_type: str) -> dict[str, str] | None:
    if not isinstance(topic_name, str) or not topic_name or not isinstance(msg_type, str) or not msg_type:
        return None
    t = msg_type.lower()
    sensor_type = None
    if "laserscan" in t:
        sensor_type = "LiDAR"
    elif "pointcloud2" in t:
        sensor_type = "PointCloud"
    elif "imu" in t:
        sensor_type = "IMU"
    elif "image" in t:
        sensor_type = "Camera"
    elif "navsatfix" in t:
        sensor_type = "GPS"
    elif "odometry" in t:
        sensor_type = "Odometry"
    elif "range" in t:
        sensor_type = "Range"
        
    if not sensor_type:
        return None
        
    name = topic_name.strip("/")
    if name.startswith("sensors/"):
        name = name[len("sensors/"):]
    elif name.startswith("sensor/"):
        name = name[len("sensor/"):]
        
    return {
        "name": name,
        "topic": topic_name,
        "type": sensor_type,
        "msg_type": msg_type
    }

_SEV_INT_MAP = {10: "DEBUG", 20: "INFO", 30: "WARN", 40: "ERROR", 50: "FATAL"}

# Foxglove.Log numeric level → severity string
_FOXGLOVE_LEVEL_MAP = {0: "INFO", 1: "DEBUG", 2: "INFO", 3: "WARN", 4: "ERROR", 5: "FATAL"}


# ── Inline TF parser (no backend dependency) ─────────────────────────────────

def _frame_pair(t: Any) -> tuple[Any, Any]:
    """The (child, parent) frame ids of one transform, from attributes or dict keys."""
    child = getattr(t, "child_frame_id", None) or (
        t.get("child_frame_id") if isinstance(t, dict) else None
    )
    header = getattr(t, "header", None)
    parent = (
        getattr(header, "frame_id", None)
        if header else
        (t.get("header", {}).get("frame_id") if isinstance(t, dict) else None)
    )
    return child, parent


class _TFParser:
    def __init__(self) -> None:
        self.frames: dict[str, str] = {}
        # Transforms that couldn't be read, reported as a parse warning (#89).
        self.skipped = 0

    def parse(self, msg: Any) -> None:
        """Record each transform's frames. A transform that isn't shaped like
        one is skipped and counted, and the rest are still read. Other errors
        propagate."""
        transforms = getattr(msg, "transforms", None) or []
        if not transforms and isinstance(msg, dict):
            transforms = msg.get("transforms") or []
        try:
            transforms = list(transforms)
        except TypeError:
            self._skip(f"transforms is a {type(transforms).__name__}, not a list")
            return
        for t in transforms:
            try:
                child, parent = _frame_pair(t)
                if child and parent:
                    self.frames[child.lstrip("/")] = parent.lstrip("/")
            except (AttributeError, TypeError) as exc:
                self._skip(str(exc))

    def _skip(self, detail: str) -> None:
        self.skipped += 1
        logger.debug("Skipping an unreadable TF transform: %s", detail)

    def skipped_warnings(self) -> list[str]:
        """The parse warning for skipped transforms, if there were any."""
        if not self.skipped:
            return []
        return [
            f"Skipped {self.skipped} TF transform(s) that couldn't be read, "
            "so the frame tree may be incomplete."
        ]

    def frames_list(self) -> list[dict[str, str]]:
        return [{"name": c, "parent": p} for c, p in self.frames.items()]


# ── Anomaly derivation (matches backend logic) ────────────────────────────────

def _derive_anomalies(timeline_events: list[dict], logs: list[dict]) -> list[dict]:
    anomalies = []
    for ev in timeline_events:
        if ev.get("type") == "log" and ev.get("sev") in ("error", "fatal"):
            anomalies.append({
                "id": f"a_{len(anomalies) + 1}",
                "t": ev["t"],
                "kind": ev.get("topic", "unknown"),
                "severity": "critical" if ev["sev"] == "fatal" else "high",
                "label": ev.get("label", ""),
            })
    return anomalies


# ── Foxglove protobuf decoder ─────────────────────────────────────────────────

def _decode_foxglove_log(
    raw: bytes,
    timestamp: float,
    start_time: float,
    warnings: list[str],
) -> dict[str, Any] | None:
    try:
        from foxglove_schemas_protobuf.Log_pb2 import Log as FoxgloveLog  # type: ignore[import]
        msg = FoxgloveLog()
        msg.ParseFromString(raw)
        sev = _FOXGLOVE_LEVEL_MAP.get(msg.level, "INFO")
        return {
            "t": str(timedelta(seconds=timestamp - start_time)),
            "node": msg.name or "unknown",
            "sev": sev,
            "text": msg.message,
            "topic": "foxglove.Log",
        }
    except Exception as exc:
        warnings.append(f"foxglove.Log decode error: {exc}")
        return None


# ── MCAP parser ───────────────────────────────────────────────────────────────

def _parse_mcap(filepath: str) -> dict[str, Any]:
    """Parse an MCAP file supporting both CDR and protobuf message encodings.

    Strategy:
    - Message counts and bag timing come from the MCAP statistics block (O(1)).
    - CDR log + TF channels are decoded via iter_decoded_messages (Ros2DecoderFactory).
    - Protobuf log channels (foxglove.Log) are decoded via a separate iter_messages
      pass using raw bytes + foxglove_schemas_protobuf.
    - Protobuf TF channels (foxglove.FrameTransform) are currently skipped — frame
      graph data is not available in Foxglove-only bags.
    This split avoids the "no decoder factory for protobuf" exception that
    iter_decoded_messages raises when it encounters mixed-encoding bags.
    """
    from mcap.reader import make_reader
    from mcap_ros2.decoder import DecoderFactory as Ros2DecoderFactory
    import json

    decoder_factories = [Ros2DecoderFactory()]
    has_ros1 = False
    try:
        from mcap_ros1.decoder import DecoderFactory as Ros1DecoderFactory
        decoder_factories.append(Ros1DecoderFactory())
        has_ros1 = True
    except ImportError:
        pass

    has_protobuf = False
    try:
        from mcap_protobuf.decoder import DecoderFactory as ProtobufDecoderFactory
        decoder_factories.append(ProtobufDecoderFactory())
        has_protobuf = True
    except ImportError:
        pass

    warnings: list[str] = []
    tf_parser = _TFParser()
    logs: list[dict] = []
    timeline_events: list[dict] = []
    diagnostics: list[dict] = []

    with open(filepath, "rb") as f:
        reader = make_reader(f, decoder_factories=decoder_factories)
        summary = reader.get_summary()

        # ── Topic catalog ─────────────────────────────────────────────────────
        topics_dict: dict[str, dict] = {}
        channel_to_topic: dict[int, str] = {}
        channel_to_encoding: dict[int, str] = {}
        log_channel_ids: set[int] = set()
        tf_channel_ids: set[int] = set()
        diag_channel_ids: set[int] = set()

        for channel in (summary.channels if summary else {}).values():
            schema = (summary.schemas if summary else {}).get(channel.schema_id)
            schema_name = schema.name if schema else "unknown"
            encoding = getattr(channel, "message_encoding", "cdr")
            topics_dict[channel.topic] = {
                "name": channel.topic,
                "hz": 0.0,
                "type": schema_name,
                "msgs": 0,
                "encoding": encoding,
            }
            channel_to_topic[channel.id] = channel.topic
            channel_to_encoding[channel.id] = encoding
            if schema_name in _LOG_SCHEMAS:
                log_channel_ids.add(channel.id)
                logger.info("Log channel: %s (schema=%s, enc=%s)", channel.topic, schema_name, encoding)
            if schema_name in _TF_SCHEMAS or channel.topic in ("/tf", "/tf_static"):
                tf_channel_ids.add(channel.id)
            if schema_name in _DIAGNOSTIC_SCHEMAS:
                diag_channel_ids.add(channel.id)

        # ── Message counts + bag timing from statistics (O(1)) ────────────────
        start_time: float | None = None
        end_time: float | None = None
        stats = summary.statistics if summary else None
        if stats:
            for ch_id, count in (stats.channel_message_counts or {}).items():
                topic = channel_to_topic.get(ch_id)
                if topic and topic in topics_dict:
                    topics_dict[topic]["msgs"] = count
            if stats.message_start_time:
                start_time = stats.message_start_time / 1e9
            if stats.message_end_time:
                end_time = stats.message_end_time / 1e9

        # ── Fallback message count when stats block has no channel counts ────
        # Some MCAP recorders write timing stats but omit channel_message_counts.
        # In that case every topic shows msgs=0; iterate to get real counts.
        if topics_dict and sum(td["msgs"] for td in topics_dict.values()) == 0:
            warnings.append(
                "MCAP statistics block missing message counts — counting by iteration"
            )
            for _, channel, message in reader.iter_messages():
                topic = channel_to_topic.get(channel.id)
                if topic and topic in topics_dict:
                    topics_dict[topic]["msgs"] += 1
                if message.log_time:
                    ts = message.log_time / 1e9
                    if start_time is None or ts < start_time:
                        start_time = ts
                    if end_time is None or ts > end_time:
                        end_time = ts

        # ── Split channels by encoding ────────────────────────────────────────
        # iter_decoded_messages throws when it hits a channel and no factory is registered.
        # Only pass supported channels to it.
        supported_encodings = {"cdr"}
        if has_ros1:
            supported_encodings.add("ros1")
        if has_protobuf:
            supported_encodings.add("protobuf")

        cdr_log_ids  = {cid for cid in log_channel_ids  if channel_to_encoding.get(cid) in supported_encodings}
        cdr_tf_ids   = {cid for cid in tf_channel_ids   if channel_to_encoding.get(cid) in supported_encodings}
        cdr_diag_ids = {cid for cid in diag_channel_ids if channel_to_encoding.get(cid) in supported_encodings}
        
        # If mcap-protobuf-support is not installed, fallback to manual foxglove log decoding
        pb_log_ids   = {cid for cid in log_channel_ids  if channel_to_encoding.get(cid) == "protobuf" and "protobuf" not in supported_encodings}

        cdr_topics = list({
            channel_to_topic[cid]
            for cid in (cdr_log_ids | cdr_tf_ids | cdr_diag_ids)
            if cid in channel_to_topic
        })
        pb_log_topics = list({
            channel_to_topic[cid]
            for cid in pb_log_ids
            if cid in channel_to_topic
        })

        # ── CDR pass: ROS 2 standard bags ─────────────────────────────────────
        if cdr_topics:
            try:
                for schema, channel, message, decoded_message in reader.iter_decoded_messages(
                    topics=cdr_topics
                ):
                    if decoded_message is None:
                        continue
                    ts = message.log_time / 1e9
                    rel = ts - (start_time or ts)

                    if channel.id in cdr_log_ids:
                        schema = (summary.schemas if summary else {}).get(channel.schema_id)
                        schema_name = schema.name if schema else ""
                        node = getattr(decoded_message, "name", "unknown")
                        
                        if schema_name == "foxglove.Log":
                            text = getattr(decoded_message, "message", "")
                            level = getattr(decoded_message, "level", 0)
                            sev = _FOXGLOVE_LEVEL_MAP.get(level, "INFO")
                        else:
                            text = getattr(decoded_message, "msg", "")
                            level = getattr(decoded_message, "level", 20)
                            sev = _SEV_INT_MAP.get(level, "INFO")
                            
                        logs.append({
                            "t": str(timedelta(seconds=rel)),
                            "node": node,
                            "sev": sev,
                            "text": text,
                            "topic": channel.topic,
                        })
                        if sev in ("WARN", "ERROR", "FATAL"):
                            timeline_events.append({
                                "t": rel,
                                "type": "log",
                                "sev": sev.lower(),
                                "topic": channel.topic,
                                "label": text[:40],
                            })

                    elif channel.id in cdr_tf_ids:
                        tf_parser.parse(decoded_message)

                    elif channel.id in cdr_diag_ids:
                        status_list = getattr(decoded_message, "status", None) or []
                        for status in status_list:
                            level_int = getattr(status, "level", 0)
                            level_map = {0: "OK", 1: "WARN", 2: "ERROR", 3: "STALE"}
                            level_str = level_map.get(level_int, "OK")
                            
                            name = getattr(status, "name", "unknown")
                            msg_text = getattr(status, "message", "")
                            hw_id = getattr(status, "hardware_id", "")
                            
                            kv_list = getattr(status, "values", [])
                            values = {}
                            for kv in kv_list:
                                k = getattr(kv, "key", None)
                                v = getattr(kv, "value", None)
                                if k is not None:
                                    values[k] = str(v)
                                    
                            diagnostics.append({
                                "t": str(timedelta(seconds=rel)),
                                "level": level_str,
                                "name": name,
                                "message": msg_text,
                                "hardware_id": hw_id,
                                "values": values,
                                "values_json": json.dumps(values),
                                "topic": channel.topic,
                            })

            except Exception as exc:
                warnings.append(f"CDR decode pass failed: {exc}")
                logger.warning("CDR iter_decoded_messages error for %s: %s", filepath, exc)

        # ── Protobuf log pass: Foxglove Studio bags ───────────────────────────
        # Uses raw iter_messages (no decoder factory needed) + manual protobuf decode.
        if pb_log_topics:
            try:
                for schema, channel, message in reader.iter_messages(topics=pb_log_topics):
                    if channel.id not in pb_log_ids:
                        continue
                    schema_name = schema.name if schema else ""
                    ts = message.log_time / 1e9
                    rel = ts - (start_time or ts)
                    if schema_name == "foxglove.Log":
                        entry = _decode_foxglove_log(
                            message.data, ts, start_time or ts, warnings
                        )
                        if entry is None:
                            continue
                        logs.append({
                            "t": str(timedelta(seconds=rel)),
                            "node": entry["node"],
                            "sev": entry["sev"],
                            "text": entry["text"],
                            "topic": channel.topic,
                        })
                        sev = entry["sev"]
                        if sev in ("WARN", "ERROR", "FATAL"):
                            timeline_events.append({
                                "t": rel,
                                "type": "log",
                                "sev": sev.lower(),
                                "topic": channel.topic,
                                "label": entry["text"][:40],
                            })
                    else:
                        warnings.append(
                            f"Unhandled protobuf log schema {schema_name!r} on {channel.topic!r}"
                        )
            except Exception as exc:
                warnings.append(f"Protobuf log decode pass failed: {exc}")
                logger.warning("Protobuf iter_messages error for %s: %s", filepath, exc)

    # ── Finalise ──────────────────────────────────────────────────────────────
    dur = (end_time - start_time) if start_time is not None and end_time is not None else 0.0

    logs.sort(key=lambda l: l["t"])
    for idx, log in enumerate(logs):
        log["id"] = f"l_{idx + 1}"

    sensors = []
    for idx, td in enumerate(topics_dict.values()):
        s_info = _extract_sensor_info(td["name"], td["type"])
        if s_info:
            s_info["id"] = f"s_{len(sensors) + 1}"
            sensors.append(s_info)

    for idx, d in enumerate(diagnostics):
        d["id"] = f"d_{idx + 1}"

    for td in topics_dict.values():
        td.pop("encoding", None)  # internal field, strip from response
        td["hz"] = round(td["msgs"] / dur, 2) if dur > 0 else 0.0

    total_messages = sum(td["msgs"] for td in topics_dict.values())

    return {
        "ok": True,
        "session_id": str(uuid.uuid4()),
        "filename": os.path.basename(filepath),
        "filepath": filepath,
        "robot_name": "robot",
        "ros_version": "ROS 2",
        "duration_seconds": dur,
        "start_time": datetime.fromtimestamp(start_time).isoformat() if start_time else None,
        "end_time": datetime.fromtimestamp(end_time).isoformat() if end_time else None,
        "total_messages": total_messages,
        "topics": list(topics_dict.values()),
        "timeline_events": timeline_events,
        "logs": logs,
        "anomalies": _derive_anomalies(timeline_events, logs),
        "kgraph": {"nodes": [], "edges": []},
        "frames": tf_parser.frames_list(),
        "replay": [],
        "sensors": sensors,
        "diagnostics": diagnostics,
        "parse_warnings": warnings + tf_parser.skipped_warnings(),
    }


# ── DB3 / SQLite bag parser ───────────────────────────────────────────────────

def _parse_db3(filepath: str) -> dict[str, Any]:
    from rosbags.rosbag2 import Reader
    from rosbags.typesys import Stores, get_typestore
    import json

    typestore = get_typestore(Stores.ROS2_HUMBLE)
    warnings: list[str] = []
    tf_parser = _TFParser()
    logs: list[dict] = []
    timeline_events: list[dict] = []
    diagnostics: list[dict] = []
    topics_dict: dict[str, dict] = {}
    start_time: float | None = None
    end_time: float | None = None

    log_connections = set()
    tf_connections = set()
    diag_connections = set()
    messages_read = 0

    try:
        with Reader(filepath) as reader:
            for connection in reader.connections:
                topics_dict[connection.topic] = {
                    "name": connection.topic,
                    "hz": 0.0,
                    "type": connection.msgtype,
                    "msgs": 0,
                }
                if connection.msgtype in _LOG_SCHEMAS:
                    log_connections.add(connection.topic)
                elif connection.msgtype in _TF_SCHEMAS or connection.topic in ("/tf", "/tf_static"):
                    tf_connections.add(connection.topic)
                elif connection.msgtype in _DIAGNOSTIC_SCHEMAS:
                    diag_connections.add(connection.topic)

            decode_topics = log_connections | tf_connections | diag_connections

            for connection, timestamp_ns, rawdata in reader.messages():
                messages_read += 1
                topic = connection.topic
                timestamp = timestamp_ns / 1e9

                if start_time is None:
                    start_time = timestamp
                end_time = timestamp

                if topic in topics_dict:
                    topics_dict[topic]["msgs"] += 1

                if topic not in decode_topics:
                    continue

                try:
                    msg = typestore.deserialize_cdr(rawdata, connection.msgtype)
                except Exception as exc:
                    warnings.append(f"CDR decode failed for {topic!r} ({connection.msgtype}): {exc}")
                    continue

                rel = timestamp - (start_time or timestamp)

                if topic in log_connections:
                    node = getattr(msg, "name", "unknown")
                    msg_text = getattr(msg, "msg", "")
                    level_int = getattr(msg, "level", 20)
                    sev = _SEV_INT_MAP.get(level_int, "INFO")
                    logs.append({
                        "t": str(timedelta(seconds=rel)),
                        "node": node,
                        "sev": sev,
                        "text": msg_text,
                        "topic": topic,
                    })
                    if sev in ("WARN", "ERROR", "FATAL"):
                        timeline_events.append({
                            "t": float(rel),
                            "type": "log",
                            "sev": sev.lower(),
                            "topic": topic,
                            "label": msg_text[:40],
                        })
                elif topic in tf_connections:
                    tf_parser.parse(msg)
                elif topic in diag_connections:
                    status_list = getattr(msg, "status", None) or []
                    for status in status_list:
                        level_int = getattr(status, "level", 0)
                        level_map = {0: "OK", 1: "WARN", 2: "ERROR", 3: "STALE"}
                        level_str = level_map.get(level_int, "OK")
                        
                        name = getattr(status, "name", "unknown")
                        msg_text = getattr(status, "message", "")
                        hw_id = getattr(status, "hardware_id", "")
                        
                        kv_list = getattr(status, "values", [])
                        values = {}
                        for kv in kv_list:
                            k = getattr(kv, "key", None)
                            v = getattr(kv, "value", None)
                            if k is not None:
                                values[k] = str(v)
                                
                        diagnostics.append({
                            "t": str(timedelta(seconds=rel)),
                            "level": level_str,
                            "name": name,
                            "message": msg_text,
                            "hardware_id": hw_id,
                            "values": values,
                            "values_json": json.dumps(values),
                            "topic": topic,
                        })

    except Exception as exc:
        if not messages_read:
            # Nothing came out of the bag, so this isn't a partial parse.
            # Fail, instead of reporting an empty bag as parsed (#86).
            raise
        warnings.append(f"DB3 reader failed: {exc}")
        logger.exception("DB3 parse error for %s", filepath)

    dur = (end_time - start_time) if start_time is not None and end_time is not None else 0.0

    logs.sort(key=lambda l: l["t"])
    for idx, log in enumerate(logs):
        log["id"] = f"l_{idx + 1}"

    sensors = []
    for idx, td in enumerate(topics_dict.values()):
        s_info = _extract_sensor_info(td["name"], td["type"])
        if s_info:
            s_info["id"] = f"s_{len(sensors) + 1}"
            sensors.append(s_info)

    for idx, d in enumerate(diagnostics):
        d["id"] = f"d_{idx + 1}"

    total_messages = 0
    for td in topics_dict.values():
        td["hz"] = round(td["msgs"] / dur, 2) if dur > 0 else 0.0
        total_messages += td["msgs"]

    return {
        "ok": True,
        "session_id": str(uuid.uuid4()),
        "filename": os.path.basename(filepath),
        "filepath": filepath,
        "robot_name": "robot",
        "ros_version": "ROS 2",
        "duration_seconds": dur,
        "start_time": datetime.fromtimestamp(start_time).isoformat() if start_time else None,
        "end_time": datetime.fromtimestamp(end_time).isoformat() if end_time else None,
        "total_messages": total_messages,
        "topics": list(topics_dict.values()),
        "timeline_events": timeline_events,
        "logs": logs,
        "anomalies": _derive_anomalies(timeline_events, logs),
        "kgraph": {"nodes": [], "edges": []},
        "frames": tf_parser.frames_list(),
        "replay": [],
        "sensors": sensors,
        "diagnostics": diagnostics,
        "parse_warnings": warnings + tf_parser.skipped_warnings(),
    }


# ── Public entry point ────────────────────────────────────────────────────────

def parse_bag(filepath: str) -> dict[str, Any]:
    """Parse an MCAP or DB3 bag file. Returns a structured dict.

    The file path must be accessible inside this container
    (typically a /host-mounted path translated by the caller).
    """
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Bag file not found: {filepath!r}")

    ext = Path(filepath).suffix.lower()
    if ext == ".mcap":
        return _parse_mcap(filepath)
    if ext in (".db3", ".bag"):
        return _parse_db3(filepath)
    raise ValueError(f"Unsupported bag format: {ext!r} ({filepath})")
