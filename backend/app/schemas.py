from pydantic import BaseModel, Field, field_validator
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime

# Upper bound on a single chat message. Bounding this stops oversized payloads
# from reaching the LLM (and the prompt log) and blowing the token budget
# before any retrieval happens (issue #67).
MAX_MESSAGE_CHARS = 32_000

# Providers the renderer may request for the composer. Constraining this to a
# known set keeps invalid values out of routing (issue #67).
ComposerProvider = Literal["anthropic", "openai", "gemini", "google", "ollama", "nvidia"]

class SessionCreate(BaseModel):
    filepath: str = Field(..., min_length=1)

    @field_validator("filepath")
    @classmethod
    def _filepath_not_blank(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("filepath must not be blank")
        return v

class SessionResponse(BaseModel):
    id: str
    filename: str
    filepath: str
    robot_name: Optional[str] = None
    ros_version: Optional[str] = None
    duration_seconds: Optional[float] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    total_messages: Optional[int] = None
    topics_list: Optional[List[str]] = None
    status: str
    error_message: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class TimelineEvent(BaseModel):
    t: float
    type: str  # 'log', 'sensor', 'anomaly'
    sev: str  # 'info', 'warning', 'critical'
    topic: str
    label: str

class TopicInfo(BaseModel):
    name: str
    hz: float
    type: str
    msgs: int

class LogItem(BaseModel):
    t: str  # formatted timestamp
    node: str
    sev: str
    text: str
    id: Optional[str] = None

class KGraphNode(BaseModel):
    id: str
    label: str
    group: str  # 'sensor', 'topic', 'fault', 'state', 'node', 'outcome', 'fact'
    x: float
    y: float
    meta: Dict[str, Any] = {}

class KGraphResponse(BaseModel):
    nodes: List[KGraphNode]
    edges: List[List[str]]  # List of [source_id, target_id]

class ReplayFrame(BaseModel):
    t: float
    pose: Optional[Dict[str, float]] = None  # {x, y, yaw}
    tf: Optional[List[Dict[str, Any]]] = None
    cmd_vel: Optional[Dict[str, float]] = None  # {linear, angular}

class ReplayResponse(BaseModel):
    frames: List[ReplayFrame]


class AnomalyItem(BaseModel):
    """
    Anomalies surfaced during ingestion. Phase 3 seeds these from timeline_events
    where `type == 'anomaly'`. Phase 5 (AnomalyDetector worker) will write richer
    entries with statistical/signature `kind` values.
    """
    id: str
    t: float                  # seconds from session start
    kind: str                 # topic name today; 'dropout'|'outlier'|'signature' in Phase 5
    severity: str             # 'critical' | 'warning' | 'info'
    source_log_id: Optional[str] = None
    confidence: float = 1.0
    topic: Optional[str] = None
    label: Optional[str] = None


# ── Phase 4: Chat (agent orchestration) ─────────────────────────────────────


class ChatRequest(BaseModel):
    """Body of POST /api/sessions/{id}/chat."""
    message: str = Field(..., min_length=1, max_length=MAX_MESSAGE_CHARS)
    composer_provider: Optional[ComposerProvider] = None
    composer_model: Optional[str] = None      # model id (overrides defaults)


class Finding(BaseModel):
    sev: str                  # 'critical' | 'warning' | 'info' | 'success'
    text: str
    detail: Optional[str] = None
    log_ids: List[str]


class CausalStep(BaseModel):
    label: str
    log_id: Optional[str] = None
    edge_in: Optional[str] = None
    edge_out: Optional[str] = None


class Citation(BaseModel):
    log_id: str
    ts: float
    node: str
    snippet: str


class AuditEvent(BaseModel):
    step_kind: str            # 'supervisor_plan' | 'specialist_start' | 'tool_call' | …
    specialist: Optional[str] = None
    tool: Optional[str] = None
    args_summary: Optional[str] = None
    result_summary: Optional[str] = None
    tokens_in: Optional[int] = 0
    tokens_out: Optional[int] = 0
    latency_ms: Optional[int] = 0
    ts: Optional[float] = None


class UsageMetrics(BaseModel):
    tokens_in: int
    tokens_out: int
    est_cost_usd: float


class ChatMessageEnvelope(BaseModel):
    """The terminal SSE `final` event payload."""
    response: str
    plan: List[Dict[str, Any]] = Field(default_factory=list)
    findings: List[Finding] = Field(default_factory=list)
    causal: List[CausalStep] = Field(default_factory=list)
    audit_trail: List[AuditEvent] = Field(default_factory=list)
    citations: List[Citation] = Field(default_factory=list)
    usage: Optional[UsageMetrics] = None
    partial: bool = False


class AgentTurnUsage(BaseModel):
    tokens_in: int = Field(0, ge=0)
    tokens_out: int = Field(0, ge=0)
    est_cost_usd: float = Field(0, ge=0)


class AgentTurnStep(BaseModel):
    tool: str = Field(..., max_length=100)
    label: str = Field(..., max_length=300)


class AgentTurnComplete(BaseModel):
    """Electron main's report that a Claude Code turn has ended."""
    question: str = Field(..., min_length=1, max_length=MAX_MESSAGE_CHARS)
    response: str = Field("", max_length=100_000)
    model: str = Field("", max_length=200)
    auth_method: Literal["claude.ai", "oauth_token", "api_key", "api_key_helper", "third_party", "none"]
    usage: AgentTurnUsage
    steps: List[AgentTurnStep] = Field(default_factory=list, max_length=200)
    status: Literal["completed", "stopped", "failed"]
