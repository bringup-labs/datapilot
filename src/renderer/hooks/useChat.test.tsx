import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ChatEventHandler } from "@renderer/services/api";
import type { ChatMessage } from "@shared/types";
import type { ClaudeCodeAskRequest, ClaudeCodeChatEvent } from "@shared/ipc";

// Mock the REST/SSE client. streamChat is DataPilot's path.
vi.mock("@renderer/services/api", () => ({
  streamChat: vi.fn(),
  getKGraph: vi.fn(),
}));
// Mock the Claude Code transport, the path when Claude Code is the engine.
vi.mock("@renderer/services/claudeCode", () => ({
  streamClaudeCode: vi.fn(),
}));

import * as api from "@renderer/services/api";
import * as claudeCode from "@renderer/services/claudeCode";
import { useChat } from "./useChat";
import { useChatStore } from "@renderer/stores/chat";
import { useSessionStore } from "@renderer/stores/session";
import { useSettingsStore } from "@renderer/stores/settings";

const streamChat = api.streamChat as unknown as Mock;
const getKGraph = api.getKGraph as unknown as Mock;
const streamClaudeCode = claudeCode.streamClaudeCode as unknown as Mock;

/** Pull the onEvent callback that useChat passed into streamChat. */
function lastOnEvent(): ChatEventHandler {
  const call = streamChat.mock.calls.at(-1);
  if (!call) throw new Error("streamChat was not called");
  return call[2] as ChatEventHandler;
}

function resetChatStore() {
  useChatStore.setState({ messages: [], streaming: false, answer: null, sessionId: null });
}

/**
 * The preload's Claude Code bridge: `ask` subscribes the listener and resolves
 * with the function that unsubscribes and stops the run.
 */
function fakeBridge() {
  let listener: ((e: ClaudeCodeChatEvent) => void) | null = null;
  const stopRun = vi.fn(async () => {
    listener = null;
  });
  const ask = vi.fn(
    async (_request: ClaudeCodeAskRequest, onEvent: (e: ClaudeCodeChatEvent) => void) => {
      listener = onEvent;
      return stopRun;
    },
  );
  (window as unknown as { datapilot?: unknown }).datapilot = { claudeCode: { ask } };
  return { ask, stopRun, emit: (e: ClaudeCodeChatEvent) => act(() => listener?.(e)) };
}

function resetSessionStore() {
  useSessionStore.setState({
    pendingPath: null,
    pendingSessionId: null,
    sessionId: null,
    status: "idle",
    meta: null,
    timeline: [],
    topics: [],
    logs: [],
    kgraph: null,
  });
}

