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


def test_react_loop_runs_tools_off_the_event_loop(monkeypatch):
    """#46: a tool's blocking Cypher must not run on the event-loop thread."""
    import threading

    from app.agent import mcp_client

    seen: list[int] = []

    def _run(_args):
        seen.append(threading.get_ident())
        return {"ok": True, "result": {"rows": []}}

    monkeypatch.setenv("DATAPILOT_MCP_TRANSPORT", "in_process")
    monkeypatch.setitem(mcp_client._REGISTRY[("rosbag_reader", "query_mcap")], "run", _run)
    client = _ScriptedToolLLM({"regressions": [], "findings": [], "confidence": 0.5})

    async def _go() -> int:
        await PerformanceProfilerSpecialist().run(
            router=_SingleClientRouter(client),
            session_id="s1",
            intent="count frames",
            session_summary="",
        )
        return threading.get_ident()

    loop_thread = asyncio.run(_go())
    assert seen and loop_thread not in seen


class _OutOfSubsetLLM(_ScriptedToolLLM):
    """Calls a tool that exists but belongs to a worker this specialist may not use."""

    def __init__(self, final, tool_name):
        super().__init__(final)
        self._tool_name = tool_name

    async def complete(self, **kwargs):
        resp = await super().complete(**kwargs)
        if resp["tool_calls"]:
            resp["tool_calls"][0]["name"] = self._tool_name
            resp["tool_calls"][0]["arguments"] = {}
        return resp


@pytest.mark.parametrize("tool_name", [
    "planner_failure_inspector__query_causal_chain",  # real tool, wrong worker
    "retrieve_logs",                                  # not worker-qualified
])
def test_react_loop_refuses_tools_outside_the_specialists_workers(monkeypatch, tool_name):
    """#58: worker_subset limits what is dispatched, not only what the LLM is told."""
    from app.agent import mcp_client

    dispatched: list[tuple[str, str]] = []

    def _record(worker, name, args):
        dispatched.append((worker, name))
        return {"ok": True, "result": []}

    # The specialist calls `dispatch_async`, which runs `mcp_client.dispatch`.
    monkeypatch.setattr(mcp_client, "dispatch", _record)

    specialist = PerformanceProfilerSpecialist()
    assert "planner_failure_inspector" not in specialist.worker_subset
    client = _OutOfSubsetLLM({"regressions": [], "findings": [], "confidence": 0.5}, tool_name)
    result, audit = asyncio.run(specialist.run(
        router=_SingleClientRouter(client), session_id="s1", intent="x", session_summary="",
    ))

    assert dispatched == []
    refused = [e for e in audit if e["step_kind"] == "tool_result"]
    assert len(refused) == 1 and "tool_unavailable" in refused[0]["result_summary"]
    # The loop carries on to the model's final answer.
    assert result["confidence"] == 0.5
