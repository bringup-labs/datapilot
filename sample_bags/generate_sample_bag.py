# /// script
# requires-python = ">=3.11"
# dependencies = ["mcap==1.3.1", "mcap-ros2-support==0.5.7"]
# ///
"""Generate sample_bags/warehouse_nav_abort.mcap, DataPilot's sample recording.

This recording is synthetic: no robot was involved. It is a standard ROS 2 MCAP
file, so it goes through the same parser as a real bag, and regenerating it with
this script produces an identical file.

Scenario: a warehouse robot drives to a dock. About 50 seconds in, its navigation
aborts and the emergency brake engages. The cause is in the data, along with a few
unrelated warnings that a good analysis should set aside.

Run it with:  uv run sample_bags/generate_sample_bag.py
"""
from __future__ import annotations

import heapq
import math
import random
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from mcap.writer import CompressionType
from mcap_ros2.writer import Writer

OUTPUT = Path(__file__).with_name("warehouse_nav_abort.mcap")
START_NS = 1_773_480_413_000_000_000  # 2026-03-14T09:26:53Z, fixed for reproducibility
DURATION_S = 128.0

SEPARATOR = "=" * 80 + "\n"
TIME = "MSG: builtin_interfaces/Time\nint32 sec\nuint32 nanosec\n"
HEADER = "MSG: std_msgs/Header\nbuiltin_interfaces/Time stamp\nstring frame_id\n"
VECTOR3 = "MSG: geometry_msgs/Vector3\nfloat64 x\nfloat64 y\nfloat64 z\n"
POINT = "MSG: geometry_msgs/Point\nfloat64 x\nfloat64 y\nfloat64 z\n"
QUATERNION = "MSG: geometry_msgs/Quaternion\nfloat64 x\nfloat64 y\nfloat64 z\nfloat64 w\n"
POSE = "MSG: geometry_msgs/Pose\ngeometry_msgs/Point position\ngeometry_msgs/Quaternion orientation\n"
TWIST = "MSG: geometry_msgs/Twist\ngeometry_msgs/Vector3 linear\ngeometry_msgs/Vector3 angular\n"


def msgdef(body: str, *dependencies: str) -> str:
    return body + "".join(SEPARATOR + dep for dep in dependencies)


MSGDEFS = {
    "rcl_interfaces/msg/Log": msgdef(
        "byte DEBUG=10\nbyte INFO=20\nbyte WARN=30\nbyte ERROR=40\nbyte FATAL=50\n"
        "builtin_interfaces/Time stamp\nuint8 level\nstring name\nstring msg\n"
        "string file\nstring function\nuint32 line\n",
        TIME,
    ),
    "diagnostic_msgs/msg/DiagnosticArray": msgdef(
        "std_msgs/Header header\ndiagnostic_msgs/DiagnosticStatus[] status\n",
        HEADER,
        TIME,
        "MSG: diagnostic_msgs/DiagnosticStatus\nbyte level\nstring name\nstring message\n"
        "string hardware_id\ndiagnostic_msgs/KeyValue[] values\n",
        "MSG: diagnostic_msgs/KeyValue\nstring key\nstring value\n",
    ),
    "sensor_msgs/msg/LaserScan": msgdef(
        "std_msgs/Header header\nfloat32 angle_min\nfloat32 angle_max\nfloat32 angle_increment\n"
        "float32 time_increment\nfloat32 scan_time\nfloat32 range_min\nfloat32 range_max\n"
        "float32[] ranges\nfloat32[] intensities\n",
        HEADER,
        TIME,
    ),
    "nav_msgs/msg/Odometry": msgdef(
        "std_msgs/Header header\nstring child_frame_id\n"
        "geometry_msgs/PoseWithCovariance pose\ngeometry_msgs/TwistWithCovariance twist\n",
        HEADER,
        TIME,
        "MSG: geometry_msgs/PoseWithCovariance\ngeometry_msgs/Pose pose\nfloat64[36] covariance\n",
        POSE,
        POINT,
        QUATERNION,
        "MSG: geometry_msgs/TwistWithCovariance\ngeometry_msgs/Twist twist\nfloat64[36] covariance\n",
        TWIST,
        VECTOR3,
    ),
    "geometry_msgs/msg/Twist": msgdef(
        "geometry_msgs/Vector3 linear\ngeometry_msgs/Vector3 angular\n", VECTOR3
    ),
    "geometry_msgs/msg/PoseStamped": msgdef(
        "std_msgs/Header header\ngeometry_msgs/Pose pose\n", HEADER, TIME, POSE, POINT, QUATERNION
    ),
    "tf2_msgs/msg/TFMessage": msgdef(
        "geometry_msgs/TransformStamped[] transforms\n",
        "MSG: geometry_msgs/TransformStamped\nstd_msgs/Header header\nstring child_frame_id\n"
        "geometry_msgs/Transform transform\n",
        HEADER,
        TIME,
        "MSG: geometry_msgs/Transform\ngeometry_msgs/Vector3 translation\n"
        "geometry_msgs/Quaternion rotation\n",
        VECTOR3,
        QUATERNION,
    ),
}

