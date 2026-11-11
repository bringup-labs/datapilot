"""
Typed state contracts for the Phase 4 multi-agent orchestration graph.

Shapes match `docs/implementation.md` §4.1 (GraphState), §4.8 (AuditEvent), and
the chat envelope from §4.10. Keep these in sync with `app.schemas` — the API
layer serializes these to Pydantic models for the wire.
"""
from __future__ import annotations

import operator
from typing import Annotated, Any, Literal, NotRequired, TypedDict

# ── Plan + specialist results ──────────────────────────────────────────────

SpecialistName = Literal[
    "RootCauseAnalyst",
    "AnomalyDetector",
    "PerformanceProfiler",
    "ReplayNarrator",
    "SafetyAuditor",
    "ReleaseComparator",
]


class SpecStep(TypedDict):
    """One specialist invocation in the supervisor's plan."""
    idx: int
    specialist: SpecialistName
    intent: str
    done: NotRequired[bool]
    label: NotRequired[str]


class Finding(TypedDict):
    """An evidence-backed conclusion. Every finding must cite ≥1 log_id."""
    sev: Literal["critical", "warning", "info", "success"]
    text: str
    detail: NotRequired[str]
    log_ids: list[str]


class CausalStep(TypedDict):
    """One link in the causal chain rendered as the tree-character form."""
    label: str
    log_id: NotRequired[str]
    edge_in: NotRequired[str | None]    # "CAUSED" | "TRIGGERED" | None
    edge_out: NotRequired[str | None]


class Citation(TypedDict):
    """A pointer back to a single Log node in Neo4j."""
    log_id: str
    ts: float
    node: str
    snippet: str


class SpecResult(TypedDict, total=False):
    """Whatever the specialist surfaces back to the supervisor / composer."""
    specialist: SpecialistName
    findings: list[Finding]
    causal: list[CausalStep]
    anomalies: list[dict[str, Any]]
    regressions: list[dict[str, Any]]
    narration: list[dict[str, Any]]
    violations: list[dict[str, Any]]
    diffs: list[dict[str, Any]]
    confidence: float
    error: NotRequired[str]
    tool_calls: NotRequired[list[dict[str, Any]]]


# ── Audit trail ───────────────────────────────────────────────────────────

AuditStepKind = Literal[
    "supervisor_plan",
    "specialist_start",
    "tool_call",
    "tool_result",
    "replan",
    "compose",
    "error",
    "external_agent",
]


class AuditEvent(TypedDict, total=False):
    step_kind: AuditStepKind
    specialist: str | None
    tool: str | None
    args_summary: str       # truncated to 200 chars
    result_summary: str     # truncated to 400 chars
    tokens_in: int
    tokens_out: int
    latency_ms: int
    ts: float


# ── Transcript / memory ───────────────────────────────────────────────────


class Turn(TypedDict):
    """Single user↔assistant exchange in a session."""
    role: Literal["user", "assistant"]
    content: str
    ts: float
    findings: NotRequired[list[Finding]]
    causal: NotRequired[list[CausalStep]]


# ── Final envelope (response body) ────────────────────────────────────────


class UsageMetrics(TypedDict):
    tokens_in: int
    tokens_out: int
    est_cost_usd: float


class ChatMessageEnvelope(TypedDict, total=False):
    """Maps 1:1 onto `mock_design/copilot.jsx` ChatMessage."""
    response: str
    plan: list[SpecStep]
    findings: list[Finding]
    causal: list[CausalStep]
    audit_trail: list[AuditEvent]
    citations: list[Citation]
    usage: UsageMetrics
    partial: bool


# ── Top-level graph state ─────────────────────────────────────────────────


class GraphState(TypedDict, total=False):
    """
    Mutable state threaded through the LangGraph nodes.

    Reducer choices:
      - `audit_trail` and `retrieval_context` are append-only (operator.add).
      - `transcript` is also append-only per turn.
      - Everything else is overwrite-on-update.
    """
    session_id: str
    user_message: str
    session_summary: str                                         # cached metadata for prompts
    transcript: list[Turn]                                       # full history
    composer_model: str | None
    plan: list[SpecStep]
    plan_idx: int                                                # current step pointer
    specialist_outputs: dict[str, SpecResult]
    retrieval_context: Annotated[list[Citation], operator.add]
    replan_count: int                                            # cap = MAX_REPLANS
    force_compose: bool                                          # replan overflow → partial compose
    audit_trail: Annotated[list[AuditEvent], operator.add]
    token_budget_remaining: int
    final: ChatMessageEnvelope | None


# ── Constants ─────────────────────────────────────────────────────────────

MAX_REPLANS = 5
PER_TURN_TOKEN_CAP = 25_000
PER_SESSION_TOKEN_CAP = 200_000
TRANSCRIPT_COMPACT_THRESHOLD = 40_000
