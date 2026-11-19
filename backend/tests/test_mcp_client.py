"""MCP-shaped dispatcher contract tests."""
from __future__ import annotations

from app.agent.mcp_client import dispatch, get_tool, list_tools, llm_tool_defs, parse_tool_name


def test_unknown_tool_returns_tool_unavailable():
    out = dispatch("nope", "alsonope", {})
    assert out["ok"] is False
    assert out["error"]["code"] == "tool_unavailable"
    assert out["error"]["retryable"] is False


def test_real_tool_returns_ok_empty_when_no_data(mock_neo4j):
    # Real tool — mock_neo4j returns [] from run_query, so result is empty but ok.
    out = dispatch("anomaly_detector", "find_statistical_outliers", {"session_id": "X", "topic": "/sensor"})
    assert out["ok"] is True
    assert out["result"] == []


def test_list_tools_includes_retrieve_logs():
    names = {(d["worker"], d["name"]) for d in list_tools()}
    assert ("rosbag_reader", "retrieve_logs") in names
    assert ("planner_failure_inspector", "query_causal_chain") in names


def test_get_tool_returns_descriptor():
    desc = get_tool("rosbag_reader", "retrieve_logs")
    assert desc is not None
    assert "session_id" in desc["input_schema"]["properties"]


def test_llm_tool_defs_uses_double_underscore_qualified_name():
    defs = llm_tool_defs(worker_subset=["rosbag_reader"])
    assert any(d["name"] == "rosbag_reader__retrieve_logs" for d in defs)
    # Reverse-parse round-trips.
    worker, name = parse_tool_name("rosbag_reader__retrieve_logs")
    assert worker == "rosbag_reader"
    assert name == "retrieve_logs"


def test_dispatch_returns_tool_timeout_when_a_tool_overruns(monkeypatch):
    """#58: a slow tool is cut off with a retryable error instead of running on."""
    import threading
    import time

    from app.agent import mcp_client
    from app.config import settings

    release = threading.Event()

    def _slow(_args):
        release.wait(5)
        return {"ok": True, "result": []}

    monkeypatch.setenv("DATAPILOT_MCP_TRANSPORT", "in_process")
    monkeypatch.setattr(settings, "tool_timeout_s", 0.05)
    monkeypatch.setitem(mcp_client._REGISTRY[("rosbag_reader", "retrieve_logs")], "run", _slow)

    started = time.perf_counter()
    try:
        out = dispatch("rosbag_reader", "retrieve_logs", {"session_id": "s1"})
    finally:
        release.set()

    assert time.perf_counter() - started < 2
    assert out["ok"] is False
    assert out["error"]["code"] == "tool_timeout"
    assert out["error"]["retryable"] is True
