import { describe, it, expect } from "vitest";
import type { ChatHistoryRow } from "@renderer/services/api";
import type { ClaudeCodeErrorCode } from "@shared/ipc";
import type { ChatNextStep } from "@shared/types";
import {
  claudeCodeFields,
  messageFromHistoryRow,
  nextStepsFor,
  toCausalItems,
  toFindings,
  toPlanSteps,
} from "./chatMapping";

describe("chatMapping", () => {
  it("reads causal steps given as label objects or strings", () => {
    expect(toCausalItems([{ label: "a", log_id: "s:l_1" }, "b", {}])).toEqual([
      { text: "a" },
      { text: "b" },
    ]);
    expect(toCausalItems([{ text: "lidar dropout" }])).toEqual([{ text: "lidar dropout" }]);
    expect(toCausalItems([])).toBeUndefined();
    expect(toCausalItems(null)).toBeUndefined();
  });

  it("keeps cited log IDs and folds unknown severities into info", () => {
    expect(toFindings([{ sev: "success", text: "ok", log_ids: ["s:l_1"] }])).toEqual([
      { sev: "info", text: "ok", logIds: ["s:l_1"] },
    ]);
    expect(
      toFindings([{ sev: "warning", text: "slow scan", detail: "12 Hz", log_ids: [] }]),
    ).toEqual([{ sev: "warning", text: "slow scan", detail: "12 Hz" }]);
    expect(toFindings([])).toBeUndefined();
    expect(toFindings(undefined)).toBeUndefined();
  });

  it("marks reloaded steps done", () => {
    expect(
      toPlanSteps(
        [{ label: "Find aborts", tool: "find_aborts" }, { specialist: "RootCauseAnalyst" }],
        true,
      ),
    ).toEqual([
      { label: "Find aborts", done: true, active: false },
      { label: "RootCauseAnalyst", done: true, active: false },
    ]);
    expect(toPlanSteps([{}], false)).toEqual([{ label: "step", done: false, active: false }]);
    expect(toPlanSteps([], true)).toBeUndefined();
  });

  it("keeps the Claude Code label, verification and usage after reload", () => {
    const row: ChatHistoryRow = {
      role: "assistant",
      content: "Planner aborted.",
      created_at: "2026-11-10T10:00:00",
      findings: [{ sev: "critical", text: "abort", log_ids: ["sess-1:l_8"] }],
      causal: [{ label: "lidar dropout", log_id: "sess-1:l_3" }],
      plan: [{ label: "Find aborts", tool: "find_aborts" }],
      answered_by: "claude_code",
      verified: false,
      flagged_log_ids: ["l_999"],
      claude_code_usage: {
        model: "claude-sonnet-4-5",
        auth_method: "claude.ai",
        tool_calls: 1,
        est_cost_usd: 0.0123,
      },
    };

    expect(messageFromHistoryRow(row, 3)).toEqual({
      id: "hist-3",
      role: "assistant",
      summary: "Planner aborted.",
      findings: [{ sev: "critical", text: "abort", logIds: ["sess-1:l_8"] }],
      causal: [{ text: "lidar dropout" }],
      plan: [{ label: "Find aborts", done: true, active: false }],
      answeredBy: "claude_code",
      verified: false,
      flaggedLogIds: ["l_999"],
      claudeCodeUsage: {
        model: "claude-sonnet-4-5",
        authMethod: "claude.ai",
        toolCalls: 1,
        estCostUsd: 0.0123,
      },
    });
  });

  it("reloads questions and DataPilot's answers without Claude Code fields", () => {
    const question: ChatHistoryRow = {
      role: "user",
      content: "why?",
      created_at: null,
      findings: null,
      causal: null,
      plan: null,
      answered_by: null,
      verified: null,
      flagged_log_ids: [],
      claude_code_usage: null,
    };
    const answer: ChatHistoryRow = {
      ...question,
      role: "assistant",
      content: "The lidar dropped out.",
      findings: [{ sev: "critical", text: "lidar dropout", log_ids: ["sess-1:l_2"] }],
      causal: [{ label: "lidar dropout", log_id: "sess-1:l_2", edge_out: "CAUSED" }],
      plan: [{ idx: 0, specialist: "RootCauseAnalyst", intent: "trace the stop" }],
      answered_by: "datapilot",
    };

    expect(messageFromHistoryRow(question, 0)).toEqual({
      id: "hist-0",
      role: "user",
      text: "why?",
    });
    expect(messageFromHistoryRow(answer, 1)).toEqual({
      id: "hist-1",
      role: "assistant",
      summary: "The lidar dropped out.",
      findings: [{ sev: "critical", text: "lidar dropout", logIds: ["sess-1:l_2"] }],
      causal: [{ text: "lidar dropout" }],
      plan: [{ label: "RootCauseAnalyst", done: true, active: false }],
    });
    expect(claudeCodeFields({ answered_by: "datapilot", verified: null })).toEqual({});
  });

  it.each<[ClaudeCodeErrorCode, ChatNextStep[]]>([
    ["not_installed", ["open_settings"]],
    ["too_old", ["open_settings"]],
    ["signed_out", ["sign_in"]],
    ["usage_limit", ["use_datapilot"]],
    ["api_key_rejected", ["open_settings"]],
    ["tools_unreachable", ["retry", "open_agents"]],
    ["no_bag", ["use_datapilot"]],
    ["failed", ["retry"]],
  ])("offers next steps for %s", (code, steps) => {
    expect(nextStepsFor(code)).toEqual(steps);
  });
});
