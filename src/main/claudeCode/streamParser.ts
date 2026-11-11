import type { ClaudeAuthMethod, ClaudeCodeErrorCode } from "../../shared/ipc";

export type ParsedEvent =
  | { kind: "init"; datapilotConnected: boolean; model: string | null }
  | { kind: "tool-start"; idx: number; tool: string; label: string }
  | { kind: "tool-done"; idx: number; isError: boolean }
  | { kind: "failure"; code: ClaudeCodeErrorCode; resetsAt?: number }
  | {
      kind: "result";
      subtype: string;
      isError: boolean;
      text: string;
      costUsd: number;
      tokensIn: number;
      tokensOut: number;
    };

const TOOL_PREFIX = "mcp__datapilot__";
const MAX_ARG = 60;

const MAIN_ARG: Record<string, string> = {
  retrieve_logs: "query",
  query_causal_chain: "event_log_id",
  query_topic: "topic",
  query_topic_rate: "topic",
  find_dropouts: "topic",
  find_statistical_outliers: "topic",
  find_signature_matches: "signature_id",
  compute_node_cpu: "node",
};

export function stepLabel(tool: string, input: Record<string, unknown>): string {
  const words = tool.replace(/_/g, " ");
  const base = words.charAt(0).toUpperCase() + words.slice(1);
  const key = MAIN_ARG[tool];
  const arg = key ? input[key] : undefined;
  if (typeof arg !== "string" || arg === "") return base;
  const shown = arg.length > MAX_ARG ? `${arg.slice(0, MAX_ARG - 1)}…` : arg;
  return `${base} · ${shown}`;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function assistantFailure(category: string, authMethod: ClaudeAuthMethod): ClaudeCodeErrorCode {
  const keyAuth = authMethod === "api_key" || authMethod === "api_key_helper";
  switch (category) {
    case "rate_limit":
      return "usage_limit";
    case "authentication_failed":
      return keyAuth ? "api_key_rejected" : "signed_out";
    case "billing_error":
      return keyAuth ? "api_key_rejected" : "usage_limit";
    case "cloud_credential_error":
      return "signed_out";
    default:
      return "failed";
  }
}

export function createStreamParser(opts: { authMethod: ClaudeAuthMethod }): {
  feed(line: string): ParsedEvent[];
} {
  let nextIdx = 0;
  const stepByToolUseId = new Map<string, number>();

  function feed(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return [];
    }
    if (!isObj(msg)) return [];

    switch (msg.type) {
      case "system": {
        if (msg.subtype !== "init") return [];
        const servers = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
        // "pending": a remote server with a cached tool list connects on its first tool call.
        const datapilotConnected = servers.some(
          (s) => isObj(s) && s.name === "datapilot" && (s.status === "connected" || s.status === "pending"),
        );
        const model = typeof msg.model === "string" ? msg.model : null;
        return [{ kind: "init", datapilotConnected, model }];
      }
      case "assistant": {
        const events: ParsedEvent[] = [];
        const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
        for (const block of content) {
          if (!isObj(block) || block.type !== "tool_use") continue;
          const name = block.name;
          if (typeof name !== "string" || !name.startsWith(TOOL_PREFIX)) continue;
          const idx = nextIdx++;
          if (typeof block.id === "string") stepByToolUseId.set(block.id, idx);
          const tool = name.slice(TOOL_PREFIX.length);
          events.push({
            kind: "tool-start",
            idx,
            tool,
            label: stepLabel(tool, isObj(block.input) ? block.input : {}),
          });
        }
        if (typeof msg.error === "string") {
          events.push({ kind: "failure", code: assistantFailure(msg.error, opts.authMethod) });
        }
        return events;
      }
      case "user": {
        const events: ParsedEvent[] = [];
        const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
        for (const block of content) {
          if (!isObj(block) || block.type !== "tool_result") continue;
          const idx = typeof block.tool_use_id === "string" ? stepByToolUseId.get(block.tool_use_id) : undefined;
          if (idx === undefined) continue;
          events.push({ kind: "tool-done", idx, isError: block.is_error === true });
        }
        return events;
      }
      case "rate_limit_event": {
        const info = msg.rate_limit_info;
        if (!isObj(info) || info.status !== "rejected") return [];
        if (info.errorCode === "credits_required") return [{ kind: "failure", code: "api_key_rejected" }];
        const failure: ParsedEvent = { kind: "failure", code: "usage_limit" };
        if (typeof info.resetsAt === "number") failure.resetsAt = info.resetsAt;
        return [failure];
      }
      case "result": {
        const usage = isObj(msg.usage) ? msg.usage : {};
        return [
          {
            kind: "result",
            subtype: typeof msg.subtype === "string" ? msg.subtype : "",
            isError: msg.is_error === true,
            text: typeof msg.result === "string" ? msg.result : "",
            costUsd: num(msg.total_cost_usd),
            tokensIn:
              num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens),
            tokensOut: num(usage.output_tokens),
          },
        ];
      }
      default:
        return [];
    }
  }

  return { feed };
}
