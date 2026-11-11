import type { ClaudeAuthMethod, ClaudeCodeModel } from "@shared/ipc";
import type { ChatNextStep, ClaudeCodeUsage } from "@shared/types";

/** Display name for a Claude Code model alias or full model ID. */
export function modelDisplayName(model: string): string {
  if (model === "") return "Claude Code's default";
  const m = model.toLowerCase();
  if (m.includes("sonnet")) return "Sonnet";
  if (m.includes("opus")) return "Opus";
  if (m.includes("haiku")) return "Haiku";
  return model;
}

export function signedInLabel(method: ClaudeAuthMethod): string {
  switch (method) {
    case "claude.ai":
    case "oauth_token":
      return "Signed in with your Claude plan";
    case "api_key":
    case "api_key_helper":
      return "Using an API key (billed to that key)";
    case "third_party":
      return "Using your cloud provider";
    default:
      return "Signed in";
  }
}

/** Who pays for the answers. */
export function billingLabel(method: ClaudeAuthMethod): string {
  switch (method) {
    case "claude.ai":
    case "oauth_token":
      return "your Claude plan";
    case "api_key":
    case "api_key_helper":
      return "your API key";
    case "third_party":
      return "your cloud provider";
    default:
      return "your Claude account";
  }
}

export function toolsLabel(n: number): string {
  return `${n} ${n === 1 ? "tool" : "tools"} for the open bag, on this computer`;
}

export const CLAUDE_CODE_MODEL_OPTIONS: ReadonlyArray<{
  value: ClaudeCodeModel;
  label: string;
}> = [
  { value: "", label: "Claude Code's default" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];

/** The usage line shown under a Claude Code answer. */
export function formatClaudeCodeUsage(u: ClaudeCodeUsage): string {
  const n = u.toolCalls;
  const head = `Claude Code · ${modelDisplayName(u.model)} · ${n} tool call${n === 1 ? "" : "s"} · `;
  const plan = u.authMethod === "claude.ai" || u.authMethod === "oauth_token";
  return (
    head +
    (plan ? "counted against your Claude plan" : `est. $${u.estCostUsd.toFixed(4)}`)
  );
}

export const NEXT_STEP_LABELS: Record<ChatNextStep, string> = {
  open_settings: "Open Settings",
  sign_in: "Sign in with Claude Code",
  use_datapilot: "Answer with DataPilot's agents",
  retry: "Retry",
  open_agents: "Open Agents & MCP",
};
