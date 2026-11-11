"""The parser service's POST /parse error contract (#86).

Errors use the typed envelope, {code, message, retryable}, with a non-2xx
status, so callers can tell a failure from a parsed bag without reading the
body.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from mcap_parser.app import app  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def no_bag_root(monkeypatch):
    monkeypatch.delenv("DATAPILOT_BAG_ROOT", raising=False)


def test_a_path_that_is_not_a_bag_is_a_400(tmp_path: Path) -> None:
    resp = client.post("/parse", json={"filepath": str(tmp_path / "missing.mcap")})

    assert resp.status_code == 400
    assert resp.json() == {
        "ok": False,
        "error": {"code": "invalid_path", "message": "invalid bag path", "retryable": False},
    }


def test_a_bag_that_cannot_be_parsed_is_a_422(tmp_path: Path) -> None:
    bag = tmp_path / "corrupt.mcap"
    bag.write_bytes(b"this is not an MCAP file")

    resp = client.post("/parse", json={"filepath": str(bag)})

    assert resp.status_code == 422
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]["code"] == "parse_error"
    assert body["error"]["retryable"] is False
    assert body["error"]["message"]
