import { StrictMode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act } from "@testing-library/react";

const { send, stop } = vi.hoisted(() => ({ send: vi.fn(), stop: vi.fn() }));
vi.mock("@renderer/hooks/useChat", () => ({ useChat: () => ({ send, stop }) }));

import { useChatStore } from "@renderer/stores/chat";
import { CommandBar } from "./CommandBar";

describe("CommandBar", () => {
  beforeEach(() => {
    send.mockReset();
    stop.mockReset();
    useChatStore.setState({ messages: [], streaming: false, pendingResend: null });
  });

  it("re-sends a requested question once nothing is streaming", () => {
    useChatStore.setState({ streaming: true });
    const { rerender } = render(
      <StrictMode>
        <CommandBar />
      </StrictMode>,
    );

    act(() => useChatStore.getState().requestResend("why?"));
    expect(send).not.toHaveBeenCalled();

    act(() => useChatStore.setState({ streaming: false }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("why?");
    expect(useChatStore.getState().pendingResend).toBeNull();

    rerender(
      <StrictMode>
        <CommandBar />
      </StrictMode>,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends a question queued before it mounts only once", () => {
    useChatStore.getState().requestResend("why?");

    render(
      <StrictMode>
        <CommandBar />
      </StrictMode>,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("why?");
    expect(useChatStore.getState().pendingResend).toBeNull();
  });
});
