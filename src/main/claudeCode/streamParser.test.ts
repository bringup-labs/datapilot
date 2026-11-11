// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { ClaudeAuthMethod } from "../../shared/ipc";
import { createStreamParser, stepLabel } from "./streamParser";

const lines = (name: string) =>
  fs.readFileSync(`src/test/claude-code/streams/${name}.jsonl`, "utf-8").split("\n");
const parse = (name: string, authMethod: ClaudeAuthMethod = "claude.ai") => {
  const parser = createStreamParser({ authMethod });
  return lines(name).flatMap((line) => parser.feed(line));
};
const failure = (name: string, m: ClaudeAuthMethod) =>
  parse(name, m).find((e) => e.kind === "failure");

describe("stream parser", () => {
  it("turns a successful run into init, three steps and a result", () => {
    const ev = parse("success");
    expect(ev[0]).toEqual({ kind: "init", datapilotConnected: true, model: "claude-sonnet-4-5-20250929" });
    expect(ev.filter((e) => e.kind === "tool-start").map((e) => (e as { label: string }).label)).toEqual([
      "Get bag overview",
      "Retrieve logs · planner abort",
      "Submit findings",
    ]);
    expect(ev.filter((e) => e.kind === "tool-done")).toEqual(
      [0, 1, 2].map((idx) => ({ kind: "tool-done", idx, isError: false })),
    );
    expect(ev.at(-1)).toEqual({
      kind: "result",
      subtype: "success",
      isError: false,
      text: "The planner aborted after the lidar dropped out (l_8).",
      costUsd: 0.0123,
      tokensIn: 1500,
      tokensOut: 200,
    });
  });

  it("marks a step whose tool failed", () => {
    expect(parse("tool-error").find((e) => e.kind === "tool-done")).toEqual({
      kind: "tool-done",
      idx: 0,
      isError: true,
    });
  });

  it("notices when DataPilot's tool server did not connect", () => {
    expect(parse("no-mcp")).toEqual([{ kind: "init", datapilotConnected: false, model: null }]);
  });

  it("counts a pending server as connected, since it connects on the first tool call", () => {
    const init = (mcp_servers: unknown[]) =>
      createStreamParser({ authMethod: "claude.ai" }).feed(JSON.stringify({ type: "system", subtype: "init", mcp_servers }));
    expect(init([{ name: "datapilot", status: "pending" }])).toEqual([{ kind: "init", datapilotConnected: true, model: null }]);
    for (const servers of [[], [{ name: "datapilot", status: "needs-auth" }], [{ name: "other", status: "pending" }]]) {
      expect(init(servers)).toEqual([{ kind: "init", datapilotConnected: false, model: null }]);
    }
  });

  it("tells a lost sign-in from a rejected API key", () => {
    expect(failure("signed-out", "claude.ai")).toEqual({ kind: "failure", code: "signed_out" });
    expect(failure("signed-out", "api_key")).toEqual({ kind: "failure", code: "api_key_rejected" });
    expect(failure("signed-out", "api_key_helper")).toEqual({ kind: "failure", code: "api_key_rejected" });
    expect(failure("signed-out", "third_party")).toEqual({ kind: "failure", code: "signed_out" });
  });

  it("reports the plan's usage limit with its reset time", () => {
    expect(parse("usage-limit").find((e) => e.kind === "failure")).toEqual({
      kind: "failure",
      code: "usage_limit",
      resetsAt: 1767297600,
    });
  });

  it("reports an error_max_turns result as an errored result", () => {
    expect(parse("max-turns").at(-1)).toMatchObject({ kind: "result", subtype: "error_max_turns", isError: true, text: "" });
  });

  it("treats a credits_required rejection as an API key problem", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", errorCode: "credits_required" },
    });
    expect(createStreamParser({ authMethod: "api_key" }).feed(line)).toEqual([
      { kind: "failure", code: "api_key_rejected" },
    ]);
  });

  it("ignores non-JSON lines, unknown types and other servers' tools", () => {
    const p = createStreamParser({ authMethod: "claude.ai" });
    expect(
      [
        "not json",
        "",
        "[1]",
        '{"type":"mystery"}',
        '{"type":"system","subtype":"api_retry","attempt":1}',
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } }),
      ].flatMap((l) => p.feed(l)),
    ).toEqual([]);
  });

  it("maps each assistant error category", () => {
    const run = (error: string, authMethod: ClaudeAuthMethod) =>
      createStreamParser({ authMethod }).feed(JSON.stringify({ type: "assistant", error, message: { content: [] } }));
    expect(run("rate_limit", "claude.ai")).toEqual([{ kind: "failure", code: "usage_limit" }]);
    expect(run("billing_error", "claude.ai")).toEqual([{ kind: "failure", code: "usage_limit" }]);
    expect(run("billing_error", "api_key")).toEqual([{ kind: "failure", code: "api_key_rejected" }]);
    expect(run("cloud_credential_error", "api_key")).toEqual([{ kind: "failure", code: "signed_out" }]);
    expect(run("server_error", "claude.ai")).toEqual([{ kind: "failure", code: "failed" }]);
  });

  it("rejects without a reset time when none is given", () => {
    const line = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } });
    expect(createStreamParser({ authMethod: "claude.ai" }).feed(line)).toEqual([{ kind: "failure", code: "usage_limit" }]);
    const ok = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } });
    expect(createStreamParser({ authMethod: "claude.ai" }).feed(ok)).toEqual([]);
  });
});

describe("stepLabel", () => {
  it.each([
    ["get_bag_overview", {}, "Get bag overview"],
    ["query_causal_chain", { event_log_id: "s:l_8" }, "Query causal chain · s:l_8"],
    ["find_dropouts", {}, "Find dropouts"],
    ["find_dropouts", { topic: "/scan" }, "Find dropouts · /scan"],
    ["compute_node_cpu", { node: "/planner" }, "Compute node cpu · /planner"],
    ["read_tf_chain", {}, "Read tf chain"],
    ["retrieve_logs", { query: "x".repeat(80) }, `Retrieve logs · ${"x".repeat(59)}…`],
  ] as [string, Record<string, unknown>, string][])("labels %s", (tool, input, label) =>
    expect(stepLabel(tool, input)).toBe(label),
  );
});
