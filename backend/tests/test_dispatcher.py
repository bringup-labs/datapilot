"""Unit coverage for app.agent.dispatcher.

  - `dispatcher_node`: advances the plan one step, runs the specialist,
    records output + audit, skips unknown specialists.
  - `route_after_dispatch`: the conditional edge (continue / replan / compose).

Reuses MockRouter (mock LLM) and the autouse `mock_neo4j` fixture.

Issues #53/#54 (FIXED): all three boundaries now align on MAX_REPLANS (5).
`route_after_dispatch` routes to replan only while `replan_count < MAX_REPLANS`;
once the cap is reached it falls through to the composer, which then emits
`partial=True`. `replan_node` no longer has a strictly-greater-than off-by-one.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.agent.dispatcher import (
    LOW_CONFIDENCE_THRESHOLD,
    dispatcher_node,
    route_after_dispatch,
)
from app.agent.state import MAX_REPLANS, PER_TURN_TOKEN_CAP, GraphState
from tests.fixtures.mock_llm import MockRouter


def _state(**over: Any) -> GraphState:
    state: GraphState = {
        "session_id": "s1",
        "user_message": "why?",
        "session_summary": "filename=lidar_failure.mcap",
        "plan": [],
        "plan_idx": 0,
        "specialist_outputs": {},
        "replan_count": 0,
        "audit_trail": [],
    }
    state.update(over)  # type: ignore[typeddict-item]
    return state


# ── dispatcher_node ──────────────────────────────────────────────────────────


def test_dispatcher_runs_specialist_and_advances():
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "trace"}]
    out = asyncio.run(dispatcher_node(_state(plan=plan), router=MockRouter()))

    assert out["plan_idx"] == 1
    # Step marked done in place.
    assert out["plan"][0]["done"] is True
    # Specialist output captured under its name.
    assert "RootCauseAnalyst" in out["specialist_outputs"]
    result = out["specialist_outputs"]["RootCauseAnalyst"]
    assert "findings" in result
    assert "confidence" in result
    # Audit trail forwarded from the specialist.
    assert any(e["step_kind"] == "specialist_start" for e in out["audit_trail"])


def test_dispatcher_decrements_token_budget_remaining():
    # The per-turn budget field is actually updated after a step runs (issue #42).
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "trace"}]
    out = asyncio.run(dispatcher_node(_state(plan=plan), router=MockRouter()))
    assert "token_budget_remaining" in out
    assert 0 <= out["token_budget_remaining"] <= PER_TURN_TOKEN_CAP


def test_dispatcher_runs_nothing_when_plan_exhausted():
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "x"}]
    out = asyncio.run(dispatcher_node(_state(plan=plan, plan_idx=1), router=MockRouter()))
    # No step ran, so there is no fresh result for the router to judge (#57).
    assert out == {"last_result": None}


def test_dispatcher_skips_unknown_specialist():
    plan = [{"idx": 0, "specialist": "NoSuchSpecialist", "intent": "x"}]
    out = asyncio.run(dispatcher_node(_state(plan=plan), router=MockRouter()))
    # Skip path only bumps the pointer; no outputs / no plan rewrite.
    assert out == {"plan_idx": 1, "last_result": None}


def test_dispatcher_preserves_prior_outputs():
    plan = [
        {"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a", "done": True},
        {"idx": 1, "specialist": "AnomalyDetector", "intent": "b"},
    ]
    prior = {"RootCauseAnalyst": {"findings": [], "confidence": 0.9}}
    out = asyncio.run(
        dispatcher_node(_state(plan=plan, plan_idx=1, specialist_outputs=prior), router=MockRouter())
    )
    # Both the prior and the newly-run specialist are present.
    assert "RootCauseAnalyst" in out["specialist_outputs"]
    assert "AnomalyDetector" in out["specialist_outputs"]
    # Original dict not mutated (dispatcher copies it).
    assert "AnomalyDetector" not in prior


# ── route_after_dispatch: continue / compose ─────────────────────────────────


def test_route_continues_when_steps_remain():
    plan = [
        {"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"},
        {"idx": 1, "specialist": "AnomalyDetector", "intent": "b"},
    ]
    outputs = {"RootCauseAnalyst": {"confidence": 0.9}}
    assert route_after_dispatch(_state(plan=plan, plan_idx=1, specialist_outputs=outputs)) == "dispatcher"


def test_route_composes_when_plan_exhausted():
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"}]
    outputs = {"RootCauseAnalyst": {"confidence": 0.9}}
    assert route_after_dispatch(_state(plan=plan, plan_idx=1, specialist_outputs=outputs)) == "composer"


def test_route_composes_on_empty_plan():
    assert route_after_dispatch(_state(plan=[], plan_idx=0)) == "composer"


# ── route_after_dispatch: replan triggers ────────────────────────────────────


def test_route_replans_on_low_confidence():
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"}]
    outputs = {"RootCauseAnalyst": {"confidence": LOW_CONFIDENCE_THRESHOLD - 0.01}}
    assert route_after_dispatch(_state(plan=plan, plan_idx=1, specialist_outputs=outputs)) == "replan"


def test_route_does_not_replan_at_confidence_threshold():
    # Strictly-less-than: exactly at the threshold is acceptable, no replan.
    plan = [
        {"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"},
        {"idx": 1, "specialist": "AnomalyDetector", "intent": "b"},
    ]
    outputs = {"RootCauseAnalyst": {"confidence": LOW_CONFIDENCE_THRESHOLD}}
    assert route_after_dispatch(_state(plan=plan, plan_idx=1, specialist_outputs=outputs)) == "dispatcher"


def test_route_replans_on_tool_unavailable_even_with_high_confidence():
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"}]
    outputs = {"RootCauseAnalyst": {"confidence": 1.0, "error": "tool_unavailable"}}
    assert route_after_dispatch(_state(plan=plan, plan_idx=1, specialist_outputs=outputs)) == "replan"


def test_route_does_not_replan_on_other_errors():
    # Only error == "tool_unavailable" forces a replan; other errors don't.
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"}]
    outputs = {"RootCauseAnalyst": {"confidence": 1.0, "error": "neo4j_failed"}}
    assert route_after_dispatch(_state(plan=plan, plan_idx=1, specialist_outputs=outputs)) == "composer"


def test_route_missing_confidence_defaults_to_high():
    # No confidence key → defaults to 1.0 → no replan.
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"}]
    outputs = {"RootCauseAnalyst": {}}
    assert route_after_dispatch(_state(plan=plan, plan_idx=1, specialist_outputs=outputs)) == "composer"


# ── route_after_dispatch: replan-cap interaction (issues #53/#54) ─────────────


def test_route_stops_replanning_at_max_replans():
    """Issues #53/#54 (FIXED): once replan_count has reached MAX_REPLANS (5),
    the router no longer routes to replan even on low confidence — it falls
    through to composer, which emits partial=True. All three boundaries align
    on MAX_REPLANS."""
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"}]
    outputs = {"RootCauseAnalyst": {"confidence": 0.0}}  # would normally replan
    state = _state(plan=plan, plan_idx=1, specialist_outputs=outputs, replan_count=MAX_REPLANS)
    assert route_after_dispatch(state) == "composer"


def test_route_still_replans_one_below_cap():
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"}]
    outputs = {"RootCauseAnalyst": {"confidence": 0.0}}
    state = _state(plan=plan, plan_idx=1, specialist_outputs=outputs, replan_count=MAX_REPLANS - 1)
    assert route_after_dispatch(state) == "replan"


def test_route_no_replan_when_idx_zero():
    # Guard: idx must be > 0 to inspect a "last" result.
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"}]
    outputs = {"RootCauseAnalyst": {"confidence": 0.0}}
    assert route_after_dispatch(_state(plan=plan, plan_idx=0, specialist_outputs=outputs)) == "dispatcher"


# ── route_after_dispatch: per-turn token budget (issue #42) ──────────────────


def test_route_composes_when_per_turn_token_cap_exceeded():
    """Once the turn has burned the per-turn token cap, the dispatcher bails to
    the composer even though plan steps remain — no unbounded dispatch/replan."""
    plan = [
        {"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"},
        {"idx": 1, "specialist": "AnomalyDetector", "intent": "b"},
    ]
    outputs = {"RootCauseAnalyst": {"confidence": 0.9}}  # healthy, would normally continue
    audit = [{"step_kind": "compose", "tokens_in": PER_TURN_TOKEN_CAP, "tokens_out": 0}]
    state = _state(plan=plan, plan_idx=1, specialist_outputs=outputs, audit_trail=audit)
    assert route_after_dispatch(state) == "composer"


def test_route_token_budget_overrides_replan():
    # Even a low-confidence result that would replan is short-circuited to
    # compose once the per-turn cap is hit.
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"}]
    outputs = {"RootCauseAnalyst": {"confidence": 0.0}}
    audit = [{"step_kind": "compose", "tokens_in": PER_TURN_TOKEN_CAP + 1, "tokens_out": 0}]
    state = _state(plan=plan, plan_idx=1, specialist_outputs=outputs, audit_trail=audit)
    assert route_after_dispatch(state) == "composer"


def test_route_continues_when_under_token_cap():
    plan = [
        {"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a"},
        {"idx": 1, "specialist": "AnomalyDetector", "intent": "b"},
    ]
    outputs = {"RootCauseAnalyst": {"confidence": 0.9}}
    audit = [{"step_kind": "compose", "tokens_in": 500, "tokens_out": 200}]
    state = _state(plan=plan, plan_idx=1, specialist_outputs=outputs, audit_trail=audit)
    assert route_after_dispatch(state) == "dispatcher"


# ── #57: results are kept per plan step, not per specialist name ─────────────


def test_dispatcher_keeps_both_results_when_a_specialist_runs_twice():
    plan = [
        {"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a", "done": True},
        {"idx": 1, "specialist": "RootCauseAnalyst", "intent": "b"},
    ]
    first = {"specialist": "RootCauseAnalyst", "findings": [{"sev": "info", "text": "first", "log_ids": []}], "confidence": 0.9}
    out = asyncio.run(dispatcher_node(
        _state(
            plan=plan,
            plan_idx=1,
            specialist_outputs={"RootCauseAnalyst": first},
            step_results=[{"idx": 0, "specialist": "RootCauseAnalyst", "result": first}],
        ),
        router=MockRouter(),
    ))

    assert [r["idx"] for r in out["step_results"]] == [0, 1]
    assert out["step_results"][0]["result"] is first
    assert out["last_result"] is out["step_results"][1]["result"]


def test_route_judges_the_step_that_just_ran_not_a_same_named_earlier_one():
    plan = [
        {"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a", "done": True},
        {"idx": 1, "specialist": "NoSuchSpecialist", "intent": "b"},
    ]
    # Step 1 was skipped (unknown specialist), so nothing fresh ran. The stale
    # low-confidence output under the same name must not trigger a replan.
    state = _state(
        plan=plan,
        plan_idx=2,
        specialist_outputs={"NoSuchSpecialist": {"confidence": 0.0}},
        last_result=None,
    )
    assert route_after_dispatch(state) == "composer"


def test_route_does_not_replan_again_on_the_result_it_already_replanned_for():
    # replan returned no new steps: the dispatcher had nothing to run, so the
    # low-confidence result that caused that replan is not judged a second time.
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a", "done": True}]
    state = _state(
        plan=plan,
        plan_idx=1,
        specialist_outputs={"RootCauseAnalyst": {"confidence": 0.1}},
        replan_count=1,
        last_result=None,
    )
    assert route_after_dispatch(state) == "composer"


def test_route_replans_on_a_fresh_low_confidence_result():
    plan = [{"idx": 0, "specialist": "RootCauseAnalyst", "intent": "a", "done": True}]
    state = _state(plan=plan, plan_idx=1, last_result={"confidence": 0.1})
    assert route_after_dispatch(state) == "replan"
