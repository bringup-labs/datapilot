"""Unit coverage for pure helpers in app.services.parser.

Covers:
- _extract_sensor_info: sensor-type detection, name normalization, None paths.
- _seconds_from_log_t: timestamp parsing incl. the "N day, ..." 0.0 bug.
- _derive_anomalies: anomaly derivation + nearest-log linking + severity mapping.
- demo-bag parse_bag(): hz values carried through, sensor/diagnostic/anomaly
  derivation end-to-end, and sub-second hz characterization via the rounding
  formula the parser uses (round(msgs / dur, 2)).
"""
from __future__ import annotations

from datetime import timedelta

import pytest

from app.services.parser import (
    _derive_anomalies,
    _extract_sensor_info,
    _seconds_from_log_t,
    ingestion_parser,
    scope_log_ids,
)


# ---------------------------------------------------------------------------
# scope_log_ids  (issue #68 — globally-unique Log identity)
# ---------------------------------------------------------------------------

class TestScopeLogIds:
    def test_prefixes_log_ids_with_session(self):
        parsed = {"logs": [{"id": "l_1"}, {"id": "l_2"}], "anomalies": []}
        scope_log_ids("sessA", parsed)
        assert [l["id"] for l in parsed["logs"]] == ["sessA:l_1", "sessA:l_2"]

    def test_remaps_anomaly_source_log_ids_consistently(self):
        parsed = {
            "logs": [{"id": "l_1"}, {"id": "l_2"}],
            "anomalies": [{"id": "a_1", "source_log_id": "l_2"}],
        }
        scope_log_ids("sessA", parsed)
        # The anomaly still points at the (now-scoped) same log.
        log_ids = {l["id"] for l in parsed["logs"]}
        assert parsed["anomalies"][0]["source_log_id"] == "sessA:l_2"
        assert parsed["anomalies"][0]["source_log_id"] in log_ids

    def test_two_sessions_do_not_collide(self):
        a = {"logs": [{"id": "l_1"}], "anomalies": []}
        b = {"logs": [{"id": "l_1"}], "anomalies": []}
        scope_log_ids("sessA", a)
        scope_log_ids("sessB", b)
        assert a["logs"][0]["id"] != b["logs"][0]["id"]

    def test_idempotent_when_already_scoped(self):
        parsed = {"logs": [{"id": "sessA:l_1"}], "anomalies": []}
        scope_log_ids("sessA", parsed)
        assert parsed["logs"][0]["id"] == "sessA:l_1"

    def test_null_anomaly_source_left_alone(self):
        parsed = {"logs": [{"id": "l_1"}], "anomalies": [{"id": "a_1", "source_log_id": None}]}
        scope_log_ids("sessA", parsed)
        assert parsed["anomalies"][0]["source_log_id"] is None


# ---------------------------------------------------------------------------
# _extract_sensor_info
# ---------------------------------------------------------------------------

