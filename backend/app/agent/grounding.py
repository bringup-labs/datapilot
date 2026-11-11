"""Citation grounding for findings submitted by Claude Code.

Applies the composer's keep/drop rule (``_filter_uncited``) and reports why
each rejected item was rejected.
"""
from __future__ import annotations

import re
from typing import Any, TypedDict

from app.agent.composer import _filter_uncited, _resolve_citations
from app.agent.state import CausalStep, Citation, Finding

_BARE_LOG_ID = re.compile(r"^l_\d+$")


class GroundingResult(TypedDict):
    findings: list[Finding]
    rejected: list[dict[str, Any]]
    causal: list[CausalStep]
    causal_rejected: list[dict[str, Any]]
    citations: list[Citation]


def normalize_log_id(session_id: str, log_id: str) -> str:
    """Scope a bare ``l_<digits>`` ID to the session; leave anything else alone."""
    return f"{session_id}:{log_id}" if _BARE_LOG_ID.match(log_id) else log_id


def check_findings(session_id: str, findings: list[dict], causal: list[dict]) -> GroundingResult:
    normalized: list[dict] = []
    for f in findings:
        ids = list(dict.fromkeys(normalize_log_id(session_id, i) for i in (f.get("log_ids") or [])))
        normalized.append({**f, "log_ids": ids})
    steps: list[dict] = []
    for s in causal:
        step = dict(s)
        if step.get("log_id"):
            step["log_id"] = normalize_log_id(session_id, step["log_id"])
        steps.append(step)

    all_ids = [i for f in normalized for i in f["log_ids"]] + [s["log_id"] for s in steps if s.get("log_id")]
    all_ids = list(dict.fromkeys(all_ids))
    citations = _resolve_citations(session_id, [{"log_ids": all_ids}]) if all_ids else []
    valid = {c["log_id"] for c in citations}

    kept, _ = _filter_uncited(normalized, valid)
    kept_ids = {id(f) for f in kept}
    rejected: list[dict[str, Any]] = []
    for index, f in enumerate(normalized):
        if id(f) in kept_ids:
            continue
        if f["log_ids"]:
            reason = f"None of its log IDs exist in this bag: {', '.join(f['log_ids'])}."
        else:
            reason = "Critical and warning findings need at least one log ID from a tool result."
        rejected.append({"index": index, "text": f.get("text", ""), "reason": reason})

    kept_steps: list[dict] = []
    causal_rejected: list[dict[str, Any]] = []
    for index, s in enumerate(steps):
        lid = s.get("log_id")
        if not lid or lid in valid:
            kept_steps.append(s)
        else:
            causal_rejected.append(
                {"index": index, "label": s.get("label", ""), "reason": f"Log ID {lid} doesn't exist in this bag."}
            )

    cited = {i for f in kept for i in f["log_ids"]} | {s["log_id"] for s in kept_steps if s.get("log_id")}
    return GroundingResult(
        findings=kept,
        rejected=rejected,
        causal=kept_steps,
        causal_rejected=causal_rejected,
        citations=[c for c in citations if c["log_id"] in cited],
    )


# A hyphen may come right before a mention, as in the range "l_12-l_15". A
# prefixed ID such as "other-bag:l_5" still matches whole, prefix included.
_LOG_ID_MENTION = re.compile(r"(?<![\w:])(?:([\w-]+):)?(l_\d+)\b")


def find_unknown_log_ids(session_id: str, text: str) -> list[str]:
    """Log IDs mentioned in free text that don't resolve in this bag, as written."""
    mentions: dict[str, str] = {}  # raw mention -> full ID, first-seen order
    for m in _LOG_ID_MENTION.finditer(text or ""):
        prefix, lid = m.group(1), m.group(2)
        mentions.setdefault(m.group(0), f"{prefix}:{lid}" if prefix else f"{session_id}:{lid}")
    if not mentions:
        return []
    found = {c["log_id"] for c in _resolve_citations(session_id, [{"log_ids": sorted(set(mentions.values()))}])}
    return [raw for raw, full in mentions.items() if full not in found]