INFO, WARN, ERROR = 20, 30, 40

# (seconds from start, severity, logger, message). Logger names use the leading
# slash the bundled causal rules (backend/app/rules/causal.yaml) match on.
SCENARIO_LOGS: list[tuple[float, int, str, str]] = [
    (0.31, INFO, "/lifecycle_manager", "Managed nodes are active"),
    (2.14, INFO, "/amcl", "Localization converged, covariance 0.02"),
    (12.412, INFO, "/move_base", "Received new goal: bay_3_dock (x=24.3, y=-8.1, yaw=1.57)"),
    (12.921, INFO, "/planner", "Global plan computed: 47 waypoints, cost 124.8, time 412ms"),
    # Unrelated warnings. Each one clears up on its own.
    (31.07, WARN, "/perception", "Camera auto-gain raised to 1.4 (low light in aisle 3)"),
    (44.62, WARN, "/amcl", "Particle covariance elevated to 0.11 (limit 0.25)"),
    (47.18, INFO, "/amcl", "Particle covariance back to 0.03"),
    (58.302, WARN, "/perception", "Pedestrian tracker lost 3 frames on track_id=14 (occlusion?)"),
    # The actual failure chain.
    (61.804, WARN, "/sensors", "lidar_a: 14 packet CRC errors in the last 1s on eth1"),
    (62.806, WARN, "/sensors", "lidar_a: eth1 link renegotiated from 1000 to 100 Mbps"),
    (64.215, ERROR, "/sensors", "Sensor dropout: /sensors/lidar_a no data for 782ms (threshold 250ms)"),
    (64.402, WARN, "/costmap", "Costmap update stale, applying defensive inflation"),
    (65.001, WARN, "/costmap", "Inflation radius applied: 0.45m -> 0.85m"),
    (65.412, ERROR, "/recovery", "Recovery triggered: clear_costmap_recovery (attempt 1/3)"),
    (66.118, ERROR, "/move_base", "Planner aborted: no valid path within tolerance after 2 retries"),
    (66.31, ERROR, "/cmd_vel_mux", "Velocity command zeroed; emergency brake engaged"),
    (72.804, INFO, "/sensors", "lidar_a: scan rate back to 10 Hz, eth1 link at 1000 Mbps"),
    (81.502, INFO, "/move_base", "Replan held: operator confirmation required"),
    (94.221, WARN, "/perception", "Detection confidence 0.58 (rolling avg 0.91) on class=person"),
]

GOAL_START_S = 12.412
BRAKE_S = 66.31
SPEED_MPS = 0.5
DROPOUT_S = (63.433, 64.215)  # /scan publishes nothing in this window.
DEGRADED_S = (64.215, 72.804)  # /scan limps along at a reduced rate.


