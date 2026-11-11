import { describe, it, expect, afterEach, vi } from "vitest";
import type {
  ClaudeCodeAskRequest,
  ClaudeCodeChatEvent,
  ClaudeCodeFinal,
} from "@shared/ipc";
import { streamClaudeCode } from "./claudeCode";

const REQUEST: ClaudeCodeAskRequest = { sessionId: "sess-1", question: "why?", model: "sonnet" };

const FINAL: ClaudeCodeFinal = {
  response: "Planner aborted.",
  findings: [],
  causal: [],
  plan: [{ label: "Find aborts", tool: "find_aborts" }],
  usage: { tokens_in: 1500, tokens_out: 200, est_cost_usd: 0.0123 },
  partial: false,
  answered_by: "claude_code",
  verified: true,
  flagged_log_ids: [],
  claude_code_usage: {
    model: "claude-sonnet-4-5",
    auth_method: "claude.ai",
    tool_calls: 1,
    est_cost_usd: 0.0123,
  },
};

const FAILED = { code: "failed", message: "Claude Code couldn't finish this answer" };

/** Installs a preload bridge whose `ask` the test starts, refuses and feeds events. */
function installBridge() {
  let listener: ((e: ClaudeCodeChatEvent) => void) | null = null;
  let settle!: {
    resolve: (stop: () => Promise<void>) => void;
    reject: (err: Error) => void;
  };
  const ask = vi.fn(
    (_request: ClaudeCodeAskRequest, onEvent: (e: ClaudeCodeChatEvent) => void) => {
      listener = onEvent;
      return new Promise<() => Promise<void>>((resolve, reject) => {
        settle = { resolve, reject };
      });
    },
  );
  (window as unknown as { datapilot: unknown }).datapilot = { claudeCode: { ask } };
  return {
    ask,
    emit: (e: ClaudeCodeChatEvent) => listener?.(e),
    started: (stop: () => Promise<void>) => settle.resolve(stop),
    refused: (err: Error) => settle.reject(err),
  };
}

/** Lets the bridge's promise callbacks run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("streamClaudeCode", () => {
  afterEach(() => {
    delete (window as unknown as { datapilot?: unknown }).datapilot;
  });

  it("forwards Claude Code's events to the chat handler and unsubscribes after final", async () => {
    const bridge = installBridge();
    const stop = vi.fn().mockResolvedValue(undefined);
    const onEvent = vi.fn();

    streamClaudeCode(REQUEST, onEvent);
    expect(bridge.ask).toHaveBeenCalledWith(REQUEST, expect.any(Function));
    bridge.started(stop);
    await flush();

    bridge.emit({ event: "step-add", data: { label: "Find aborts" } });
    bridge.emit({ event: "step-done", data: { idx: 0 } });
    expect(stop).not.toHaveBeenCalled();
    bridge.emit({ event: "final", data: FINAL });

    expect(onEvent.mock.calls).toEqual([
      ["step-add", { label: "Find aborts" }],
      ["step-done", { idx: 0 }],
      ["final", FINAL],
    ]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes after an error that arrives before the run has started", async () => {
    const bridge = installBridge();
    const stop = vi.fn().mockResolvedValue(undefined);
    const onEvent = vi.fn();

    streamClaudeCode(REQUEST, onEvent);
    bridge.emit({ event: "error", data: { code: "signed_out", message: "Claude Code isn't signed in" } });
    bridge.started(stop);
    await flush();

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith("error", {
      code: "signed_out",
      message: "Claude Code isn't signed in",
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops a run that was aborted before it started", async () => {
    const bridge = installBridge();
    const stop = vi.fn().mockResolvedValue(undefined);
    const onEvent = vi.fn();

    const run = streamClaudeCode(REQUEST, onEvent);
    run.abort();
    bridge.emit({ event: "step-add", data: { label: "Find aborts" } });
    expect(stop).not.toHaveBeenCalled();

    bridge.started(stop);
    await flush();
    run.abort();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("reports an error when the preload bridge is missing", () => {
    const onEvent = vi.fn();

    const run = streamClaudeCode(REQUEST, onEvent);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith("error", FAILED);
    expect(() => run.abort()).not.toThrow();
  });

  it("reports an error when Claude Code can't be asked", async () => {
    const bridge = installBridge();
    const onEvent = vi.fn();

    streamClaudeCode(REQUEST, onEvent);
    bridge.refused(new Error("Invalid Claude Code request"));
    await flush();

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith("error", FAILED);
  });
});
