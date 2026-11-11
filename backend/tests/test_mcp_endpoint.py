import json
import os
import time

import pytest
from fastapi.testclient import TestClient

import app.api.mcp_endpoint as mcp_endpoint
from app.api.mcp_endpoint import SINGLE_BAG_TOOLS
from app.agent.turn_store import turn_store
from app.config import settings
from app.main import app

TOKEN = "a" * 64
EXCLUDED = {"query_graph", "query_mcap", "find_rate_regressions", "compare_metric_distributions", "compare_log_signatures"}


def write_secrets(path, data):
    path.write_text(json.dumps(data))
    t = time.time_ns() + 1_000_000_000  # force a new mtime even within one clock tick
    os.utime(path, ns=(t, t))


@pytest.fixture
def mcp_client(tmp_path, monkeypatch, db_session_factory):
    monkeypatch.setattr(mcp_endpoint, "AsyncSessionLocal", db_session_factory)
    write_secrets(tmp_path / "backend-keys.json", {"mcp_token": TOKEN})
    monkeypatch.setattr(settings, "datapilot_secrets_file", str(tmp_path / "backend-keys.json"))
    for field in ("anthropic_api_key", "openai_api_key", "gemini_api_key", "nvidia_api_key"):
        monkeypatch.setattr(settings, field, getattr(settings, field))  # undo the lifespan's secrets sweep afterwards
    with TestClient(app, base_url="http://localhost:8000") as client:  # runs the lifespan; Host passes the check
        yield client


def rpc(client, method, params=None, *, token=TOKEN, session="sess-1", turn=None, host=None, origin=None):
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    for name, value in (("Authorization", token and f"Bearer {token}"), ("X-DataPilot-Session", session),
                        ("X-DataPilot-Turn", turn), ("Host", host), ("Origin", origin)):
        if value:
            headers[name] = value
    return client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})


def call(client, name, arguments, **kw):
    return rpc(client, "tools/call", {"name": name, "arguments": arguments}, **kw).json()["result"]


def payload(result):
    return json.loads(result["content"][0]["text"])


def tool_names(client):
    return {t["name"] for t in rpc(client, "tools/list").json()["result"]["tools"]}


def test_mcp_rejects_missing_or_wrong_token(mcp_client):
    assert rpc(mcp_client, "tools/list", token=None).status_code == 401
    assert rpc(mcp_client, "tools/list", token="b" * 64).status_code == 401


def test_mcp_rejects_every_token_when_none_is_configured(mcp_client, tmp_path):
    write_secrets(tmp_path / "backend-keys.json", {})
    assert rpc(mcp_client, "tools/list").status_code == 401


def test_mcp_accepts_rotated_token_without_restart(mcp_client, tmp_path):
    write_secrets(tmp_path / "backend-keys.json", {"mcp_token": "c" * 64})
    assert rpc(mcp_client, "tools/list").status_code == 401
    assert rpc(mcp_client, "tools/list", token="c" * 64).status_code == 200


def test_mcp_rereads_a_secrets_file_that_had_no_token_yet(mcp_client, tmp_path):
    # Electron main writes the file while the backend may be reading it: an
    # empty read must not stick when the full file lands within the same mtime.
    path = tmp_path / "backend-keys.json"
    t = time.time_ns() + 2_000_000_000
    path.write_text("")
    os.utime(path, ns=(t, t))
    assert rpc(mcp_client, "tools/list").status_code == 401
    path.write_text(json.dumps({"mcp_token": TOKEN}))
    os.utime(path, ns=(t, t))
    assert rpc(mcp_client, "tools/list").status_code == 200


def test_mcp_refuses_other_hosts_and_browser_origins(mcp_client):
    assert rpc(mcp_client, "tools/list", host="evil.example:8000").status_code == 421
    assert rpc(mcp_client, "tools/list", origin="https://evil.example").status_code == 403


def test_lists_only_single_bag_tools(mcp_client):
    assert tool_names(mcp_client) == {name for _, name in SINGLE_BAG_TOOLS} | {"get_bag_overview", "submit_findings"}
    assert len(SINGLE_BAG_TOOLS) == 15 and EXCLUDED.isdisjoint(tool_names(mcp_client))


def test_advertised_schemas_hide_session_id(mcp_client):
    for tool in rpc(mcp_client, "tools/list").json()["result"]["tools"]:
        assert "session_id" not in tool["inputSchema"].get("properties", {})
        assert "session_id" not in tool["inputSchema"].get("required", [])