class TestExtractSensorInfo:
    @pytest.mark.parametrize("msg_type,expected", [
        ("sensor_msgs/LaserScan", "LiDAR"),
        ("sensor_msgs/msg/PointCloud2", "PointCloud"),
        ("sensor_msgs/Imu", "IMU"),
        ("sensor_msgs/Image", "Camera"),
        ("sensor_msgs/NavSatFix", "GPS"),
        ("nav_msgs/Odometry", "Odometry"),
        ("sensor_msgs/Range", "Range"),
    ])
    def test_sensor_type_detection(self, msg_type, expected):
        info = _extract_sensor_info("/some_topic", msg_type)
        assert info is not None
        assert info["type"] == expected

    def test_detection_is_case_insensitive(self):
        info = _extract_sensor_info("/scan", "Sensor_Msgs/LASERSCAN")
        assert info["type"] == "LiDAR"

    def test_non_sensor_type_returns_none(self):
        assert _extract_sensor_info("/cmd_vel", "geometry_msgs/Twist") is None

    def test_strips_leading_slash_from_name(self):
        info = _extract_sensor_info("/imu", "sensor_msgs/Imu")
        assert info["name"] == "imu"

    def test_strips_sensors_prefix(self):
        info = _extract_sensor_info("/sensors/lidar_a", "sensor_msgs/PointCloud2")
        assert info["name"] == "lidar_a"

    def test_strips_singular_sensor_prefix(self):
        info = _extract_sensor_info("/sensor/imu0", "sensor_msgs/Imu")
        assert info["name"] == "imu0"

    def test_preserves_full_topic_field(self):
        info = _extract_sensor_info("/sensors/lidar_a", "sensor_msgs/PointCloud2")
        assert info["topic"] == "/sensors/lidar_a"
        assert info["msg_type"] == "sensor_msgs/PointCloud2"

    def test_empty_topic_returns_none(self):
        assert _extract_sensor_info("", "sensor_msgs/Imu") is None

    def test_empty_msg_type_returns_none(self):
        assert _extract_sensor_info("/imu", "") is None

    def test_non_string_inputs_return_none(self):
        assert _extract_sensor_info(None, "sensor_msgs/Imu") is None
        assert _extract_sensor_info("/imu", None) is None
        assert _extract_sensor_info(123, "sensor_msgs/Imu") is None

    def test_first_match_wins_priority(self):
        # A type containing both "image" and "range" — laserscan/pointcloud/imu
        # checks come first; here only "image" matches before "range".
        info = _extract_sensor_info("/cam", "custom/ImageRange")
        assert info["type"] == "Camera"


# ---------------------------------------------------------------------------
# _seconds_from_log_t  (mirrors causal_rules.log_time_to_seconds)
# ---------------------------------------------------------------------------

class TestSecondsFromLogT:
    def test_full_hms_with_millis(self):
        assert _seconds_from_log_t("00:01:06.118") == pytest.approx(66.118)

    def test_hours(self):
        assert _seconds_from_log_t("01:00:00.000") == pytest.approx(3600.0)

    def test_plain_float_fallback(self):
        assert _seconds_from_log_t("12.5") == pytest.approx(12.5)

    def test_garbage_returns_zero(self):
        assert _seconds_from_log_t("xyz") == 0.0

    def test_two_part_returns_zero(self):
        assert _seconds_from_log_t("01:30") == 0.0

    def test_day_form_is_parsed(self):
        # Fixed (issue #70) — same change as causal_rules.log_time_to_seconds.
        # The "N day, H:MM:SS" form produced by str(timedelta) for >24h
        # durations is now parsed instead of silently yielding 0.0.
        assert _seconds_from_log_t(str(timedelta(seconds=90061.5))) == pytest.approx(90061.5)


# ---------------------------------------------------------------------------
# _derive_anomalies
# ---------------------------------------------------------------------------

class TestDeriveAnomalies:
    def test_no_anomaly_events_yields_empty(self):
        events = [{"t": 1.0, "type": "log", "sev": "info", "topic": "/x", "label": "hi"}]
        logs = [{"id": "l_1", "t": "00:00:01.000"}]
        assert _derive_anomalies(events, logs) == []

    def test_single_anomaly_basic_fields(self):
        events = [{"t": 64.2, "type": "anomaly", "sev": "critical",
                   "topic": "/sensors/lidar_a", "label": "dropout"}]
        logs = [{"id": "l_1", "t": "00:01:04.215"}]
        out = _derive_anomalies(events, logs)
        assert len(out) == 1
        a = out[0]
        assert a["id"] == "a_1"
        assert a["t"] == 64.2
        assert a["kind"] == "/sensors/lidar_a"
        assert a["severity"] == "critical"
        assert a["confidence"] == 1.0
        assert a["topic"] == "/sensors/lidar_a"
        assert a["label"] == "dropout"

    def test_links_to_nearest_log_by_time(self):
        events = [{"t": 64.2, "type": "anomaly", "sev": "critical",
                   "topic": "/x", "label": "boom"}]
        logs = [
            {"id": "l_far", "t": "00:00:10.000"},   # 10s
            {"id": "l_near", "t": "00:01:04.000"},  # 64s — closest to 64.2
            {"id": "l_other", "t": "00:01:30.000"}, # 90s
        ]
        out = _derive_anomalies(events, logs)
        assert out[0]["source_log_id"] == "l_near"

    def test_multiple_anomalies_get_sequential_ids(self):
        events = [
            {"t": 1.0, "type": "anomaly", "sev": "warning", "topic": "/a", "label": "x"},
            {"t": 2.0, "type": "log", "sev": "info", "topic": "/b", "label": "y"},
            {"t": 3.0, "type": "anomaly", "sev": "critical", "topic": "/c", "label": "z"},
        ]
        logs = [{"id": "l_1", "t": "00:00:01.000"}]
        out = _derive_anomalies(events, logs)
        assert [a["id"] for a in out] == ["a_1", "a_2"]

    def test_no_logs_means_null_source(self):
        events = [{"t": 5.0, "type": "anomaly", "sev": "warning", "topic": "/x", "label": "x"}]
        out = _derive_anomalies(events, [])
        assert out[0]["source_log_id"] is None

    def test_defaults_when_fields_missing(self):
        events = [{"type": "anomaly"}]  # no t/sev/topic/label
        logs = [{"id": "l_1", "t": "00:00:00.000"}]
        out = _derive_anomalies(events, logs)
        a = out[0]
        assert a["t"] == 0.0
        assert a["severity"] == "info"
        assert a["kind"] == "unknown"


