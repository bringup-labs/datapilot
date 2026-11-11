"""Claude Code turns: create, then complete into a normal saved chat turn."""
from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.grounding import check_findings, find_unknown_log_ids
from app.agent.turn_store import turn_store
from app.api.chat import _persist_turn
from app.db_sqlite import get_db
from app.models import SessionRecord
from app.schemas import AgentTurnComplete

router = APIRouter(prefix="/sessions", tags=["agent-turns"])


async def _require_ready_session(db: AsyncSession, session_id: str) -> SessionRecord:
    res = await db.execute(select(SessionRecord).where(SessionRecord.id == session_id))
    record = res.scalar_one_or_none()
    if not record:
        raise HTTPException(status_code=404, detail="Session not found")
    if record.status != "ready":
        raise HTTPException(status_code=409, detail=f"Session not ready (status={record.status})")
    return record


@router.post("/{session_id}/agent-turns", status_code=201)
async def create_agent_turn(session_id: str, db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    await _require_ready_session(db, session_id)
    return {"turn_id": turn_store.create(session_id)}


@router.post("/{session_id}/agent-turns/{turn_id}/complete")
async def complete_agent_turn(
    session_id: str,
    turn_id: str,
    body: AgentTurnComplete,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await _require_ready_session(db, session_id)
    stored = turn_store.pop(session_id, turn_id)
    if stored is None:
        raise HTTPException(status_code=404, detail="Turn not found")
    if body.status == "failed":
        return {"status": "discarded"}

    # Re-check now: the bag may differ from when the findings were submitted.
    grounding = await asyncio.to_thread(check_findings, session_id, stored.findings, stored.causal)
    flagged = await asyncio.to_thread(find_unknown_log_ids, session_id, body.response)
    verified = bool(grounding["findings"])

    now = time.time()
    audit: list[dict[str, Any]] = [{
        "step_kind": "external_agent",
        "specialist": "claude_code",
        "ts": now,
        "model": body.model,
        "auth_method": body.auth_method,
        "status": body.status,
        "verified": verified,
        "flagged_log_ids": flagged,
        "tool_calls": len(body.steps),
        "tokens_in": body.usage.tokens_in,
        "tokens_out": body.usage.tokens_out,
        "est_cost_usd": body.usage.est_cost_usd,
    }]
    if grounding["rejected"]:
        texts = [r["text"][:60] for r in grounding["rejected"]]
        audit.append({
            "step_kind": "compose",
            "ts": now,
            "result_summary": f"dropped {len(texts)} uncited finding(s): {texts[:3]}",
        })
    if flagged:
        audit.append({
            "step_kind": "compose",
            "ts": now,
            "result_summary": f"summary mentions log IDs not in this bag: {flagged}",
        })

    usage = {
        "tokens_in": body.usage.tokens_in,
        "tokens_out": body.usage.tokens_out,
        "est_cost_usd": body.usage.est_cost_usd,
    }
    envelope: dict[str, Any] = {
        "response": body.response,
        "plan": [{"label": s.label, "tool": s.tool} for s in body.steps],
        "findings": grounding["findings"],
        "causal": grounding["causal"],
        "audit_trail": audit,
        "citations": grounding["citations"],
        "usage": usage,
        "partial": body.status == "stopped",
        "answered_by": "claude_code",
        "verified": verified,
        "flagged_log_ids": flagged,
        "claude_code_usage": {
            "model": body.model,
            "auth_method": body.auth_method,
            "tool_calls": len(body.steps),
            "est_cost_usd": body.usage.est_cost_usd,
        },
    }
    # No cost row (not DataPilot's spend); no fact extraction (it would call a
    # backend LLM provider the user didn't pick).
    await _persist_turn(db, session_id, body.question, envelope, time.perf_counter(), record_cost=False)
    return envelope
