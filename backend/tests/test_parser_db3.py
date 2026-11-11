"""Both .db3 parsers, run against a real rosbag2 bag written to disk.

The older tests in test_parser_unit.py stub out rosbags. That hid the fact that
rosbags 0.11 removed the function the parsers imported, so no .db3 bag could be
read at all. These tests use the library for real.
"""
import sys
from pathlib import Path

import pytest
from rosbags.rosbag2 import Writer
from rosbags.typesys import Stores, get_typestore

from app.services.parser import ingestion_parser

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from mcap_parser.parser import parse_bag as parser_service_parse  # noqa: E402

START_NS = 1_773_480_413_000_000_000


@pytest.fixture
def db3_bag(tmp_path: Path) -> Path:
    typestore = get_typestore(Stores.ROS2_HUMBLE)
    Time = typestore.types["builtin_interfaces/msg/Time"]
    Header = typestore.types["std_msgs/msg/Header"]
    Log = typestore.types["rcl_interfaces/msg/Log"]
    DiagnosticArray = typestore.types["diagnostic_msgs/msg/DiagnosticArray"]
    DiagnosticStatus = typestore.types["diagnostic_msgs/msg/DiagnosticStatus"]
    KeyValue = typestore.types["diagnostic_msgs/msg/KeyValue"]
    String = typestore.types["std_msgs/msg/String"]

    stamp = Time(sec=START_NS // 10**9, nanosec=0)
    bag_dir = tmp_path / "robot_run"
    with Writer(bag_dir, version=8) as writer:
        rosout = writer.add_connection("/rosout", Log.__msgtype__, typestore=typestore)
        diagnostics = writer.add_connection(
            "/diagnostics", DiagnosticArray.__msgtype__, typestore=typestore
        )
        chatter = writer.add_connection("/chatter", String.__msgtype__, typestore=typestore)

        def log(offset_s: int, level: int, name: str, text: str) -> None:
            message = Log(
                stamp=stamp, level=level, name=name, msg=text, file="", function="", line=0
            )
            writer.write(
                rosout,
                START_NS + offset_s * 10**9,
                typestore.serialize_cdr(message, Log.__msgtype__),
            )

        log(0, 20, "/move_base", "Received new goal")
        log(2, 40, "/sensors", "Sensor dropout: no data for 782ms")

        status = DiagnosticStatus(
            level=b"\x02"[0],
            name="lidar_a: driver",
            message="No data",
            hardware_id="lidar_a",
            values=[KeyValue(key="scan_rate_hz", value="0.0")],
        )
        array = DiagnosticArray(header=Header(stamp=stamp, frame_id=""), status=[status])
        writer.write(
            diagnostics,
            START_NS + 3 * 10**9,
            typestore.serialize_cdr(array, DiagnosticArray.__msgtype__),
        )
        writer.write(
            chatter,
            START_NS + 4 * 10**9,
            typestore.serialize_cdr(String(data="hello"), String.__msgtype__),
        )
    return next(bag_dir.glob("*.db3"))


@pytest.fixture(
    params=[ingestion_parser._parse_db3, parser_service_parse],
    ids=["backend-inline-parser", "mcap-parser-service"],
)
def parse(request):
    return request.param


def test_reads_log_messages_from_a_real_bag(db3_bag: Path, parse) -> None:
    logs = parse(str(db3_bag))["logs"]

    assert [(log["node"], log["sev"]) for log in logs] == [
        ("/move_base", "INFO"),
        ("/sensors", "ERROR"),
    ]
    assert logs[1]["text"] == "Sensor dropout: no data for 782ms"


def test_reads_diagnostics_from_a_real_bag(db3_bag: Path, parse) -> None:
    [diagnostic] = parse(str(db3_bag))["diagnostics"]

    assert diagnostic["name"] == "lidar_a: driver"
    assert diagnostic["level"] == "ERROR"
    assert diagnostic["values"] == {"scan_rate_hz": "0.0"}


def test_counts_messages_on_every_topic_including_undecoded_ones(db3_bag: Path, parse) -> None:
    result = parse(str(db3_bag))

    counts = {topic["name"]: topic["msgs"] for topic in result["topics"]}
    assert counts == {"/rosout": 2, "/diagnostics": 1, "/chatter": 1}
    assert result["duration_seconds"] == pytest.approx(4.0)
