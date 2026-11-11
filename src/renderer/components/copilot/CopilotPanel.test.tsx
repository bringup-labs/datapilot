import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@renderer/services/api", () => ({
  getChatMessages: vi.fn().mockResolvedValue([]),
  getSessions: vi.fn().mockResolvedValue([]),
  getKGraph: vi.fn(),
  streamChat: vi.fn(),
  deleteSession: vi.fn(),
  clearAllSessions: vi.fn(),
}));

import { CopilotPanel } from "./CopilotPanel";
import { useChatStore } from "@renderer/stores/chat";
import { useSessionStore } from "@renderer/stores/session";

const chatInitial = useChatStore.getState();
const sessionInitial = useSessionStore.getState();

/** The chat of bag sess-1, with a Claude Code answer still streaming. */
function answerStreaming(): void {
  useSessionStore.setState({ sessionId: "sess-1", status: "ready" });
  useChatStore.setState({
    sessionId: "sess-1",
    messages: [
      { id: "q", role: "user", text: "Why did the robot stop?" },
      {
        id: "a",
        role: "assistant",
        answeredBy: "claude_code",
        plan: [{ label: "Find aborts", done: false, active: true }],
      },
    ],
    answer: { assistantId: "a", sessionId: "sess-1", handle: { abort: vi.fn() } },
    streaming: true,
  });
}

describe("CopilotPanel", () => {
  beforeEach(() => {
    useChatStore.setState(chatInitial, true);
    useSessionStore.setState(sessionInitial, true);
  });
  afterEach(cleanup);

  it("keeps the chat, and an answer still streaming, when it remounts after a screen switch", () => {
    answerStreaming();
    render(<CopilotPanel />).unmount(); // Settings or Agents & MCP opened

    render(<CopilotPanel />);

    expect(screen.getByText("Why did the robot stop?")).toBeInTheDocument();
    expect(screen.getByText("running…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stop/ })).toBeInTheDocument();
    expect(useChatStore.getState().streaming).toBe(true);
  });

  it("clears the chat when another bag loads, and an answer for the old bag stops streaming", () => {
    answerStreaming();
    render(<CopilotPanel />);

    act(() => useSessionStore.setState({ sessionId: "sess-2" }));

    expect(screen.queryByText("Why did the robot stop?")).toBeNull();
    expect(useChatStore.getState()).toMatchObject({ messages: [], streaming: false, answer: null });
  });
});
