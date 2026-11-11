import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "./chat";
import type { ChatMessage, PlanStep } from "@shared/types";

const initial = useChatStore.getState();

function msg(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: "assistant", text: `msg-${id}`, ...over };
}

describe("useChatStore", () => {
  beforeEach(() => {
    useChatStore.setState(initial, true);
  });

  it("starts empty and not streaming", () => {
    const s = useChatStore.getState();
    expect(s.messages).toEqual([]);
    expect(s.streaming).toBe(false);
  });

  describe("addMessage", () => {
    it("appends messages in order", () => {
      useChatStore.getState().addMessage(msg("1"));
      useChatStore.getState().addMessage(msg("2"));
      const { messages } = useChatStore.getState();
      expect(messages.map((m) => m.id)).toEqual(["1", "2"]);
    });

    it("does not mutate the previous array reference", () => {
      useChatStore.getState().addMessage(msg("1"));
      const first = useChatStore.getState().messages;
      useChatStore.getState().addMessage(msg("2"));
      const second = useChatStore.getState().messages;
      expect(first).not.toBe(second);
      expect(first).toHaveLength(1);
    });
  });

  describe("updateLastMessage", () => {
    it("applies the updater to the final message only", () => {
      useChatStore.getState().addMessage(msg("1"));
      useChatStore.getState().addMessage(msg("2"));
      useChatStore
        .getState()
        .updateLastMessage((m) => ({ ...m, text: "edited" }));
      const { messages } = useChatStore.getState();
      expect(messages[0].text).toBe("msg-1");
      expect(messages[1].text).toBe("edited");
    });

    it("is a no-op when there are no messages", () => {
      useChatStore.getState().updateLastMessage((m) => ({ ...m, text: "x" }));
      expect(useChatStore.getState().messages).toEqual([]);
    });

    // issue #36 — updateLastMessage must only mutate the last message when it is
    // an assistant message. If the last message is the USER's (or a system error),
    // the streamed assistant content must NOT clobber it.
    it("does not overwrite the last message when it is not an assistant (issue #36)", () => {
      useChatStore.getState().addMessage(msg("u1", { role: "user", text: "hi" }));
      useChatStore
        .getState()
        .updateLastMessage((m) => ({ ...m, text: "assistant token" }));
      const last = useChatStore.getState().messages.at(-1)!;
      // The user's message is left untouched — the fix.
      expect(last.role).toBe("user");
      expect(last.text).toBe("hi");
    });
  });

  describe("updateMessageById", () => {
    it("patches only the message with the matching id", () => {
      useChatStore.getState().addMessage(msg("1", { role: "user", text: "hi" }));
      useChatStore.getState().addMessage(msg("2", { text: "assistant" }));
      useChatStore.getState().addMessage(msg("3", { role: "system", text: "err" }));
      useChatStore
        .getState()
        .updateMessageById("2", (m) => ({ ...m, summary: "done" }));
      const { messages } = useChatStore.getState();
      expect(messages[0]).toMatchObject({ id: "1", text: "hi" });
      expect(messages[0].summary).toBeUndefined();
      expect(messages[1]).toMatchObject({ id: "2", summary: "done" });
      expect(messages[2]).toMatchObject({ id: "3", text: "err" });
    });

    it("is a no-op when no message matches the id", () => {
      useChatStore.getState().addMessage(msg("1", { text: "a" }));
      useChatStore
        .getState()
        .updateMessageById("missing", (m) => ({ ...m, text: "b" }));
      expect(useChatStore.getState().messages.at(-1)!.text).toBe("a");
    });
  });

  describe("updatePlanStep", () => {
    const planMsg = (): ChatMessage => {
      const plan: PlanStep[] = [
        { label: "a", done: false, active: true },
        { label: "b", done: false, active: false },
      ];
      return msg("p", { plan });
    };

    it("patches a single plan step on the last message", () => {
      useChatStore.getState().addMessage(planMsg());
      useChatStore.getState().updatePlanStep(0, { done: true, active: false });
      const last = useChatStore.getState().messages.at(-1)!;
      expect(last.plan![0]).toMatchObject({ label: "a", done: true, active: false });
      expect(last.plan![1]).toMatchObject({ label: "b", done: false });
    });

    it("is a no-op when there are no messages", () => {
      useChatStore.getState().updatePlanStep(0, { done: true });
      expect(useChatStore.getState().messages).toEqual([]);
    });

    it("is a no-op when the last message has no plan", () => {
      useChatStore.getState().addMessage(msg("1"));
      useChatStore.getState().updatePlanStep(0, { done: true });
      expect(useChatStore.getState().messages.at(-1)!.plan).toBeUndefined();
    });

    it("ignores an out-of-range index (leaves steps unchanged)", () => {
      useChatStore.getState().addMessage(planMsg());
      useChatStore.getState().updatePlanStep(99, { done: true });
      const last = useChatStore.getState().messages.at(-1)!;
      expect(last.plan!.every((s) => s.done === false)).toBe(true);
    });
  });

  describe("setStreaming / clearMessages / setMessages", () => {
    it("setStreaming toggles the streaming flag", () => {
      useChatStore.getState().setStreaming(true);
      expect(useChatStore.getState().streaming).toBe(true);
      useChatStore.getState().setStreaming(false);
      expect(useChatStore.getState().streaming).toBe(false);
    });

    it("clearMessages empties the message list", () => {
      useChatStore.getState().addMessage(msg("1"));
      useChatStore.getState().clearMessages();
      expect(useChatStore.getState().messages).toEqual([]);
    });

    it("setMessages replaces the entire list", () => {
      useChatStore.getState().addMessage(msg("old"));
      const replacement = [msg("a"), msg("b")];
      useChatStore.getState().setMessages(replacement);
      expect(useChatStore.getState().messages.map((m) => m.id)).toEqual([
        "a",
        "b",
      ]);
    });
  });

  // The answer in flight lives here, outside the Copilot's components, so a
  // screen switch can't end it. Replacing the chat detaches it: its late events
  // are dropped, and it no longer counts as streaming.
  describe("the answer in flight", () => {
    const handle = { abort: () => undefined };

    function streamingAnswer(): void {
      const s = useChatStore.getState();
      s.addMessage(msg("q", { role: "user", text: "why?" }));
      s.addMessage(msg("a"));
      s.setAnswer({ assistantId: "a", sessionId: "sess-1", handle });
      s.setStreaming(true);
    }

    it("is kept until replaced", () => {
      streamingAnswer();
      expect(useChatStore.getState().answer).toEqual({ assistantId: "a", sessionId: "sess-1", handle });
    });

    it("keeps the chat and the answer when the same bag is shown again (the Copilot remounted)", () => {
      useChatStore.getState().showSession("sess-1");
      streamingAnswer();
      useChatStore.getState().showSession("sess-1");
      const s = useChatStore.getState();
      expect(s.messages.map((m) => m.id)).toEqual(["q", "a"]);
      expect(s.answer?.assistantId).toBe("a");
      expect(s.streaming).toBe(true);
    });

    it.each([
      ["another bag is shown", () => useChatStore.getState().showSession("sess-2")],
      ["the chat is cleared", () => useChatStore.getState().clearMessages()],
      ["the chat is replaced", () => useChatStore.getState().setMessages([msg("hist-0")])],
    ])("is detached, and streaming ends, when %s", (_when, replace) => {
      useChatStore.getState().showSession("sess-1");
      streamingAnswer();
      replace();
      const s = useChatStore.getState();
      expect(s.answer).toBeNull();
      expect(s.streaming).toBe(false);
      expect(s.messages.some((m) => m.id === "a")).toBe(false);
    });

    it("showSession records the bag whose chat is shown", () => {
      useChatStore.getState().showSession("sess-2");
      expect(useChatStore.getState().sessionId).toBe("sess-2");
    });
  });

  it("requestResend stores the question and clearResend clears it", () => {
    expect(useChatStore.getState().pendingResend).toBeNull();
    useChatStore.getState().requestResend("why?");
    expect(useChatStore.getState().pendingResend).toBe("why?");
    useChatStore.getState().clearResend();
    expect(useChatStore.getState().pendingResend).toBeNull();
  });
});
