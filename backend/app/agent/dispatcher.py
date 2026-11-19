"""
Dispatcher node — walks the plan one step at a time.

Each invocation of `dispatcher_node` advances `plan_idx` by 1 and writes the
specialist's output into `specialist_outputs[specialist_name]`. The graph's
conditional edge then either loops back for the next step, branches to replan
on low confidence, or proceeds to the composer when the plan is exhausted.
"""
from __future__ import annotations

import logging
from typing import Any

from app.agent.budget import per_turn_cap_exceeded, total_tokens_in_audit
from app.agent.specialists.defaults import get_specialist
from app.agent.state import MAX_REPLANS, PER_TURN_TOKEN_CAP, GraphState
from app.llm.router import LLMRouter

logger = logging.getLogger(__name__)

LOW_CONFIDENCE_THRESHOLD = 0.4


async def dispatcher_node(state: GraphState, *, router: LLMRouter) -> dict[str, Any]:
    plan = state.get("plan", [])
    idx = state.get("plan_idx", 0)
    if idx >= len(plan):
        # Nothing ran, so there is no fresh result for route_after_dispatch.
        return {"last_result": None}

    step = plan[idx]
    specialist = get_specialist(step["specialist"])
    if specialist is None:
        logger.warning("dispatcher: unknown specialist %s", step["specialist"])
        # Skip this step.
        return {"plan_idx": idx + 1, "last_result": None}

    session_summary = state.get("session_summary", "") if isinstance(state, dict) else ""
    result, audit = await specialist.run(
        router=router,
        session_id=state["session_id"],
        intent=step["intent"],
        session_summary=session_summary,
    )

    # Mark the plan step done in place.
    plan_copy = list(plan)
    plan_copy[idx] = {**step, "done": True}

    outputs = dict(state.get("specialist_outputs") or {})
    outputs[step["specialist"]] = result
    # `outputs` holds only the latest result per specialist name. A plan can use
    # one specialist in several steps, so every result is also kept per step (#57).
    step_results = list(state.get("step_results") or [])
    step_results.append({"idx": idx, "specialist": step["specialist"], "result": result})

    # Track the per-turn token budget so it's actually decremented (issue #42).
    used = total_tokens_in_audit(list(state.get("audit_trail") or []) + list(audit))

    return {
        "plan": plan_copy,
        "plan_idx": idx + 1,
        "specialist_outputs": outputs,
        "step_results": step_results,
        "last_result": result,
        "audit_trail": audit,
        "token_budget_remaining": max(0, PER_TURN_TOKEN_CAP - used),
    }


def route_after_dispatch(state: GraphState) -> str:
    """
    Conditional edge after dispatcher:
      - 'replan' if the last specialist returned low confidence or tool_unavailable
        AND we still have replan budget remaining
      - 'dispatcher' if more plan steps remain
      - 'composer' if the plan is exhausted (or the replan cap is hit)
    """
    plan = state.get("plan", [])
    idx = state.get("plan_idx", 0)
    outputs = state.get("specialist_outputs", {})
    replan_count = int(state.get("replan_count", 0) or 0)

    # Per-turn token budget (issue #42): once the turn has burned the cap, stop
    # dispatching/replanning and bail straight to the composer (which marks the
    # turn partial). This overrides the replan branch below.
    if per_turn_cap_exceeded(state.get("audit_trail", []) or []):
        return "composer"

    # Inspect the result of the step the dispatcher just ran. `last_result` is
    # None when it ran nothing (plan exhausted, or an unknown specialist was
    # skipped): judging the previous step again there re-triggered a replan on a
    # result that had already caused one, until the replan cap burned (#57).
    if plan and idx > 0 and replan_count < MAX_REPLANS:
        if "last_result" in state:
            last_result = state["last_result"] or {}
        else:
            # A state checkpointed before `last_result` existed.
            last_step = plan[idx - 1]
            last_result = outputs.get(last_step["specialist"]) or {}
        confidence = float(last_result.get("confidence", 1.0))
        had_tool_unavailable = bool(last_result.get("error") == "tool_unavailable")
        if confidence < LOW_CONFIDENCE_THRESHOLD or had_tool_unavailable:
            return "replan"

    if idx < len(plan):
        return "dispatcher"
    return "composer"
