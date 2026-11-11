import { describe, it, expect } from "vitest";
import {
  modelDisplayName,
  signedInLabel,
  billingLabel,
  toolsLabel,
  CLAUDE_CODE_MODEL_OPTIONS,
  formatClaudeCodeUsage,
  NEXT_STEP_LABELS,
} from "./claudeCodeCopy";
import type { ClaudeAuthMethod } from "@shared/ipc";

describe("claudeCodeCopy", () => {
  it.each([
    ["", "Claude Code's default"],
    ["sonnet", "Sonnet"],
    ["claude-opus-4-1-20250805", "Opus"],
    ["haiku", "Haiku"],
    ["custom-x", "custom-x"],
  ])("names model %s", (m, label) => expect(modelDisplayName(m)).toBe(label));

  it.each([
    ["claude.ai", "Signed in with your Claude plan"],
    ["oauth_token", "Signed in with your Claude plan"],
    ["api_key", "Using an API key (billed to that key)"],
    ["api_key_helper", "Using an API key (billed to that key)"],
    ["third_party", "Using your cloud provider"],
  ])("labels %s", (m, label) =>
    expect(signedInLabel(m as ClaudeAuthMethod)).toBe(label),
  );

  it.each([
    ["claude.ai", "your Claude plan"],
    ["oauth_token", "your Claude plan"],
    ["api_key", "your API key"],
    ["api_key_helper", "your API key"],
    ["third_party", "your cloud provider"],
  ])("bills %s to %s", (m, label) =>
    expect(billingLabel(m as ClaudeAuthMethod)).toBe(label),
  );

  it("counts tools", () => {
    expect(toolsLabel(17)).toBe("17 tools for the open bag, on this computer");
    expect(toolsLabel(1)).toBe("1 tool for the open bag, on this computer");
  });

  it("lists the model options", () => {
    expect(CLAUDE_CODE_MODEL_OPTIONS).toEqual([
      { value: "", label: "Claude Code's default" },
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "haiku", label: "Haiku" },
    ]);
  });
});

describe("formatClaudeCodeUsage", () => {
  const base = { model: "claude-opus-4-1", toolCalls: 1, estCostUsd: 0.5 };
  it("counts plan auth against the plan", () => {
    expect(formatClaudeCodeUsage({ ...base, authMethod: "oauth_token", toolCalls: 3 })).toBe(
      "Claude Code · Opus · 3 tool calls · counted against your Claude plan",
    );
  });
  it("shows an estimate otherwise, singular tool call", () => {
    expect(formatClaudeCodeUsage({ ...base, authMethod: "api_key" })).toBe(
      "Claude Code · Opus · 1 tool call · est. $0.5000",
    );
  });
});

describe("NEXT_STEP_LABELS", () => {
  it("uses the specified copy", () => {
    expect(NEXT_STEP_LABELS).toEqual({
      open_settings: "Open Settings",
      sign_in: "Sign in with Claude Code",
      use_datapilot: "Answer with DataPilot's agents",
      retry: "Retry",
      open_agents: "Open Agents & MCP",
    });
  });
});