describe("useChat", () => {
  let abort: Mock;

  beforeEach(() => {
    resetChatStore();
    resetSessionStore();
    useSettingsStore.setState({ copilotEngine: "datapilot", claudeCodeModel: "" });
    streamChat.mockReset();
    streamClaudeCode.mockReset();
    getKGraph.mockReset();
    getKGraph.mockResolvedValue({ nodes: [], edges: [] });

    abort = vi.fn();
    // Return a stand-in AbortController so abortRef.current.abort() is observable.
    streamChat.mockReturnValue({ abort } as unknown as AbortController);

    // Deterministic ids; crypto.randomUUID exists in jsdom but stub for clarity.
    let n = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(
      () => `id-${++n}` as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("send() pushes a user message + an assistant placeholder and sets streaming", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.send("why did the robot stop?");
    });

    const { messages, streaming } = useChatStore.getState();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "user",
      text: "why did the robot stop?",
    });
    expect(messages[1]).toMatchObject({ role: "assistant" });
    expect(streaming).toBe(true);
  });

  it("send() calls streamChat with the session id, message, and composer overrides", () => {
    useSessionStore.setState({ sessionId: "sess-42" });
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.send("hello");
    });

    expect(streamChat).toHaveBeenCalledTimes(1);
    const call = streamChat.mock.calls[0];
    expect(call[0]).toBe("sess-42"); // sessionId
    expect(call[1]).toBe("hello"); // message
    expect(typeof call[2]).toBe("function"); // onEvent
    // composerProvider / composerModel come from the settings store defaults.
    expect(call[3]).toBeTypeOf("string");
    expect(call[4]).toBeTypeOf("string");
  });

  it("falls back to the 'general' session id when none is selected", () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      result.current.send("hi");
    });
    expect(streamChat.mock.calls[0][0]).toBe("general");
  });

  it("a 'plan' event with steps attaches the plan to the assistant message", () => {
    const { result } = renderHook(() => useChat());
    act(() => result.current.send("trace failure"));

    act(() => {
      lastOnEvent()("plan", {
        plan: [{ specialist: "RootCauseAnalyst" }, { label: "Summarize" }],
      });
    });

    const last = useChatStore.getState().messages.at(-1)!;
    expect(last.plan).toHaveLength(2);
    expect(last.plan?.[0]).toMatchObject({
      label: "RootCauseAnalyst",
      done: false,
      active: false,
    });
    expect(last.plan?.[1]?.label).toBe("Summarize");
  });

  it("an empty 'plan' event (general chat) does not attach a plan card", () => {
    const { result } = renderHook(() => useChat());
    act(() => result.current.send("just chatting"));

    act(() => {
      lastOnEvent()("plan", { plan: [] });
    });

    expect(useChatStore.getState().messages.at(-1)!.plan).toBeUndefined();
  });

  it("step-start / step-done update the corresponding plan step", () => {
    const { result } = renderHook(() => useChat());
    act(() => result.current.send("trace"));
    act(() => {
      lastOnEvent()("plan", { plan: [{ label: "A" }, { label: "B" }] });
    });

    act(() => lastOnEvent()("step-start", { idx: 0 }));
    expect(useChatStore.getState().messages.at(-1)!.plan?.[0].active).toBe(true);

    act(() =>
      lastOnEvent()("step-done", {
        idx: 0,
        confidence: 0.9,
        output_summary: "found it",
      }),
    );
    const step = useChatStore.getState().messages.at(-1)!.plan?.[0];
    expect(step).toMatchObject({
      done: true,
      active: false,
      confidence: 0.9,
      outputSummary: "found it",
    });
  });

  it("a 'final' event writes summary/findings and clears streaming", () => {
    const { result } = renderHook(() => useChat());
    act(() => result.current.send("why?"));

    act(() => {
      lastOnEvent()("final", {
        response: "The lidar dropped out at t=12.3s.",
        findings: [{ sev: "critical", text: "lidar dropout", detail: "topic /scan" }],
        usage: { tokens_in: 100, tokens_out: 50, est_cost_usd: 0.01 },
      });
    });

    const last = useChatStore.getState().messages.at(-1)!;
    expect(last.summary).toBe("The lidar dropped out at t=12.3s.");
    expect(last.findings).toHaveLength(1);
    expect(last.findings?.[0]).toMatchObject({
      sev: "critical",
      text: "lidar dropout",
    });
    expect(last.usage).toMatchObject({ tokens_in: 100, tokens_out: 50 });
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it("'final' attaches quick actions only when a real session is active", () => {
    // No session -> actions is an empty array (current behavior: the field is
    // always written, the no-session branch just produces []).
    const { result, rerender } = renderHook(() => useChat());
    act(() => result.current.send("q1"));
    act(() => lastOnEvent()("final", { response: "ans" }));
    expect(useChatStore.getState().messages.at(-1)!.actions).toEqual([]);

    // With a session -> three navigation actions.
    act(() => {
      resetChatStore();
      useSessionStore.setState({ sessionId: "sess-1" });
    });
    rerender();
    act(() => result.current.send("q2"));
    act(() => lastOnEvent()("final", { response: "ans2" }));
    const actions = useChatStore.getState().messages.at(-1)!.actions;
    expect(actions).toHaveLength(3);
    expect(actions?.map((a) => a.target)).toEqual([
      "timeline",
      "kgraph",
      "metrics",
    ]);
  });

  it("an 'error' event appends a system message and stops streaming", () => {
    const { result } = renderHook(() => useChat());
    act(() => result.current.send("boom"));

    act(() => lastOnEvent()("error", { message: "backend exploded" }));

    const msgs = useChatStore.getState().messages;
    expect(msgs.at(-1)).toMatchObject({
      role: "system",
      text: "backend exploded",
    });
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it("a DataPilot 'error' with a code offers no next steps", () => {
    // DataPilot's error frames carry codes too (chat_error, graph_error, …);
    // next steps are for Claude Code's errors only.
    const { result } = renderHook(() => useChat());
    act(() => result.current.send("boom"));

    act(() => lastOnEvent()("error", { code: "graph_error", message: "x" }));

    expect(useChatStore.getState().messages.at(-1)).toEqual({
      id: expect.any(String),
      role: "system",
      text: "x",
    });
    expect(useChatStore.getState().messages.at(-1)!.nextSteps).toBeUndefined();
    expect(useChatStore.getState().messages.at(-1)!.retryQuestion).toBeUndefined();
    expect(useChatStore.getState().streaming).toBe(false);
  });

  it("a 'kgraph' event refetches the graph when a session is active", () => {
    useSessionStore.setState({ sessionId: "sess-9" });
    const { result } = renderHook(() => useChat());
    act(() => result.current.send("update kg"));

    act(() => lastOnEvent()("kgraph", {}));

    expect(getKGraph).toHaveBeenCalledWith("sess-9");
  });

  it("a second send() aborts the previous in-flight stream", () => {
    const { result } = renderHook(() => useChat());
    act(() => result.current.send("first"));
    act(() => result.current.send("second"));
    // The first controller's abort() is invoked before the second stream starts.
    expect(abort).toHaveBeenCalled();
    expect(streamChat).toHaveBeenCalledTimes(2);
  });

  it("stop() aborts, clears streaming, and annotates the last message", () => {
    const { result } = renderHook(() => useChat());
    act(() => result.current.send("long question"));

    act(() => result.current.stop());

    expect(abort).toHaveBeenCalled();
    expect(useChatStore.getState().streaming).toBe(false);
    // Placeholder had no summary -> replaced with the stopped marker.
    expect(useChatStore.getState().messages.at(-1)!.summary).toBe(
      "*Generation stopped by user.*",
    );
  });

  it("stop() appends the marker when a partial summary already exists", () => {
    const { result } = renderHook(() => useChat());
    act(() => result.current.send("q"));
    act(() => lastOnEvent()("final", { response: "partial answer" }));

    act(() => result.current.stop());

    expect(useChatStore.getState().messages.at(-1)!.summary).toBe(
      "partial answer\n\n*Generation stopped by user.*",
    );
  });

  // issue #36 — stop() must annotate the assistant message the aborted stream was
  // writing to, identified by its id, NOT whatever message is currently LAST in
  // the store. If a later message (e.g. a system error) has been appended, the
  // "stopped by user" marker must still land on the assistant message.
  it("issue #36: stop() annotates the active assistant message, not a trailing system error", () => {
    const { result } = renderHook(() => useChat());
    act(() => result.current.send("q"));
    act(() => lastOnEvent()("error", { message: "stream died" }));

    act(() => result.current.stop());

    const msgs = useChatStore.getState().messages;
    // The trailing system error is untouched...
    const systemMsg = msgs.find((m) => m.role === "system")!;
    expect(systemMsg.summary).toBeUndefined();
    expect(systemMsg.text).toBe("stream died");
    // ...and the assistant message carries the stopped marker.
    const assistantMsg = msgs.find((m) => m.role === "assistant")!;
    expect(assistantMsg.summary).toBe("*Generation stopped by user.*");
  });

  // issue #35 — async SSE handlers must read the LIVE sessionId, not the value
  // captured in the send() closure. If the active session changes mid-stream
  // (without a re-render), the 'kgraph' handler must refetch against the current
  // session, not the one present when send() was called.
  it("issue #35: SSE handlers read the live sessionId, not a stale closure", () => {
    act(() => {
      useSessionStore.setState({ sessionId: "sess-old" });
    });
    const { result } = renderHook(() => useChat());

    // send() captures the closure while the session is still "sess-old".
    act(() => result.current.send("which session?"));
    expect(streamChat.mock.calls.at(-1)![0]).toBe("sess-old");

    // The active session changes mid-stream WITHOUT re-rendering the hook.
    act(() => {
      useSessionStore.setState({ sessionId: "sess-new" });
    });

    // A late SSE event must resolve against the live session id.
    act(() => lastOnEvent()("kgraph", {}));
    expect(getKGraph).toHaveBeenCalledWith("sess-new");
  });

  describe("Claude Code transport", () => {
    beforeEach(() => {
      useSettingsStore.setState({ copilotEngine: "claude_code", claudeCodeModel: "sonnet" });
      useSessionStore.setState({ sessionId: "sess-1", status: "ready" });
      streamClaudeCode.mockReturnValue({ abort });
    });

    /** Pull the onEvent callback that useChat passed into streamClaudeCode. */
    const lastClaudeEvent = (): ChatEventHandler => {
      const call = streamClaudeCode.mock.calls.at(-1);
      if (!call) throw new Error("streamClaudeCode was not called");
      return call[1] as ChatEventHandler;
    };

    it("asks Claude Code when it is the Copilot engine", () => {
      const { result } = renderHook(() => useChat());
      act(() => result.current.send("why?"));

      expect(streamClaudeCode).toHaveBeenCalledWith(
        { sessionId: "sess-1", question: "why?", model: "sonnet" },
        expect.any(Function),
      );
      expect(streamChat).not.toHaveBeenCalled();
      expect(useChatStore.getState().messages.at(-1)).toMatchObject({
        role: "assistant",
        answeredBy: "claude_code",
      });
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it("uses the engine chosen right before sending", () => {
      // "Answer with DataPilot's agents" switches the engine and resends at once.
      const { result } = renderHook(() => useChat());
      act(() => {
        useSettingsStore.setState({ copilotEngine: "datapilot" });
        result.current.send("why?");
      });

      expect(streamChat).toHaveBeenCalledTimes(1);
      expect(streamClaudeCode).not.toHaveBeenCalled();
    });

    it("adds a step per tool call and marks it done", () => {
      const { result } = renderHook(() => useChat());
      act(() => result.current.send("why?"));

      act(() => lastClaudeEvent()("step-add", { label: "Find aborts" }));
      act(() => lastClaudeEvent()("step-add", { label: "Read the planner logs" }));
      expect(useChatStore.getState().messages.at(-1)!.plan).toEqual([
        { label: "Find aborts", done: false, active: true },
        { label: "Read the planner logs", done: false, active: true },
      ]);

      act(() => lastClaudeEvent()("step-done", { idx: 0 }));
      const plan = useChatStore.getState().messages.at(-1)!.plan;
      expect(plan?.[0]).toMatchObject({ label: "Find aborts", done: true, active: false });
      expect(plan?.[1]).toMatchObject({ done: false, active: true });
    });

    it("writes the final answer with its label, verification and usage", () => {
      const { result } = renderHook(() => useChat());
      act(() => result.current.send("why?"));

      act(() =>
        lastClaudeEvent()("final", {
          response: "Planner aborted.",
          findings: [{ sev: "critical", text: "abort", log_ids: ["sess-1:l_8"] }],
          causal: [{ label: "lidar dropout" }],
          answered_by: "claude_code",
          verified: false,
          flagged_log_ids: ["l_999"],
          usage: { tokens_in: 1500, tokens_out: 200, est_cost_usd: 0.0123 },
          claude_code_usage: {
            model: "claude-sonnet-4-5",
            auth_method: "claude.ai",
            tool_calls: 3,
            est_cost_usd: 0.0123,
          },
        }),
      );

      expect(useChatStore.getState().messages.at(-1)).toMatchObject({
        answeredBy: "claude_code",
        summary: "Planner aborted.",
        verified: false,
        flaggedLogIds: ["l_999"],
        findings: [{ sev: "critical", text: "abort", logIds: ["sess-1:l_8"] }],
        causal: [{ text: "lidar dropout" }],
        claudeCodeUsage: {
          model: "claude-sonnet-4-5",
          authMethod: "claude.ai",
          toolCalls: 3,
          estCostUsd: 0.0123,
        },
        usage: undefined,
      });
      expect(useChatStore.getState().streaming).toBe(false);
    });

    it.each([
      [null, "idle"],
      ["sess-1", "processing"],
    ] as const)(
      "says Claude Code needs a loaded bag instead of asking it (session %s, %s)",
      (sessionId, status) => {
        useSessionStore.setState({ sessionId, status });
        const { result } = renderHook(() => useChat());
        act(() => result.current.send("why?"));

        const { messages, streaming } = useChatStore.getState();
        expect(messages).toHaveLength(2);
        expect(messages[0]).toMatchObject({ role: "user", text: "why?" });
        expect(messages[1]).toMatchObject({
          role: "system",
          text: "Claude Code answers questions about a loaded bag. Load a bag first, or switch to DataPilot's agents.",
          nextSteps: ["use_datapilot"],
          retryQuestion: "why?",
        });
        expect(streamClaudeCode).not.toHaveBeenCalled();
        expect(streamChat).not.toHaveBeenCalled();
        expect(streaming).toBe(false);
      },
    );

    it("turns a Claude Code error into its next steps", () => {
      const { result } = renderHook(() => useChat());
      act(() => result.current.send("why?"));

      act(() =>
        lastClaudeEvent()("error", {
          code: "usage_limit",
          message: "Your Claude plan's usage limit is reached. Your question is saved.",
        }),
      );

      expect(useChatStore.getState().messages.at(-1)).toMatchObject({
        role: "system",
        text: "Your Claude plan's usage limit is reached. Your question is saved.",
        nextSteps: ["use_datapilot"],
        retryQuestion: "why?",
      });
      expect(useChatStore.getState().streaming).toBe(false);
    });

    it("stop() stops the Claude Code run", () => {
      const { result } = renderHook(() => useChat());
      act(() => result.current.send("why?"));

      act(() => result.current.stop());

      expect(abort).toHaveBeenCalledTimes(1);
      expect(useChatStore.getState().streaming).toBe(false);
      expect(useChatStore.getState().messages.at(-1)).toMatchObject({
        answeredBy: "claude_code",
        summary: "*Generation stopped by user.*",
      });
    });

    it.each(["final", "error", "stop"] as const)(
      "marks the steps still running as no longer running when the answer ends (%s)",
      (ending) => {
        const { result } = renderHook(() => useChat());
        act(() => result.current.send("why?"));
        const onEvent = lastClaudeEvent();
        act(() => {
          onEvent("step-add", { label: "Find aborts" });
          onEvent("step-add", { label: "Read the planner logs" });
          onEvent("step-done", { idx: 0 });
        });

        act(() => {
          if (ending === "stop") result.current.stop();
          else if (ending === "final") onEvent("final", { response: "Planner aborted.", answered_by: "claude_code" });
          else onEvent("error", { code: "failed", message: "Claude Code couldn't finish this answer" });
        });

        const answer = useChatStore.getState().messages.find((m) => m.role === "assistant")!;
        expect(answer.plan).toEqual([
          { label: "Find aborts", done: true, active: false },
          { label: "Read the planner logs", done: false, active: false },
        ]);
      },
    );
  });

  // C1: a screen switch unmounts the Copilot, and with it this hook. The answer
  // in flight must keep streaming into the chat, and the remounted Copilot must
  // still show it and be able to stop it.
  describe("an answer outlives the Copilot unmounting", () => {
    let bridge: ReturnType<typeof fakeBridge>;

    beforeEach(async () => {
      // The real Claude Code transport over a fake preload bridge, so an abort
      // really ends the run, as it does in the app.
      const actual = await vi.importActual<typeof import("@renderer/services/claudeCode")>(
        "@renderer/services/claudeCode",
      );
      streamClaudeCode.mockImplementation(actual.streamClaudeCode);
      bridge = fakeBridge();
      useSettingsStore.setState({ copilotEngine: "claude_code", claudeCodeModel: "" });
      useSessionStore.setState({ sessionId: "sess-1", status: "ready" });
    });

    afterEach(() => {
      delete (window as unknown as { datapilot?: unknown }).datapilot;
    });

    /** Asks with Claude Code, lets the run start, then unmounts the hook (a screen switch). */
    async function askThenUnmount(): Promise<string> {
      const first = renderHook(() => useChat());
      act(() => first.result.current.send("why?"));
      await act(async () => {}); // `ask` resolves once main has started the run
      const assistantId = useChatStore.getState().messages.at(-1)!.id;
      first.unmount();
      await act(async () => {}); // a release would stop the run asynchronously
      return assistantId;
    }

    const message = (id: string): ChatMessage =>
      useChatStore.getState().messages.find((m) => m.id === id)!;

    it("unmounting mid-answer neither aborts nor stops the run", async () => {
      await askThenUnmount();
      expect(bridge.stopRun).not.toHaveBeenCalled();
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it("unmounting mid-answer doesn't abort DataPilot's stream either", () => {
      useSettingsStore.setState({ copilotEngine: "datapilot" });
      const { result, unmount } = renderHook(() => useChat());
      act(() => result.current.send("why?"));
      unmount();
      expect(abort).not.toHaveBeenCalled();
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it("events after a remount still update the same message", async () => {
      const assistantId = await askThenUnmount();
      renderHook(() => useChat());

      bridge.emit({ event: "step-add", data: { label: "Find aborts" } });
      bridge.emit({ event: "step-done", data: { idx: 0 } });

      expect(message(assistantId).plan).toEqual([{ label: "Find aborts", done: true, active: false }]);
      expect(useChatStore.getState().streaming).toBe(true);
    });

    it("streaming ends when the final answer arrives after a remount", async () => {
      const assistantId = await askThenUnmount();
      renderHook(() => useChat());

      bridge.emit({
        event: "final",
        data: {
          response: "Planner aborted.",
          plan: [],
          findings: [],
          causal: [],
          audit_trail: [],
          citations: [],
          usage: { tokens_in: 1, tokens_out: 1, est_cost_usd: 0 },
          partial: false,
          answered_by: "claude_code",
          verified: false,
          flagged_log_ids: [],
          claude_code_usage: { model: "claude-sonnet-4-5", auth_method: "claude.ai", tool_calls: 0, est_cost_usd: 0 },
        },
      });

      expect(message(assistantId).summary).toBe("Planner aborted.");
      expect(useChatStore.getState().streaming).toBe(false);
    });

    it("streaming ends when an error arrives after a remount", async () => {
      await askThenUnmount();
      renderHook(() => useChat());

      bridge.emit({ event: "error", data: { code: "failed", message: "Claude Code couldn't finish this answer" } });

      expect(useChatStore.getState().messages.at(-1)).toMatchObject({
        role: "system",
        text: "Claude Code couldn't finish this answer",
      });
      expect(useChatStore.getState().streaming).toBe(false);
    });

    it("stop() after a remount stops the run and marks the answer", async () => {
      const assistantId = await askThenUnmount();
      const second = renderHook(() => useChat());

      act(() => second.result.current.stop());

      expect(bridge.stopRun).toHaveBeenCalledTimes(1);
      expect(message(assistantId).summary).toBe("*Generation stopped by user.*");
      expect(useChatStore.getState().streaming).toBe(false);
    });
  });

  // I1: an answer writes only to its own message. When the chat is replaced
  // (another bag's history), its late events are dropped, and it stops
  // counting as streaming; the run itself finishes and saves to its own bag.
  describe("an answer for a bag that is no longer shown", () => {
    const history: ChatMessage[] = [
      { id: "hist-0", role: "user", text: "What failed on bag 2?" },
      { id: "hist-1", role: "assistant", summary: "The lidar, on bag 2." },
    ];

    beforeEach(() => {
      useSettingsStore.setState({ copilotEngine: "claude_code", claudeCodeModel: "" });
      useSessionStore.setState({ sessionId: "sess-1", status: "ready" });
      streamClaudeCode.mockReturnValue({ abort });
    });

    it("doesn't touch the new history, and streaming ends at the switch", () => {
      const { result } = renderHook(() => useChat());
      act(() => result.current.send("why?"));
      const onEvent = streamClaudeCode.mock.calls.at(-1)![1] as ChatEventHandler;

      act(() => {
        useSessionStore.setState({ sessionId: "sess-2" });
        useChatStore.getState().setMessages(history);
      });
      expect(useChatStore.getState().streaming).toBe(false);

      act(() => {
        onEvent("step-add", { label: "Find aborts" });
        onEvent("step-done", { idx: 0 });
        onEvent("final", { response: "Planner aborted on bag 1.", answered_by: "claude_code" });
        onEvent("error", { code: "failed", message: "Claude Code couldn't finish this answer" });
      });

      expect(useChatStore.getState().messages).toEqual(history);
      expect(useChatStore.getState().streaming).toBe(false);
      expect(abort).not.toHaveBeenCalled(); // it may finish and save to its own bag
    });

    it("doesn't end the new bag's answer", () => {
      const { result } = renderHook(() => useChat());
      act(() => result.current.send("why?"));
      const oldEvents = streamClaudeCode.mock.calls.at(-1)![1] as ChatEventHandler;
      act(() => {
        useSessionStore.setState({ sessionId: "sess-2" });
        useChatStore.getState().setMessages(history);
      });

      act(() => result.current.send("and on bag 2?"));
      act(() => oldEvents("final", { response: "Planner aborted on bag 1.", answered_by: "claude_code" }));

      expect(useChatStore.getState().streaming).toBe(true);
      expect(useChatStore.getState().messages.at(-1)).toMatchObject({ role: "assistant", answeredBy: "claude_code" });
      expect(useChatStore.getState().messages.at(-1)!.summary).toBeUndefined();
      expect(streamClaudeCode.mock.calls.at(-1)![0]).toMatchObject({ sessionId: "sess-2" });
    });
  });
});
