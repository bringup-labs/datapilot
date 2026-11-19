"""Supervisor planning against a mocked LLM."""
from __future__ import annotations

import asyncio

from app.agent.state import GraphState
from app.agent.supervisor import supervisor_node
from tests.fixtures.mock_llm import MockRouter


def test_supervisor_produces_valid_plan():
    state = GraphState(
        session_id="s1",
        user_message="Why did navigation abort?",
        transcript=[],
        plan=[],
        plan_idx=0,
        specialist_outputs={},
        retrieval_context=[],
        replan_count=0,
        audit_trail=[],
        token_budget_remaining=25_000,
        final=None,
        session_summary="filename=lidar_failure.mcap, robot=ARES-04",
    )
    router = MockRouter()

    patch = asyncio.run(supervisor_node(state, router=router))

    plan = patch["plan"]
    assert len(plan) >= 1
    assert all(s["specialist"] in {
        "RootCauseAnalyst", "AnomalyDetector", "PerformanceProfiler",
        "ReplayNarrator", "SafetyAuditor", "ReleaseComparator",
    } for s in plan)
    assert patch["plan_idx"] == 0
    assert patch["audit_trail"][0]["step_kind"] == "supervisor_plan"


def test_supervisor_falls_back_when_llm_returns_garbage():
    state = GraphState(
        session_id="s1",
        user_message="Why did navigation fail?",
        transcript=[],
        plan=[],
        plan_idx=0,
        specialist_outputs={},
        retrieval_context=[],
        replan_count=0,
        audit_trail=[],
        token_budget_remaining=25_000,
        final=None,
        session_summary="",
    )
    # Override the supervisor's "plan" with text that won't parse — the supervisor
    # must fall back to a sane default.
    from tests.fixtures.mock_llm import MockLLMClient, MockRouter
    bad_client = MockLLMClient(overrides={"supervisor": {"_text": "not json at all"}})
    router = MockRouter(client=bad_client)

    patch = asyncio.run(supervisor_node(state, router=router))
    plan = patch["plan"]
    assert len(plan) == 1
    # "why" question routes to RCA in the fallback.
    assert plan[0]["specialist"] == "RootCauseAnalyst"


class _SlowClient:
    """A supervisor model that takes longer than the plan deadline."""

    provider = "mock"
    model_id = "slow-1"

    def __init__(self, delay_s: float):
        self._delay_s = delay_s

    async def complete(self, **_kwargs):
        await asyncio.sleep(self._delay_s)
        return {
            "content": '{"plan": [{"idx": 0, "specialist": "SafetyAuditor", "intent": "audit"}]}',
            "tool_calls": [],
            "usage": {"input_tokens": 7, "output_tokens": 3},
            "finish_reason": "stop",
        }


def _why_state() -> GraphState:
    return GraphState(
        session_id="s1",
        user_message="Why did navigation fail?",
        transcript=[],
        plan=[],
        plan_idx=0,
        specialist_outputs={},
        retrieval_context=[],
        replan_count=0,
        audit_trail=[],
        token_budget_remaining=25_000,
        final=None,
        session_summary="",
    )


def test_supervisor_falls_back_to_the_heuristic_plan_when_the_model_hangs(monkeypatch):
    """#55: a supervisor model that never answers must not stall the turn."""
    from app.config import settings
    from tests.fixtures.mock_llm import MockRouter

    monkeypatch.setattr(settings, "supervisor_plan_timeout_s", 0.05)
    router = MockRouter(client=_SlowClient(delay_s=5))

    patch = asyncio.run(asyncio.wait_for(supervisor_node(_why_state(), router=router), timeout=2))

    assert [s["specialist"] for s in patch["plan"]] == ["RootCauseAnalyst"]
    assert "timed out" in patch["audit_trail"][0]["result_summary"]


def test_heuristic_plan_picks_a_specialist_from_the_question():
    from app.agent.supervisor import heuristic_plan

    assert heuristic_plan("Why did it stop?")[0]["specialist"] == "RootCauseAnalyst"
    assert heuristic_plan("Anything odd in this bag?")[0]["specialist"] == "AnomalyDetector"


def test_supervisor_audits_dropped_steps_and_keeps_idx_contiguous():
    """#57: an invalid specialist must not vanish from the plan without a trace."""
    from tests.fixtures.mock_llm import MockLLMClient, MockRouter

    client = MockLLMClient(overrides={"supervisor": {"plan": [
        {"idx": 0, "specialist": "MadeUpSpecialist", "intent": "x"},
        {"idx": 1, "specialist": "RootCauseAnalyst", "intent": "trace"},
        "not a step",
        {"idx": 3, "specialist": "AnomalyDetector", "intent": "confirm"},
    ]}})
    state = GraphState(
        session_id="s1", user_message="Why?", transcript=[], plan=[], plan_idx=0,
        specialist_outputs={}, retrieval_context=[], replan_count=0, audit_trail=[],
        token_budget_remaining=25_000, final=None, session_summary="",
    )

    patch = asyncio.run(supervisor_node(state, router=MockRouter(client=client)))

    assert [(s["idx"], s["specialist"]) for s in patch["plan"]] == [
        (0, "RootCauseAnalyst"), (1, "AnomalyDetector"),
    ]
    summary = patch["audit_trail"][0]["result_summary"]
    assert "dropped 2" in summary and "MadeUpSpecialist" in summary