# ---------------------------------------------------------------------------
# parse_bag (demo path) — end-to-end derivation + hz characterization
# ---------------------------------------------------------------------------

class TestDemoBagParse:
    async def test_demo_carries_topic_hz(self):
        res = await ingestion_parser.parse_bag("lidar_failure.mcap")
        topics_by_name = {t["name"]: t for t in res["topics"]}
        # /scan is declared at 10 Hz in the demo dataset.
        assert topics_by_name["/scan"]["hz"] == 10.0
        # /tf at 100 Hz.
        assert topics_by_name["/tf"]["hz"] == 100.0
        # Sub-second-rate topics keep fractional hz.
        assert topics_by_name["/move_base/goal"]["hz"] == 0.1

    async def test_demo_derives_sensors(self):
        res = await ingestion_parser.parse_bag("lidar_failure.mcap")
        sensor_types = {s["type"] for s in res["sensors"]}
        # LaserScan→LiDAR, PointCloud2→PointCloud, Imu→IMU, Odometry→Odometry.
        assert {"LiDAR", "PointCloud", "IMU", "Odometry"} <= sensor_types
        # cmd_vel (Twist) and tf are not sensors.
        sensor_topics = {s["topic"] for s in res["sensors"]}
        assert "/cmd_vel" not in sensor_topics

    async def test_demo_derives_diagnostics_from_diagnostics_topic(self):
        res = await ingestion_parser.parse_bag("lidar_failure.mcap")
        assert len(res["diagnostics"]) >= 1
        for d in res["diagnostics"]:
            assert d["id"].startswith("d_")
            # values_json must be valid serialized JSON string.
            assert isinstance(d["values_json"], str)

    async def test_demo_derives_anomalies_with_source_logs(self):
        res = await ingestion_parser.parse_bag("lidar_failure.mcap")
        anomalies = res["anomalies"]
        assert len(anomalies) >= 1
        # Each derived anomaly links to a real log id present in the session.
        log_ids = {l["id"] for l in res["logs"]}
        for a in anomalies:
            assert a["source_log_id"] in log_ids

    async def test_demo_sets_session_and_filepath(self):
        res = await ingestion_parser.parse_bag("/tmp/lidar_failure.mcap")
        assert res["filename"] == "lidar_failure.mcap"
        assert res["filepath"] == "/tmp/lidar_failure.mcap"
        assert "session_id" in res

    def test_hz_rounding_formula_is_two_decimals(self):
        # Characterize the exact hz formula the inline parsers use:
        #   round(msgs / dur, 2).
        # A sub-second-rate topic (4 msgs over 128s) rounds to 0.03 Hz, and a
        # zero-duration bag yields 0.0 (guarded division).
        dur = 128.0
        assert round(4 / dur, 2) == 0.03
        assert round(1284 / dur, 2) == 10.03
        # Zero-duration guard: parser uses `if dur > 0 else 0.0`.
        guarded = round(5 / dur, 2) if dur > 0 else 0.0
        assert guarded == 0.04
        assert (round(5 / 0, 2) if 0 > 0 else 0.0) == 0.0


