"""
Composer node — final synthesis. Produces the `ChatMessageEnvelope` payload
that gets streamed back to the renderer as the SSE `final` event.

Validation rule: every Finding must cite at least one `log_id` that resolves
to an actual `(:Log)` node in Neo4j for this session. Uncited findings are
dropped (and reported in the audit trail) rather than allowed through —
this is the citation grounding contract from `docs/implementation.md` §4.10.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

from app.agent.budget import estimate_cost_usd, per_turn_cap_exceeded
from app.agent.state import (
    MAX_REPLANS,
    AuditEvent,
    CausalStep,
    ChatMessageEnvelope,
    Citation,
    Finding,
    GraphState,
    UsageMetrics,
)
from app.llm.router import LLMRouter
from app.services.neo4j_client import neo4j_client

logger = logging.getLogger(__name__)

PROMPT_PATH = Path(__file__).parent / "prompts" / "composer.md"


def _collect_findings(state: GraphState) -> list[Finding]:
    """Aggregate findings across specialists, verbatim.

    No rejection happens here — severity-gated citation grounding is the job of
    `_filter_uncited()` below (issue #50). Non-dict entries are skipped.
    """
    findings: list[Finding] = []
    for spec_result in (state.get("specialist_outputs") or {}).values():
        for f in spec_result.get("findings", []):
            if not isinstance(f, dict):
                continue
            findings.append(f)  # type: ignore[arg-type]
    return findings


def _collect_causal(state: GraphState) -> list[CausalStep]:
    """Prefer RCA's causal chain; fall back to empty."""
    outputs = state.get("specialist_outputs") or {}
    rca = outputs.get("RootCauseAnalyst") or {}
    return list(rca.get("causal") or [])


class CitationLookupError(RuntimeError):
    """Neo4j could not be asked which cited log_ids exist."""


def _resolve_citations(
    session_id: str, findings: list[Finding], *, strict: bool = False
) -> list[Citation]:
    """Look up the cited log_ids and return a Citation list.

    A failed lookup returns [] unless `strict` is set, in which case it raises
    `CitationLookupError`: to the caller, [] means "none of these ids exist",
    which is a different fact from "Neo4j did not answer" (#58).
    """
    all_ids: list[str] = []
    for f in findings:
        all_ids.extend(f.get("log_ids", []))
    if not all_ids:
        return []
    cypher = """
    MATCH (s:Session {id: $session_id})-[:HAS_LOG]->(l:Log)
    WHERE l.id IN $log_ids
    RETURN l.id AS log_id, l.ts AS ts, l.node AS node, l.msg AS msg
    """
    try:
        rows = neo4j_client.run_query(cypher, {"session_id": session_id, "log_ids": list(set(all_ids))})
    except Exception as exc:
        logger.exception("composer: citation resolution failed")
        if strict:
            raise CitationLookupError("citation lookup failed") from exc
        return []

    from app.services.causal_rules import log_time_to_seconds
    return [
        Citation(
            log_id=r["log_id"],
            ts=log_time_to_seconds(r.get("ts", "0")),
            node=r.get("node", ""),
            snippet=(r.get("msg", "") or "")[:140],
        )
        for r in rows
    ]


# Severities that assert a concrete defect and therefore MUST be grounded in at
# least one resolvable log_id (the anti-hallucination contract, AGENT.md
# "LLM Output & Grounding"). info/success findings are nominal summary
# observations and may stand without a citation.
_GROUNDING_REQUIRED_SEVS = frozenset({"critical", "warning"})


def _filter_uncited(findings: list[Finding], valid_log_ids: set[str]) -> tuple[list[Finding], list[str]]:
    """Enforce severity-gated citation grounding (issue #50).

    Rules:
      - A finding with ≥1 log_id that resolves in Neo4j is always kept.
      - A finding whose log_ids are non-empty but NONE resolve is dropped.
      - A finding with empty/missing log_ids is kept ONLY when its severity is
        nominal (info/success). For critical/warning the empty-citation
        allowance is removed: high-severity claims with no resolvable log_id are
        dropped, since uncited findings are rejected by the Composer.
    """
    kept: list[Finding] = []
    dropped: list[str] = []
    for f in findings:
        ids = f.get("log_ids") or []
        sev = f.get("sev", "info")
        if any(lid in valid_log_ids for lid in ids):
            kept.append(f)
        elif not ids and sev not in _GROUNDING_REQUIRED_SEVS:
            # Nominal summary observation (e.g. "No anomalies detected").
            kept.append(f)
        else:
            dropped.append(f.get("text", "")[:60])
    return kept, dropped


async def composer_node(state: GraphState, *, router: LLMRouter) -> dict[str, Any]:
    started = time.perf_counter()
    session_id = state["session_id"]
    audit: list[AuditEvent] = []

    # 1. Gather findings + causal chain across specialists.
    findings = _collect_findings(state)
    causal = _collect_causal(state)

    # 2. Resolve citations in Neo4j and filter findings whose log_ids vanished.
    #    A failed lookup is retried once and then fails the turn: treating it
    #    as "no log_id exists" would drop every cited finding and present the
    #    emptied answer as grounded (#58).
    try:
        citations = _resolve_citations(session_id, findings, strict=True)
    except CitationLookupError:
        citations = _resolve_citations(session_id, findings, strict=True)
    valid_log_ids = {c["log_id"] for c in citations}
    findings, uncited = _filter_uncited(findings, valid_log_ids)
    if uncited:
        audit.append({
            "step_kind": "compose",
            "ts": time.perf_counter(),
            "result_summary": f"dropped {len(uncited)} uncited finding(s): {uncited[:3]}",
        })

    # 3. Ask the composer LLM to write the prose response.
    composer_client = router.for_composer(state.get("composer_model"))
    session_summary = state.get("session_summary", "") if isinstance(state, dict) else ""
    facts = {
        "user_question": state["user_message"],
        "session_summary": session_summary,
        "plan": state.get("plan", []),
        "findings": findings,
        "causal": causal,
        "citations": [{"log_id": c["log_id"], "ts": c["ts"], "node": c["node"]} for c in citations],
    }
    resp = await composer_client.complete(
        system=PROMPT_PATH.read_text(encoding="utf-8"),
        messages=[{
            "role": "user",
            "content": (
                "Compose the response. Facts you may use (everything else is "
                f"hearsay — do NOT invent log_ids):\n\n{json.dumps(facts, indent=2)}"
            ),
        }],
        temperature=0.2,
        max_tokens=1024,
    )
    assert isinstance(resp, dict)
    response_text = resp["content"]

    audit.append({
        "step_kind": "compose",
        "ts": time.perf_counter(),
        "tokens_in": resp["usage"]["input_tokens"],
        "tokens_out": resp["usage"]["output_tokens"],
    })

    # 4. Assemble final envelope.
    full_audit = list(state.get("audit_trail") or []) + audit
    usage = UsageMetrics(
        tokens_in=sum(int(e.get("tokens_in", 0) or 0) for e in full_audit),
        tokens_out=sum(int(e.get("tokens_out", 0) or 0) for e in full_audit),
        est_cost_usd=estimate_cost_usd(full_audit),
    )

    # `partial` is set when the turn could not fully resolve: the replan cap was
    # exhausted (replan_count reached MAX_REPLANS), the replan node explicitly
    # forced a compose on overflow (issues #53/#54), or the per-turn token budget
    # ran out (issue #42). All three replan thresholds (route_after_dispatch,
    # replan_node, here) align on MAX_REPLANS.
    partial = bool(
        state.get("force_compose")
        or int(state.get("replan_count", 0) or 0) >= MAX_REPLANS
        or per_turn_cap_exceeded(full_audit)
    )

    envelope: ChatMessageEnvelope = ChatMessageEnvelope(
        response=response_text,
        plan=list(state.get("plan") or []),
        findings=findings,
        causal=causal,
        audit_trail=full_audit,
        citations=citations,
        usage=usage,
        partial=partial,
    )

    return {"final": envelope, "audit_trail": audit}
