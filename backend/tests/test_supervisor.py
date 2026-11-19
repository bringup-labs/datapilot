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
