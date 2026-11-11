"""
SSE chat endpoint for the multi-agent orchestrator.

POST /api/sessions/{session_id}/chat
  Body: { message, composer_provider?, composer_model? }

Emits the 8 event types from `docs/implementation.md` §4.4:
  plan, step-start, step-progress, step-done, replan, token, final, error.

For Phase 4 we use LangGraph's `astream` with `stream_mode='updates'` to
observe state deltas after each node, and translate them into the SSE event
shape. Composer token streaming is layered on after the graph completes
(non-streaming composer for now; Phase 4.5 wires token streaming).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from contextlib import ExitStack
from datetime import date, datetime
from typing import Any, AsyncIterator

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.agent.checkpointer import get_checkpointer
from app.agent.fact_extractor import extract_facts
from app.agent.graph import build_graph, initial_state
from app.db_sqlite import get_db
from app.services.neo4j_client import neo4j_client
from app.llm.router import get_router
from app.models import ChatMessageRecord, SessionCostRecord, SessionRecord
from app.schemas import ChatRequest

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["chat"])


def _json_default(obj: Any) -> Any:
    """Typed JSON fallback (issue #77).

    `default=str` blindly `repr`-stringifies non-serializable values, which can
    silently corrupt SSE/persisted payloads (e.g. a `datetime` or a `bytes`
    `thought_signature`). Encode the types we actually expect properly; fall
    back to `str` only for anything still unforeseen.
    """
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if isinstance(obj, (bytes, bytearray)):
        return base64.b64encode(bytes(obj)).decode("ascii")
    return str(obj)


def _format_sse(event: str, data: Any) -> dict[str, str]:
    """sse-starlette wants {event, data} where data is a JSON string."""
    return {"event": event, "data": json.dumps(data, default=_json_default)}


def _error_event(code: str, exc: Exception, *, recoverable: bool) -> dict[str, str]:
    """Build a sanitized SSE `error` frame (issue #63).

    The raw exception string can embed internal hostnames/paths/keys, so the
    client only ever sees a fixed message plus a correlation id; the full
    detail is logged server-side under that id.
    """
    correlation_id = uuid.uuid4().hex
    logger.error("chat error [%s] code=%s: %r", correlation_id, code, exc, exc_info=True)
    return _format_sse("error", {
        "code": code,
        "message": "An internal error occurred. See server logs for details.",
        "correlation_id": correlation_id,
        "recoverable": recoverable,
    })


def _session_summary_string(record: SessionRecord) -> str:
    topics_str = ""
    if record.topics_json:
        try:
            td = json.loads(record.topics_json)
            if td:
                names = [f"{t['name']}({t.get('type', '?')})" for t in td[:15]]
                topics_str = f", topics=[{', '.join(names)}]"
        except Exception:
            pass
    return (
        f"filename={record.filename}, "
        f"robot={record.robot_name or 'unknown'}, "
        f"duration_s={record.duration_seconds or 0}, "
        f"total_messages={record.total_messages or 0}"
        f"{topics_str}"
    )


def session_overview(record: SessionRecord) -> dict[str, Any]:
    """The facts ``_session_summary_string`` gives DataPilot's agents, as data."""
    topics: list[dict[str, Any]] = []
    if record.topics_json:
        try:
            topics = [{"name": t["name"], "type": t.get("type", "?")} for t in json.loads(record.topics_json)[:15]]
        except Exception:
            topics = []
    return {
        "filename": record.filename,
        "robot": record.robot_name or "unknown",
        "duration_s": record.duration_seconds or 0,
        "total_messages": record.total_messages or 0,
        "topics": topics,
    }


@router.post("/{session_id}/chat")
async def chat(
    session_id: str,
    payload: ChatRequest,
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
    record = res.scalar_one_or_none()
    if not record:
        if session_id == "general":
            # Guard against a race: two concurrent first-time requests could both
            # find record=None and both try to INSERT id='general', causing an
            # IntegrityError on the second. Roll back and re-query in that case.
            try:
                record = SessionRecord(
                    id="general",
                    filename="No bag loaded",
                    filepath="",
                    status="ready",
                    robot_name="N/A",
                    ros_version="N/A",
                    duration_seconds=0.0,
                    start_time="",
                    end_time="",
                    total_messages=0,
                    topics_list="[]",
                    timeline_json="[]",
                    topics_json="[]",
                    kgraph_json='{"nodes": [], "edges": []}',
                    replay_json="[]",
                    anomalies_json="[]",
                )
                db.add(record)
                await db.commit()
            except Exception:
                await db.rollback()
            # Re-query to bind to the session (whether we just created it or a
            # concurrent request did).
            res = await db.execute(select(SessionRecord).where(SessionRecord.id == "general"))
            record = res.scalar_one_or_none()
        else:
            raise HTTPException(status_code=404, detail="Session not found")
    if record.status != "ready":
        raise HTTPException(status_code=409, detail=f"Session not ready (status={record.status})")

    session_summary = _session_summary_string(record)

    # Load prior transcript so the supervisor has continuity.
    transcript_res = await db.execute(
        select(ChatMessageRecord)
        .where(ChatMessageRecord.session_id == session_id)
        .order_by(ChatMessageRecord.id.asc())
    )
    transcript = [
        {"role": m.role, "content": m.content, "ts": m.created_at.timestamp() if m.created_at else 0}
        for m in transcript_res.scalars().all()
    ]

    async def event_stream() -> AsyncIterator[dict[str, str]]:
        turn_started = time.perf_counter()
        router_instance = get_router()

        if session_id == "general":
            try:
                client = router_instance.for_composer(payload.composer_model)
                messages = []
                for turn in transcript:
                    messages.append({"role": turn["role"], "content": turn["content"]})
                messages.append({"role": "user", "content": payload.message})

                # Stream plan to make UI feel responsive
                yield _format_sse("plan", {"plan": []})

                system_prompt = (
                    "You are DataPilot, an advanced, local-first ROS 2 debugging copilot.\n"
                    "Right now, no ROS bag file is loaded. Your job is to be helpful and assist the user.\n"
                    "Guide them on how to load a ROS bag (by clicking the 'Upload rosbag' chip or dragging a file),\n"
                    "explain what analysis capabilities you have (root cause analysis, anomaly detection, performance profiling,\n"
                    "tf tree analysis), or answer any general questions they might have about ROS 2, robotics, or debugging."
                )

                resp = await client.complete(
                    system=system_prompt,
                    messages=messages,
                    temperature=0.7,
                    max_tokens=1024,
                )
                response_text = resp["content"]
                input_tokens = resp["usage"]["input_tokens"]
                output_tokens = resp["usage"]["output_tokens"]

                from app.agent.budget import estimate_cost_usd
                # Create a mock audit trail for cost estimation
                audit = [{
                    "step_kind": "general_chat",
                    "ts": time.time(),
                    "tokens_in": input_tokens,
                    "tokens_out": output_tokens,
                }]

                envelope = {
                    "response": response_text,
                    "plan": [],
                    "findings": [],
                    "causal": [],
                    "audit_trail": audit,
                    "citations": [],
                    "usage": {
                        "tokens_in": input_tokens,
                        "tokens_out": output_tokens,
                        "est_cost_usd": estimate_cost_usd(audit),
                    },
                    "partial": False
                }

                yield _format_sse("final", envelope)

                # Persist outside
                try:
                    await _persist_turn(db, session_id, payload.message, envelope, turn_started)
                except Exception:
                    logger.exception("chat: persistence failed")

            except Exception as exc:
                yield _error_event("chat_error", exc, recoverable=False)
            return

        # Per-session token budget (issue #42): sum prior turns' usage and refuse
        # a new turn once the session cap is reached, before spending more.
        from app.agent.budget import session_cap_exceeded
        prior_res = await db.execute(
            select(SessionCostRecord).where(SessionCostRecord.session_id == session_id)
        )
        prior_tokens = sum(
            int(r.tokens_in or 0) + int(r.tokens_out or 0)
            for r in prior_res.scalars().all()
        )
        if session_cap_exceeded(prior_tokens):
            yield _format_sse("error", {
                "code": "session_budget_exceeded",
                "message": "Session token budget exhausted. Start a new session to continue.",
                "recoverable": False,
            })
            return

        # get_checkpointer() returns a SqliteSaver context manager — enter it so
        # the underlying SQLite connection is open for the lifetime of this stream.
        with ExitStack() as stack:
            checkpointer_cm = get_checkpointer()
            checkpointer = stack.enter_context(checkpointer_cm) if checkpointer_cm is not None else None
            graph = build_graph(router_instance, checkpointer)

            state = initial_state(
                session_id=session_id,
                user_message=payload.message,
                transcript=transcript,
                session_summary=session_summary,
                composer_model=payload.composer_model,
            )
            config = {"configurable": {"thread_id": session_id}}

            final_envelope: dict[str, Any] | None = None
            emitted_plan = False
            last_plan_idx = 0

            try:
                async for update in graph.astream(state, config=config, stream_mode="updates"):
                    # `update` is {node_name: state_patch}
                    for node_name, patch in update.items():
                        if not isinstance(patch, dict):
                            continue
                        if node_name == "supervisor" and "plan" in patch and not emitted_plan:
                            plan = patch["plan"]
                            yield _format_sse("plan", {"plan": plan})
                            emitted_plan = True
                            # Emit step-start for the first step immediately so the
                            # UI shows "running…" from the beginning (not after the
                            # first dispatcher update which has already advanced idx).
                            if plan:
                                yield _format_sse("step-start", {
                                    "idx": 0,
                                    "specialist": plan[0]["specialist"],
                                })
                        elif node_name == "dispatcher":
                            # plan_idx advanced — the step at last_plan_idx just finished.
                            new_idx = int(patch.get("plan_idx", last_plan_idx))
                            plan = patch.get("plan") or []
                            # Emit step-done for the step that just completed.
                            for i in range(last_plan_idx, new_idx):
                                if i < len(plan):
                                    step = plan[i]
                                    spec_name = step["specialist"]
                                    spec_out = (patch.get("specialist_outputs") or {}).get(spec_name) or {}
                                    yield _format_sse("step-done", {
                                        "idx": i,
                                        "specialist": spec_name,
                                        "confidence": spec_out.get("confidence", 1.0),
                                        "output_summary": _summary_for(spec_out),
                                    })
                            # Also emit step-start for the next pending step.
                            if new_idx < len(plan):
                                next_step = plan[new_idx]
                                yield _format_sse("step-start", {
                                    "idx": new_idx,
                                    "specialist": next_step["specialist"],
                                })
                            last_plan_idx = new_idx
                        elif node_name == "replan":
                            yield _format_sse("replan", {
                                "reason": patch.get("audit_trail", [{}])[-1].get("result_summary", "low_confidence"),
                                "new_plan": patch.get("plan") or [],
                            })
                        elif node_name == "composer" and "final" in patch:
                            final_envelope = patch["final"]
            except Exception as exc:
                yield _error_event("graph_error", exc, recoverable=False)
                return

            if final_envelope is None:
                yield _format_sse("error", {
                    "code": "no_final",
                    "message": "Graph finished without composing a final envelope.",
                    "recoverable": True,
                })
                return

            yield _format_sse("final", final_envelope)

        # Persist outside the ExitStack so the checkpointer is already closed cleanly.
        try:
            await _persist_turn(db, session_id, payload.message, final_envelope, turn_started)
        except Exception:
            logger.exception("chat: persistence failed")

        # Distil durable facts from this turn into the knowledge graph (Neo4j).
        # Best-effort, and only after the answer has streamed, so it never adds
        # latency to the response or breaks the turn.
        try:
            facts = await extract_facts(
                router_instance.for_supervisor(),
                session_summary=session_summary,
                user_msg=payload.message,
                envelope=final_envelope,
            )
            if facts:
                cited = sorted({
                    lid
                    for f in (final_envelope.get("findings") or [])
                    if isinstance(f, dict)
                    for lid in (f.get("log_ids") or [])
                })
                for f in facts:
                    f["log_ids"] = cited
                # Neo4j I/O is synchronous — keep it off the event loop.
                await asyncio.to_thread(neo4j_client.write_facts, session_id, facts)
                # Signal the client to refetch the knowledge graph.
                yield _format_sse("kgraph", {"facts": len(facts)})
        except Exception:
            logger.exception("chat: fact extraction failed")

    return EventSourceResponse(event_stream())


def _summary_for(spec_output: dict[str, Any]) -> str:
    findings = spec_output.get("findings", []) or []
    if not findings:
        return f"specialist returned {len(findings)} finding(s)"
    first = findings[0]
    top_text = first.get("text", str(first))[:80] if isinstance(first, dict) else str(first)[:80]
    return f"{len(findings)} finding(s); top: {top_text}"


@router.get("/{session_id}/messages")
async def get_messages(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Return the persisted chat history for a session (for session resume)."""
    rows_res = await db.execute(
        select(ChatMessageRecord)
        .where(ChatMessageRecord.session_id == session_id)
        .order_by(ChatMessageRecord.id.asc())
    )
    rows = rows_res.scalars().all()
    out: list[dict[str, Any]] = []
    for r in rows:
        ext = _external_agent_event(r.execution_steps) if r.role == "assistant" else None
        if r.role != "assistant":
            answered_by = None
        else:
            answered_by = "claude_code" if ext else "datapilot"
        out.append({
            "role": r.role,
            "content": r.content,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "findings": json.loads(r.findings_json) if r.findings_json else None,
            "causal": json.loads(r.causal_json) if r.causal_json else None,
            "plan": json.loads(r.plan_json) if r.plan_json else None,
            "answered_by": answered_by,
            "verified": ext.get("verified") if ext else None,
            "flagged_log_ids": (ext.get("flagged_log_ids") or []) if ext else [],
            "claude_code_usage": (
                {
                    "model": ext.get("model", ""),
                    "auth_method": ext.get("auth_method", "none"),
                    "tool_calls": ext.get("tool_calls", 0),
                    "est_cost_usd": ext.get("est_cost_usd", 0.0),
                }
                if ext
                else None
            ),
        })
    return out


def _external_agent_event(execution_steps: str | None) -> dict | None:
    """The first audit event, when it records a turn answered by Claude Code."""
    if not execution_steps:
        return None
    try:
        events = json.loads(execution_steps)
    except (TypeError, ValueError):
        return None
    if isinstance(events, list) and events and isinstance(events[0], dict):
        if events[0].get("step_kind") == "external_agent":
            return events[0]
    return None


async def _persist_turn(
    db: AsyncSession,
    session_id: str,
    user_msg: str,
    envelope: dict[str, Any],
    turn_started: float,
    *,
    record_cost: bool = True,
) -> None:
    """Save user + assistant turns to chat_messages, usage to session_costs."""
    # User turn
    db.add(ChatMessageRecord(session_id=session_id, role="user", content=user_msg))
    # Assistant turn (stringify the envelope's response prose; the full envelope
    # lives in the SSE stream — we keep the DB row lightweight).
    db.add(ChatMessageRecord(
        session_id=session_id,
        role="assistant",
        content=envelope.get("response", ""),
        execution_steps=json.dumps(envelope.get("audit_trail", []), default=_json_default),
        citations=json.dumps(envelope.get("citations", []), default=_json_default),
        findings_json=json.dumps(envelope.get("findings", []), default=_json_default),
        causal_json=json.dumps(envelope.get("causal", []), default=_json_default),
        plan_json=json.dumps(envelope.get("plan", []), default=_json_default),
    ))
    # Cost row
    usage = envelope.get("usage") or {}
    # Claude Code turns pass record_cost=False: that table feeds DataPilot's own
    # per-session token cap, and Claude Code's usage isn't DataPilot's spend.
    if usage and record_cost:
        # Count existing turns for turn_index.
        existing = await db.execute(
            select(SessionCostRecord).where(SessionCostRecord.session_id == session_id)
        )
        turn_index = len(existing.scalars().all())
        db.add(SessionCostRecord(
            session_id=session_id,
            turn_index=turn_index,
            tokens_in=int(usage.get("tokens_in", 0)),
            tokens_out=int(usage.get("tokens_out", 0)),
            est_cost_usd=float(usage.get("est_cost_usd", 0.0)),
        ))
    await db.commit()