@pytest.fixture
def dispatched(monkeypatch):
    calls = []

    def fake_dispatch(worker, name, args):
        calls.append((worker, name, args))
        return {"ok": True, "result": {"aborts": []}}

    monkeypatch.setattr(mcp_endpoint, "dispatch", fake_dispatch)
    return calls


def test_session_comes_only_from_header(mcp_client, dispatched):
    result = call(mcp_client, "find_aborts", {"session_id": "other-bag"}, session="sess-1")
    assert result["isError"] is False
    assert dispatched == [("planner_failure_inspector", "find_aborts", {"session_id": "sess-1"})]


def test_call_without_session_header_is_an_error(mcp_client, dispatched):
    result = call(mcp_client, "find_aborts", {}, session=None)
    assert result["isError"] is True and payload(result)["error"]["code"] == "missing_session" and dispatched == []


def test_invalid_arguments_are_rejected_before_dispatch(mcp_client, dispatched):
    result = call(mcp_client, "find_aborts", {"bogus": 1})
    assert result["isError"] is True and payload(result)["error"]["code"] == "invalid_arguments" and dispatched == []


def test_tool_failure_is_an_error_result(mcp_client, monkeypatch):
    monkeypatch.setattr(mcp_endpoint, "dispatch", lambda w, n, a: {"ok": False, "error": {"code": "tool_exception", "message": "boom", "retryable": True}})
    result = call(mcp_client, "find_aborts", {})
    assert result["isError"] is True and payload(result)["error"]["code"] == "tool_exception"


def test_excluded_tools_cannot_be_called(mcp_client, dispatched):
    assert call(mcp_client, "query_graph", {"cypher": "MATCH (n) RETURN n"})["isError"] is True and dispatched == []


def test_read_mcp_token_handles_missing_file_and_key(tmp_path):
    from app.auth import read_mcp_token
    assert read_mcp_token(None) is None and read_mcp_token(str(tmp_path / "nope.json")) is None
    write_secrets(tmp_path / "k.json", {"anthropic": "sk"})
    assert read_mcp_token(str(tmp_path / "k.json")) is None


def test_mcp_is_exempt_from_api_token_but_keeps_its_own_check(mcp_client, monkeypatch):
    monkeypatch.setenv("DATAPILOT_API_TOKEN", "d" * 64)  # differs from the mcp token
    assert rpc(mcp_client, "tools/list").status_code == 200
    assert rpc(mcp_client, "tools/list", token=None).status_code == 401


def test_get_bag_overview_returns_the_session_facts(mcp_client, seed_session):
    seed_session("sess-1", robot_name="tb3", duration_seconds=42.5, total_messages=1200,
                 topics_json=json.dumps([{"name": "/scan", "type": "sensor_msgs/msg/LaserScan", "hz": 10, "msgs": 420}]))
    assert payload(call(mcp_client, "get_bag_overview", {})) == {"ok": True, "result": {
        "filename": "lidar_failure.mcap", "robot": "tb3", "duration_s": 42.5, "total_messages": 1200,
        "topics": [{"name": "/scan", "type": "sensor_msgs/msg/LaserScan"}]}}

def test_get_bag_overview_needs_a_ready_bag(mcp_client, seed_session):
    seed_session("sess-1", status="processing")
    assert payload(call(mcp_client, "get_bag_overview", {}))["error"]["code"] == "no_bag"

def test_submit_findings_stores_what_it_accepts_for_the_turn(mcp_client, existing_logs):
    existing_logs(["sess-1:l_5"]); tid = turn_store.create("sess-1")
    good = {"sev": "critical", "text": "Planner aborted", "log_ids": ["sess-1:l_5"]}
    bad = {"sev": "warning", "text": "Made up", "log_ids": ["sess-1:l_404"]}
    body = payload(call(mcp_client, "submit_findings", {"findings": [good, bad]}, turn=tid))["result"]
    assert [a["index"] for a in body["accepted"]] == [0] and [r["index"] for r in body["rejected"]] == [1]
    assert turn_store.pop("sess-1", tid).findings == [good]

def test_submit_findings_needs_an_open_turn(mcp_client):
    for turn in (None, "no-such-turn"):
        result = call(mcp_client, "submit_findings", {"findings": []}, turn=turn)
        assert result["isError"] is True and payload(result)["error"]["code"] == "no_active_turn"
