import type { ChatHistoryRow } from "@renderer/services/api";
import type { ClaudeAuthMethod, ClaudeCodeErrorCode } from "@shared/ipc";
import type { CausalItem, ChatMessage, ChatNextStep, Finding, PlanStep } from "@shared/types";

// Maps the backend's snake_case answers (a live `final` event or a saved
// message) into chat messages. Every input is untrusted JSON, so each reader
// takes `unknown` and skips what it can't use.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const SEVERITIES: ReadonlyArray<Finding["sev"]> = ["critical", "warning", "info"];

/** Findings, with any other severity (DataPilot's "success", say) shown as info. */
export function toFindings(raw: unknown): Finding[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const findings = raw.filter(isRecord).map((f): Finding => {
    const sev = SEVERITIES.find((s) => s === f.sev) ?? "info";
    const detail = asString(f.detail);
    const logIds = asStrings(f.log_ids);
    return {
      sev,
      text: asString(f.text) ?? "",
      ...(detail !== undefined ? { detail } : {}),
      ...(logIds.length > 0 ? { logIds } : {}),
    };
  });
  return findings.length > 0 ? findings : undefined;
}

/** Causal steps given as `{text}`, `{label}` (the backend's own shape) or plain strings. */
export function toCausalItems(raw: unknown): CausalItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .map((c) =>
      typeof c === "string" ? c : isRecord(c) ? asString(c.text) || asString(c.label) || "" : "",
    )
    .filter((text) => text.trim() !== "")
    .map((text) => ({ text }));
  return items.length > 0 ? items : undefined;
}

/** Plan steps from DataPilot's specialists or Claude Code's tool calls. */
export function toPlanSteps(raw: unknown, done: boolean): PlanStep[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((s) => {
    const step: Record<string, unknown> = isRecord(s) ? s : {};
    return {
      label: asString(step.label) ?? asString(step.specialist) ?? "step",
      done,
      active: false,
    };
  });
}

/** The Claude Code label, verification and usage of an answer; nothing for DataPilot's. */
export function claudeCodeFields(
  raw: Record<string, unknown>,
): Pick<ChatMessage, "answeredBy" | "verified" | "flaggedLogIds" | "claudeCodeUsage"> {
  if (raw.answered_by !== "claude_code") return {};
  const flagged = asStrings(raw.flagged_log_ids);
  const usage = isRecord(raw.claude_code_usage) ? raw.claude_code_usage : null;
  return {
    answeredBy: "claude_code",
    verified: typeof raw.verified === "boolean" ? raw.verified : undefined,
    flaggedLogIds: flagged.length > 0 ? flagged : undefined,
    claudeCodeUsage: usage
      ? {
          model: asString(usage.model) ?? "",
          authMethod: (asString(usage.auth_method) ?? "none") as ClaudeAuthMethod,
          toolCalls: asNumber(usage.tool_calls) ?? 0,
          estCostUsd: asNumber(usage.est_cost_usd) ?? 0,
        }
      : undefined,
  };
}

/** A reloaded chat message. The caller adds its display time. */
export function messageFromHistoryRow(row: ChatHistoryRow, index: number): ChatMessage {
  const assistant = row.role === "assistant";
  return {
    id: `hist-${index}`,
    role: row.role as "user" | "assistant",
    text: assistant ? undefined : row.content,
    summary: assistant ? row.content : undefined,
    findings: toFindings(row.findings),
    causal: toCausalItems(row.causal),
    plan: toPlanSteps(row.plan, true),
    // The copy is a plain object type, which a Record parameter accepts; the interface isn't.
    ...claudeCodeFields({ ...row }),
  };
}

const NEXT_STEPS: Record<ClaudeCodeErrorCode, ChatNextStep[]> = {
  not_installed: ["open_settings"],
  too_old: ["open_settings"],
  signed_out: ["sign_in"],
  usage_limit: ["use_datapilot"],
  api_key_rejected: ["open_settings"],
  tools_unreachable: ["retry", "open_agents"],
  no_bag: ["use_datapilot"],
  failed: ["retry"],
};

/** The buttons offered under a Claude Code error. */
export function nextStepsFor(code: ClaudeCodeErrorCode): ChatNextStep[] {
  return [...(NEXT_STEPS[code] ?? NEXT_STEPS.failed)];
}
