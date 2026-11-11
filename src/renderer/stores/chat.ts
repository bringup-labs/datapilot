import { create } from "zustand";
import type { ChatMessage, PlanStep } from "@shared/types";

/**
 * The latest answer. It lives here, not in the Copilot's components, because a
 * screen switch unmounts them while the answer keeps streaming into this store.
 */
export interface ChatAnswer {
  /** The assistant message it writes to. */
  assistantId: string;
  /** The bag it was asked about; null when none was loaded. */
  sessionId: string | null;
  /** Stops it: DataPilot's stream or a Claude Code run. Null once stopped. */
  handle: { abort(): void } | null;
}

interface ChatState {
  messages: ChatMessage[];
  streaming: boolean;
  pendingResend: string | null;
  /** The bag whose chat is shown; null for the chat without a bag. */
  sessionId: string | null;
  answer: ChatAnswer | null;

  addMessage: (msg: ChatMessage) => void;
  updateLastMessage: (updater: (m: ChatMessage) => ChatMessage) => void;
  updateMessageById: (
    id: string,
    updater: (m: ChatMessage) => ChatMessage,
  ) => void;
  updatePlanStep: (idx: number, patch: Partial<PlanStep>) => void;
  setStreaming: (streaming: boolean) => void;
  setAnswer: (answer: ChatAnswer | null) => void;
  /**
   * Shows the chat of `sessionId`. Showing the same bag again, as when the
   * Copilot remounts after a screen switch, keeps the chat; another bag
   * starts an empty one.
   */
  showSession: (sessionId: string | null) => void;
  clearMessages: () => void;
  setMessages: (msgs: ChatMessage[]) => void;
  requestResend: (question: string) => void;
  clearResend: () => void;
}

/**
 * Replacing the chat detaches the answer in flight: its late events are
 * dropped, and it no longer counts as streaming. Its run isn't stopped; it
 * finishes and saves to its own bag.
 */
const DETACHED = { answer: null, streaming: false } as const;

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  streaming: false,
  pendingResend: null,
  sessionId: null,
  answer: null,

  addMessage: (msg) => set((s) => ({ messages: [...s.messages, msg] })),

  updateLastMessage: (updater) =>
    set((s) => {
      if (s.messages.length === 0) return s;
      const last = s.messages[s.messages.length - 1];
      // Only the active assistant message receives streamed updates. Guarding by
      // role keeps streamed content from clobbering a trailing user/system
      // message (e.g. an error appended after the placeholder). See issue #36.
      if (last.role !== "assistant") return s;
      const msgs = [...s.messages];
      msgs[msgs.length - 1] = updater(last);
      return { messages: msgs };
    }),

  updateMessageById: (id, updater) =>
    set((s) => {
      const idx = s.messages.findIndex((m) => m.id === id);
      if (idx === -1) return s;
      const msgs = [...s.messages];
      msgs[idx] = updater(msgs[idx]);
      return { messages: msgs };
    }),

  updatePlanStep: (idx, patch) => {
    const { messages } = get();
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last.plan) return;
    const plan = last.plan.map((step, i) =>
      i === idx ? { ...step, ...patch } : step,
    );
    set((s) => {
      const msgs = [...s.messages];
      msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], plan };
      return { messages: msgs };
    });
  },

  setStreaming: (streaming) => set({ streaming }),

  setAnswer: (answer) => set({ answer }),

  showSession: (sessionId) =>
    set((s) =>
      s.sessionId === sessionId ? s : { sessionId, messages: [], ...DETACHED },
    ),

  clearMessages: () => set({ messages: [], ...DETACHED }),

  setMessages: (msgs) => set({ messages: msgs, ...DETACHED }),

  requestResend: (question) => set({ pendingResend: question }),

  clearResend: () => set({ pendingResend: null }),
}));