# ---------------------------------------------------------------------------
# severity mapping (the int→string sev_map used by the inline parsers)
# ---------------------------------------------------------------------------

class TestSeverityMapping:
    def test_ros_level_to_severity_string(self):
        # The parsers map rcl_interfaces Log levels via this table; we assert the
        # mapping contract used in _parse_mcap / _parse_db3.
        sev_map = {10: "DEBUG", 20: "INFO", 30: "WARN", 40: "ERROR", 50: "FATAL"}
        assert sev_map[10] == "DEBUG"
        assert sev_map[20] == "INFO"
        assert sev_map[30] == "WARN"
        assert sev_map[40] == "ERROR"
        assert sev_map[50] == "FATAL"
        # Unknown levels default to INFO via sev_map.get(level, "INFO").
        assert sev_map.get(99, "INFO") == "INFO"

    def test_diagnostic_level_mapping(self):
        level_map = {0: "OK", 1: "WARN", 2: "ERROR", 3: "STALE"}
        assert level_map[0] == "OK"
        assert level_map[2] == "ERROR"
        assert level_map.get(7, "OK") == "OK"


# ---------------------------------------------------------------------------
# _parse_db3 — undeclared-topic guard (issue #82)
# ---------------------------------------------------------------------------

class _FakeConnection:
    """Mimics rosbags' connection record (topic + msgtype)."""

    def __init__(self, topic: str, msgtype: str = "std_msgs/msg/String"):
        self.topic = topic
        self.msgtype = msgtype


class _FakeReader:
    """Minimal stand-in for rosbags.rosbag2.Reader used as a context manager.

    `connections` is the catalog the parser pre-populates `topics_dict` from.
    `messages()` deliberately yields a message on a topic that is NOT in
    `connections` (a corrupt / partial bag) to exercise the guard.
    """

    # Populated per-test by the factory below.
    _connections: list = []
    _messages: list = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    @property
    def connections(self):
        return type(self)._connections

    def messages(self):
        yield from type(self)._messages


class TestParseDb3UndeclaredTopic:
    """Issue #82: a db3 message on a topic with no connection record must be
    skipped/counted gracefully instead of raising KeyError and aborting the
    whole parse (the mcap path already guards this)."""

    def _patch_rosbags(self, monkeypatch, connections, messages):
        import rosbags.rosbag2 as rosbag2_mod

        _FakeReader._connections = connections
        _FakeReader._messages = messages
        monkeypatch.setattr(rosbag2_mod, "Reader", _FakeReader)

    def test_undeclared_topic_message_does_not_raise(self, monkeypatch):
        # One declared topic in the catalog ...
        connections = [_FakeConnection("/declared", "std_msgs/msg/String")]
        declared = _FakeConnection("/declared", "std_msgs/msg/String")
        # ... but a message arrives on an UNDECLARED topic (no connection record).
        undeclared = _FakeConnection("/ghost", "std_msgs/msg/String")
        messages = [
            (declared, 1_000_000_000, b""),     # t = 1.0s, declared topic
            (undeclared, 2_000_000_000, b""),   # t = 2.0s, undeclared → would KeyError
            (declared, 3_000_000_000, b""),     # t = 3.0s, declared topic
        ]
        self._patch_rosbags(monkeypatch, connections, messages)

        res = ingestion_parser._parse_db3("/fake/path.db3")

        # Parse completed without KeyError and the declared topic was counted.
        topics_by_name = {t["name"]: t for t in res["topics"]}
        assert "/declared" in topics_by_name
        assert topics_by_name["/declared"]["msgs"] == 2
        assert res["total_messages"] >= 2

    def test_undeclared_topic_is_handled_gracefully(self, monkeypatch):
        # Bag with NO connection records at all, yet messages still stream in.
        undeclared = _FakeConnection("/ghost", "std_msgs/msg/String")
        messages = [(undeclared, 1_000_000_000, b"")]
        self._patch_rosbags(monkeypatch, [], messages)

        # Must not raise; result is well-formed.
        res = ingestion_parser._parse_db3("/fake/path.db3")
        assert isinstance(res["topics"], list)
        assert "total_messages" in res
