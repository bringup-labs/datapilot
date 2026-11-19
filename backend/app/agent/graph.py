"""
Top-level LangGraph: START → supervisor → dispatcher (looping) → composer → END
with conditional replan branch.

The compiled graph is cached at module level for low-overhead reuse across
sessions; the SqliteSaver checkpointer is bound at app lifespan start.
"""
from __future__ import annotations

import logging
from functools import partial
from typing import Any, Callable

from langgraph.graph import END, START, StateGraph

from app.agent.composer import composer_node
from app.agent.dispatcher import dispatcher_node, route_after_dispatch
from app.agent.replan import replan_node, route_after_replan
from app.agent.state import GraphState
from app.agent.supervisor import supervisor_node
from app.llm.router import LLMRouter

logger = logging.getLogger(__name__)


def build_graph(router: LLMRouter, checkpointer: Any = None):
    """
    Construct the LangGraph for one orchestration run.

    Nodes are wrapped via `partial` so the router (and any future deps) inject
    without polluting the node signatures with extra args.
    """
    builder = StateGraph(GraphState)

    builder.add_node("supervisor", partial(supervisor_node, router=router))
    builder.add_node("dispatcher", partial(dispatcher_node, router=router))
    builder.add_node("replan",     partial(replan_node, router=router))
    builder.add_node("composer",   partial(composer_node, router=router))

    builder.add_edge(START, "supervisor")
    builder.add_edge("supervisor", "dispatcher")
    builder.add_conditional_edges(
        "dispatcher",
        route_after_dispatch,
        {"dispatcher": "dispatcher", "replan": "replan", "composer": "composer"},
    )
    # On replan overflow (force_compose) the edge routes straight to the
    # composer for a partial compose; otherwise back to the dispatcher to run
    # the rewritten plan tail (issue #53).
    builder.add_conditional_edges(
        "replan",
        route_after_replan,
        {"dispatcher": "dispatcher", "composer": "composer"},
    )
    builder.add_edge("composer", END)

    return builder.compile(checkpointer=checkpointer)


# ── Run helpers ─────────────────────────────────────────────────────────────


def initial_state(
    session_id: str,
    user_message: str,
    *,
    transcript: list | None = None,
    session_summary: str = "",
    composer_model: str | None = None,
) -> GraphState:
    """Build a fresh GraphState dict for a turn."""
    return GraphState(
        session_id=session_id,
        user_message=user_message,
        transcript=transcript or [],
        plan=[],
        plan_idx=0,
        specialist_outputs={},
        step_results=[],
        last_result=None,
        retrieval_context=[],
        replan_count=0,
        force_compose=False,
        audit_trail=[],
        token_budget_remaining=25_000,
        final=None,
        session_summary=session_summary,
        composer_model=composer_model,
    )
