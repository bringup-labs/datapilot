import type { ClaudeAuthMethod } from "./ipc";

/**
 * Domain types shared by stores, services, and components.
 * All serializable — no JSX, no functions.
 */

export type ScreenName = "copilot" | "agents" | "settings";
export type WorkspaceTab = "timeline" | "metrics" | "map" | "logs" | "kgraph";
export type SessionStatus =
  | "idle"
  | "creating"
  | "processing"
  | "ready"
  | "error";

export interface SessionMeta {
  id: string;
  filename: string;
  robot: string;
  durationSeconds: number;
  /** ISO 8601 wall-clock time of the first message in the bag, if known. */
  startTime?: string;
  /** ISO 8601 wall-clock time of the last message in the bag, if known. */
  endTime?: string;
  totalMessages: number;
  topicsCount: number;
  status: SessionStatus;
  updatedAt?: string;
}

export interface TimelineEvent {
  t: number;
  type: "log" | "sensor" | "anomaly";
  sev: "critical" | "warning" | "info";
  topic: string;
  label: string;
}

export interface TopicInfo {
  name: string;
  type: string;
  hz: number;
  msgs: number;
}

export interface LogItem {
  t: string;
  node: string;
  sev: "ERROR" | "WARN" | "INFO" | "DEBUG";
  text: string;
}

export type KGraphGroup =
  | "session"
  | "sensor"
  | "topic"
  | "fault"
  | "state"
  | "node"
  | "outcome"
  | "fact";

export interface KGraphNode {
  id: string;
  label: string;
  group: KGraphGroup;
  /** Optional seed position; the frontend force layout computes final coords. */
  x?: number;
  y?: number;
  /** Per-node detail surfaced on hover (topic type, sensor type, Hz, fact text…). */
  meta?: Record<string, unknown>;
}

export interface KGraphEdge {
  source: string;
  target: string;
}

export interface KGraphData {
  nodes: KGraphNode[];
  edges: KGraphEdge[];
}

export interface PlanStep {
  label: string;
  done: boolean;
  active: boolean;
  outputSummary?: string;
  confidence?: number;
}

export interface Finding {
  sev: "critical" | "warning" | "info";
  text: string;
  detail?: string;
  logIds?: string[];
}

export interface CausalItem {
  text: string;
}

/**
 * ChatAction.iconName is stored as a string key (e.g. 'Clock', 'Graph') —
 * never JSX, because Zustand state must be serializable.
 * Resolve to <Icon[name] size={12} /> at render time in ChatMessage.
 */
export interface ChatAction {
  iconName: string;
  label: string;
  target: WorkspaceTab;
}

export type ChatNextStep =
  | "open_settings"
  | "sign_in"
  | "use_datapilot"
  | "retry"
  | "open_agents";

export interface ClaudeCodeUsage {
  model: string;
  authMethod: ClaudeAuthMethod;
  toolCalls: number;
  estCostUsd: number;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text?: string;
  time?: string;
  summary?: string;
  plan?: PlanStep[];
  findings?: Finding[];
  causal?: CausalItem[];
  actions?: ChatAction[];
  usage?: {
    tokens_in: number;
    tokens_out: number;
    est_cost_usd?: number;
  };
  answeredBy?: "claude_code";
  verified?: boolean;
  flaggedLogIds?: string[];
  claudeCodeUsage?: ClaudeCodeUsage;
  nextSteps?: ChatNextStep[];
  retryQuestion?: string;
}
