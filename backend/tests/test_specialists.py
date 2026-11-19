"""Each specialist returns its structured output schema against the mock LLM."""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from app.agent.mcp_client import llm_tool_defs
from app.agent.specialists.base import SpecialistKind
from app.agent.specialists.defaults import SPECIALIST_REGISTRY
from app.agent.specialists.performance import PerformanceProfilerSpecialist
from app.agent.specialists.replay_narrator import ReplayNarratorSpecialist
from tests.fixtures.mock_llm import MockRouter


@pytest.mark.parametrize("name", list(SPECIALIST_REGISTRY.keys()))
def test_specialist_runs_and_returns_findings_shape(name):
    specialist = SPECIALIST_REGISTRY[name]
    router = MockRouter()
    result, audit = asyncio.run(specialist.run(
        router=router,
        session_id="s1",
        intent="investigate",
        session_summary="filename=lidar_failure.mcap",
    ))
    # Every specialist must return findings + confidence keys.
    assert "findings" in result
    assert "confidence" in result
    assert isinstance(result["confidence"], (int, float))
    assert 0.0 <= result["confidence"] <= 1.0
    # Audit trail recorded the specialist_start event.
    assert audit[0]["step_kind"] == "specialist_start"
    assert audit[0]["specialist"] == name


def test_rca_returns_causal_chain():
    specialist = SPECIALIST_REGISTRY["RootCauseAnalyst"]
    router = MockRouter()
    result, _ = asyncio.run(specialist.run(
        router=router,
        session_id="s1",
        intent="trace failure",
        session_summary="",
    ))
    assert "causal" in result
    assert len(result["causal"]) >= 2
    # Causal steps reference real log_ids.
    assert all("log_id" in step for step in result["causal"])


# ── query_mcap grounding: Performance & Replay are FULL with raw-bag access ──

@pytest.mark.parametrize(
    "specialist",
    [PerformanceProfilerSpecialist(), ReplayNarratorSpecialist()],
    ids=["performance", "replay"],
)
def test_metric_specialists_are_full_with_query_mcap(specialist):
    """Both must run the ReAct tool loop and expose query_mcap to the LLM."""
    assert specialist.kind is SpecialistKind.FULL
    names = {d["name"] for d in llm_tool_defs(worker_subset=specialist.worker_subset)}
    assert "rosbag_reader__query_mcap" in names


class _ScriptedToolLLM:
    """Mock LLM that calls query_mcap on turn 0, then returns final JSON on turn 1."""

    provider = "mock"
    model_id = "scripted-1"

    def __init__(self, final: dict[str, Any]):
        self._final = final
        self._turn = 0

    async def complete(self, *, system, messages, tools=None, response_format=None,
                       temperature=0.2, max_tokens=4096, stream=False):
        self._turn += 1
        if self._turn == 1:
            return {
                "content": None,
                "tool_calls": [{
                    "id": "tc_1",
                    "name": "rosbag_reader__query_mcap",
                    "arguments": {"sql": "SELECT topic, count FROM mcap_topics('{mcap_path}')"},
                }],
                "usage": {"input_tokens": 100, "output_tokens": 20},
                "finish_reason": "tool_calls",
            }
        return {
            "content": json.dumps(self._final),
            "tool_calls": [],
            "usage": {"input_tokens": 100, "output_tokens": 20},
            "finish_reason": "stop",
        }


class _SingleClientRouter:
    def __init__(self, client):
        self._client = client

    def for_specialist(self, _name):
        return self._client

    def for_supervisor(self):
        return self._client

    def for_composer(self, _model_id=None):
        return self._client


def test_performance_react_loop_dispatches_query_mcap():
    """The FULL loop wires session_id → dispatch → query_mcap and records the result."""
    client = _ScriptedToolLLM({"regressions": [], "findings": [], "confidence": 0.5})
    router = _SingleClientRouter(client)
    result, audit = asyncio.run(PerformanceProfilerSpecialist().run(
        router=router,
        session_id="s1",
        intent="how many frames on /camera/image_raw",
        session_summary="filename=lidar_failure.mcap",
    ))
    # Final structured output parsed from turn 1.
    assert "findings" in result and "confidence" in result
    # The audit trail proves query_mcap was actually dispatched with session_id injected.
    tool_results = [e for e in audit if e["step_kind"] == "tool_result"]
    assert any(e["tool"] == "rosbag_reader__query_mcap" for e in tool_results)
    assert any('"session_id": "s1"' in e["args_summary"] for e in tool_results)


class _NeverStopsCallingTools:
    """Asks for a tool on every turn that offers tools; answers only without them."""

    provider = "mock"
    model_id = "loops-1"

    def __init__(self, final: dict[str, Any]):
        self._final = final
        self.calls_with_tools = 0
        self.calls_without_tools = 0

    async def complete(self, *, system, messages, tools=None, **_kwargs):
        if tools:
            self.calls_with_tools += 1
            return {
                "content": None,
                "tool_calls": [{"id": f"tc_{self.calls_with_tools}", "name": "rosbag_reader__retrieve_logs",
                                "arguments": {"query": "x"}}],
                "usage": {"input_tokens": 10, "output_tokens": 2},
                "finish_reason": "tool_calls",
            }
        self.calls_without_tools += 1
        return {
            "content": json.dumps(self._final),
            "tool_calls": [],
            "usage": {"input_tokens": 10, "output_tokens": 2},
            "finish_reason": "stop",
        }


def test_react_loop_asks_for_a_final_answer_when_it_runs_out_of_iterations(monkeypatch):
    """#57: a tool call on the last iteration used to discard the whole run."""
    from app.agent.specialists import base as base_mod

    monkeypatch.setenv("DATAPILOT_MCP_TRANSPORT", "in_process")
    final = {"regressions": [], "findings": [{"sev": "info", "text": "ok", "log_ids": []}], "confidence": 0.7}
    client = _NeverStopsCallingTools(final)

    result, _audit = asyncio.run(PerformanceProfilerSpecialist().run(
        router=_SingleClientRouter(client), session_id="s1", intent="x", session_summary="",
    ))

    assert client.calls_with_tools == base_mod.INTERNAL_MAX_ITERS
    assert client.calls_without_tools == 1
    assert result.get("error") != "empty_response"
    assert result["confidence"] == 0.7


def test_react_loop_flags_log_ids_no_tool_returned(monkeypatch):
    """#57: cited log_ids are checked against what the tools returned this run."""
    from app.agent import mcp_client

    monkeypatch.setenv("DATAPILOT_MCP_TRANSPORT", "in_process")
    monkeypatch.setitem(
        mcp_client._REGISTRY[("rosbag_reader", "query_mcap")], "run",
        lambda _args: {"ok": True, "result": [{"id": "l_1", "msg": "seen"}]},
    )
    final = {
        "regressions": [],
        "findings": [{"sev": "warning", "text": "x", "log_ids": ["l_1", "l_404"]}],
        "confidence": 0.8,
    }

    result, audit = asyncio.run(PerformanceProfilerSpecialist().run(
        router=_SingleClientRouter(_ScriptedToolLLM(final)), session_id="s1", intent="x", session_summary="",
    ))

    flagged = [e for e in audit if "not returned by any tool" in e.get("result_summary", "")]
    assert len(flagged) == 1
    assert "l_404" in flagged[0]["result_summary"] and "l_1," not in flagged[0]["result_summary"]
    # Flagged, not removed: the composer still decides what is grounded.
    assert result["findings"][0]["log_ids"] == ["l_1", "l_404"]
