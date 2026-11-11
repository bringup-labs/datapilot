"""Bags that can't be read, and the backend's handling of parser-service errors (#86).

A corrupt bag must fail ingestion rather than become a "ready", empty
session. The backend falls back to its inline parser only when the parser
service couldn't do the work, never when the service parsed the bag and found
it broken.
"""
import sys
from pathlib import Path

import httpx
import pytest
from rosbags.rosbag2 import Reader, Writer
from rosbags.typesys import Stores, get_typestore

from app.services.parser import BagParseError, ingestion_parser

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from mcap_parser.parser import parse_bag as parser_service_parse  # noqa: E402

START_NS = 1_773_480_413_000_000_000


@pytest.fixture
def logs_db3(tmp_path: Path) -> Path:
    """A real rosbag2 bag holding two /rosout messages, one second apart."""
    typestore = get_typestore(Stores.ROS2_HUMBLE)
    Log = typestore.types["rcl_interfaces/msg/Log"]
    Time = typestore.types["builtin_interfaces/msg/Time"]
    bag_dir = tmp_path / "robot_run"
    with Writer(bag_dir, version=8) as writer:
        rosout = writer.add_connection("/rosout", Log.__msgtype__, typestore=typestore)
        for offset_s, text in enumerate(["Received new goal", "Sensor dropout: no data for 782ms"]):
            message = Log(
                stamp=Time(sec=START_NS // 10**9 + offset_s, nanosec=0),
                level=20, name="/robot", msg=text, file="", function="", line=0,
            )
            writer.write(
                rosout, START_NS + offset_s * 10**9, typestore.serialize_cdr(message, Log.__msgtype__)
            )
    return next(bag_dir.glob("*.db3"))


@pytest.fixture
def unreadable_db3(tmp_path: Path) -> Path:
    bag = tmp_path / "corrupt" / "corrupt.db3"
    bag.parent.mkdir()
    bag.write_bytes(b"this is not a SQLite database")
    return bag


@pytest.fixture(
    params=[ingestion_parser._parse_db3, parser_service_parse],
    ids=["backend-inline-parser", "mcap-parser-service"],
)
def parse(request):
    return request.param


def test_a_bag_that_cannot_be_read_raises_instead_of_parsing_as_empty(unreadable_db3: Path, parse) -> None:
    # The parser service used to catch the reader's error and return ok:true
    # with no logs, so a corrupt bag became a "ready", empty session.
    with pytest.raises(Exception):
        parse(str(unreadable_db3))


def test_parser_service_keeps_what_it_read_before_the_reader_failed(logs_db3: Path, monkeypatch) -> None:
    real_messages = Reader.messages

    def first_message_then_fail(self, *args, **kwargs):
        messages = real_messages(self, *args, **kwargs)
        yield next(messages)
        raise OSError("disk read error")

    monkeypatch.setattr(Reader, "messages", first_message_then_fail)

    result = parser_service_parse(str(logs_db3))

    assert result["ok"] is True
    assert [log["text"] for log in result["logs"]] == ["Received new goal"]
    assert any("disk read error" in w for w in result["parse_warnings"])


def _parser_service_replies(monkeypatch, status: int, body) -> None:
    """Answer the backend's POST /parse with `status` and `body`, without a network."""
    transport = httpx.MockTransport(lambda request: httpx.Response(status, json=body))
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda **kwargs: real_client(transport=transport, **kwargs)
    )


async def test_a_parse_error_from_the_service_fails_without_falling_back(logs_db3: Path, monkeypatch) -> None:
    # The service read the bag and couldn't parse it, so parsing it again
    # inline would only repeat the failure. The error reaches run_ingestion,
    # which marks the session as failed.
    _parser_service_replies(monkeypatch, 422, {
        "ok": False,
        "error": {"code": "parse_error", "message": "DB3 reader failed: corrupt", "retryable": False},
    })

    with pytest.raises(BagParseError, match="DB3 reader failed: corrupt"):
        await ingestion_parser.parse_bag(str(logs_db3))


@pytest.mark.parametrize(
    "status, body",
    [
        (400, {"ok": False, "error": {"code": "invalid_path", "message": "invalid bag path", "retryable": False}}),
        (200, {"ok": False, "error": "a parser service from before the typed envelope"}),
        (500, {"detail": "Internal Server Error"}),
    ],
    ids=["invalid-path", "untyped-error", "server-error"],
)
async def test_other_service_errors_fall_back_to_the_inline_parser(logs_db3: Path, monkeypatch, status, body) -> None:
    _parser_service_replies(monkeypatch, status, body)

    result = await ingestion_parser.parse_bag(str(logs_db3))

    assert [log["text"] for log in result["logs"]] == [
        "Received new goal",
        "Sensor dropout: no data for 782ms",
    ]