def stamp(t: float) -> dict[str, int]:
    ns = START_NS + int(t * 1e9)
    return {"sec": ns // 1_000_000_000, "nanosec": ns % 1_000_000_000}


def header(t: float, frame_id: str) -> dict[str, Any]:
    return {"stamp": stamp(t), "frame_id": frame_id}


def robot_x(t: float) -> float:
    return max(0.0, min(t, BRAKE_S) - GOAL_START_S) * SPEED_MPS


def commanded_speed(t: float) -> float:
    return SPEED_MPS if GOAL_START_S <= t < BRAKE_S else 0.0


def periodic(rate_hz: float, start: float = 0.0) -> list[float]:
    count = int((DURATION_S - start) * rate_hz)
    return [round(start + i / rate_hz, 6) for i in range(count)]


def scan_times() -> list[float]:
    times = []
    for t in periodic(10.0):
        if DROPOUT_S[0] < t < DROPOUT_S[1]:
            continue
        # While degraded only every third scan makes it through.
        if DEGRADED_S[0] <= t < DEGRADED_S[1] and round(t * 10) % 3 != 0:
            continue
        times.append(t)
    return times


def rosout_events(rng: random.Random) -> list[tuple[float, int, str, str]]:
    events = list(SCENARIO_LOGS)
    for t in periodic(0.2, start=15.0):
        if t < BRAKE_S:
            remaining = max(1, 47 - int((t - GOAL_START_S) * 0.85))
            error = 0.02 + rng.random() * 0.02
            events.append((t, INFO, "/controller", f"Tracking path: {remaining} waypoints left, lateral error {error:.2f}m"))
    for t in periodic(1 / 30, start=5.0):
        percent = 78 - int(t / 30)
        events.append((t, INFO, "/battery", f"Battery {percent}%, {48.2 - t * 0.002:.1f}V"))
    return sorted(events)


def diagnostic_status(level: int, name: str, message: str, hardware_id: str, values: dict[str, str]) -> SimpleNamespace:
    # Not a dict: the CDR writer reads fields with getattr first, so a dict's
    # .values method would shadow this message's `values` field.
    return SimpleNamespace(
        level=level,
        name=name,
        message=message,
        hardware_id=hardware_id,
        values=[{"key": key, "value": value} for key, value in values.items()],
    )


def lidar_status(t: float) -> SimpleNamespace:
    if t < 61.804 or t >= 72.804:
        level, message, crc, link, rate = 0, "OK", 0, 1000, 10.0
    elif t < 64.215:
        level, message, crc, link, rate = 1, "CRC errors on eth1", 14, 100 if t >= 62.806 else 1000, 10.0
    elif t < 66.0:
        level, message, crc, link, rate = 2, "No data", 37, 100, 0.0
    else:
        level, message, crc, link, rate = 1, "Degraded scan rate", 9, 100, 3.3
    values = {"scan_rate_hz": f"{rate:.1f}", "crc_errors_per_s": str(crc), "link_speed_mbps": str(link)}
    return diagnostic_status(level, "lidar_a: driver", message, "lidar_a", values)


def diagnostics(t: float) -> dict[str, Any]:
    healthy = [
        ("imu: driver", "imu_0", {"rate_hz": "20.0", "temperature_c": "41.5"}),
        ("battery", "bms_0", {"percent": str(78 - int(t / 30)), "cell_delta_mv": "12"}),
    ]
    statuses = [lidar_status(t)]
    statuses += [diagnostic_status(0, name, "OK", hardware_id, values) for name, hardware_id, values in healthy]
    return {"header": header(t, ""), "status": statuses}


def laser_scan(t: float, rng: random.Random) -> dict[str, Any]:
    beams = 90
    ranges = [round(3.0 + 2.0 * math.sin(i * 0.2 + t * 0.1) + rng.random() * 0.02, 3) for i in range(beams)]
    return {
        "header": header(t, "laser_link"),
        "angle_min": -math.pi,
        "angle_max": math.pi,
        "angle_increment": 2 * math.pi / beams,
        "time_increment": 0.0,
        "scan_time": 0.1,
        "range_min": 0.1,
        "range_max": 30.0,
        "ranges": ranges,
        "intensities": [],
    }


def vector(x: float = 0.0, y: float = 0.0, z: float = 0.0) -> dict[str, float]:
    return {"x": x, "y": y, "z": z}


IDENTITY = {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0}


def odometry(t: float) -> dict[str, Any]:
    return {
        "header": header(t, "odom"),
        "child_frame_id": "base_link",
        "pose": {
            "pose": {"position": vector(robot_x(t)), "orientation": IDENTITY},
            "covariance": [0.0] * 36,
        },
        "twist": {
            "twist": {"linear": vector(commanded_speed(t)), "angular": vector()},
            "covariance": [0.0] * 36,
        },
    }


def transforms(t: float) -> dict[str, Any]:
    def transform(parent: str, child: str, x: float) -> dict[str, Any]:
        return {
            "header": header(t, parent),
            "child_frame_id": child,
            "transform": {"translation": vector(x), "rotation": IDENTITY},
        }

    return {
        "transforms": [
            transform("odom", "base_link", robot_x(t)),
            transform("base_link", "laser_link", 0.2),
            transform("base_link", "imu_link", 0.0),
        ]
    }


def main() -> None:
    rng = random.Random(20260314)
    stream: list[tuple[float, str, str, dict[str, Any]]] = []

    for t, level, name, text in rosout_events(rng):
        message = {"stamp": stamp(t), "level": level, "name": name, "msg": text, "file": "", "function": "", "line": 0}
        stream.append((t, "/rosout", "rcl_interfaces/msg/Log", message))
    for t in periodic(1.0):
        stream.append((t, "/diagnostics", "diagnostic_msgs/msg/DiagnosticArray", diagnostics(t)))
    for t in scan_times():
        stream.append((t, "/scan", "sensor_msgs/msg/LaserScan", laser_scan(t, rng)))
    for t in periodic(20.0):
        stream.append((t, "/odom", "nav_msgs/msg/Odometry", odometry(t)))
    for t in periodic(10.0):
        stream.append((t, "/cmd_vel", "geometry_msgs/msg/Twist", {"linear": vector(commanded_speed(t)), "angular": vector()}))
    for t in periodic(10.0):
        stream.append((t, "/tf", "tf2_msgs/msg/TFMessage", transforms(t)))
    goal = {"header": header(GOAL_START_S, "map"), "pose": {"position": vector(24.3, -8.1), "orientation": IDENTITY}}
    stream.append((GOAL_START_S, "/goal_pose", "geometry_msgs/msg/PoseStamped", goal))

    with OUTPUT.open("wb") as output:
        writer = Writer(output, compression=CompressionType.ZSTD)
        schemas = {name: writer.register_msgdef(name, text) for name, text in MSGDEFS.items()}
        ordered = heapq.nsmallest(len(stream), enumerate(stream), key=lambda item: (item[1][0], item[0]))
        for sequence, (_, (t, topic, datatype, message)) in enumerate(ordered):
            log_time = START_NS + int(t * 1e9)
            writer.write_message(
                topic=topic,
                schema=schemas[datatype],
                message=message,
                log_time=log_time,
                publish_time=log_time,
                sequence=sequence,
            )
        writer.finish()

    print(f"Wrote {OUTPUT} ({OUTPUT.stat().st_size / 1024:.0f} KB, {len(stream)} messages)")


if __name__ == "__main__":
    main()
