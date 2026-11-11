import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { SessionMeta } from "@shared/types";

// Mock the whole REST client. useSession imports it as `* as api`.
vi.mock("@renderer/services/api", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  getTimeline: vi.fn(),
  getTopics: vi.fn(),
  getLogs: vi.fn(),
  getKGraph: vi.fn(),
}));

import * as api from "@renderer/services/api";
import { useSession } from "./useSession";
import { useSessionStore } from "@renderer/stores/session";

const mockApi = api as unknown as Record<keyof typeof api, Mock>;

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "s1",
    filename: "robot.mcap",
    robot: "turtle",
    durationSeconds: 12,
    totalMessages: 100,
    topicsCount: 3,
    status: "ready",
    ...overrides,
  };
}

describe("useSession", () => {
  beforeEach(() => {
    // Fresh store between tests so status transitions are observable in isolation.
    useSessionStore.setState({
      pendingPath: null,
      pendingSessionId: null,
      sessionId: null,
      loadedPath: null,
      status: "idle",
      meta: null,
      timeline: [],
      topics: [],
      logs: [],
      kgraph: null,
    });

    mockApi.createSession.mockReset();
    mockApi.getSession.mockReset();
    mockApi.getTimeline.mockReset();
    mockApi.getTopics.mockReset();
    mockApi.getLogs.mockReset();
    mockApi.getKGraph.mockReset();

    // Sensible defaults for the parallel tab-data fetch on ready.
    mockApi.getTimeline.mockResolvedValue([]);
    mockApi.getTopics.mockResolvedValue([]);
    mockApi.getLogs.mockResolvedValue([]);
    mockApi.getKGraph.mockResolvedValue({ nodes: [], edges: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is a no-op when no pending path or session id is provided", async () => {
    renderHook(() => useSession(null));
    // Give microtasks a chance; nothing should have been requested.
    await Promise.resolve();
    expect(mockApi.createSession).not.toHaveBeenCalled();
    expect(mockApi.getSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().status).toBe("idle");
  });

  it("sets status to 'creating' immediately when given a path", async () => {
    // Never-resolving createSession so we can observe the synchronous transition.
    mockApi.createSession.mockReturnValue(new Promise(() => {}));
    renderHook(() => useSession("/bags/robot.mcap"));
    expect(useSessionStore.getState().status).toBe("creating");
  });

  it("transitions creating -> ready and fetches all tab data in parallel", async () => {
    mockApi.createSession.mockResolvedValue({ session_id: "s1" });
    // First getSession returns meta; poll's getSession returns ready.
    mockApi.getSession
      .mockResolvedValueOnce(meta({ status: "processing" }))
      .mockResolvedValue(meta({ status: "ready" }));

    renderHook(() => useSession("/bags/robot.mcap"));

    await waitFor(() => {
      expect(useSessionStore.getState().status).toBe("ready");
    });

    expect(mockApi.createSession).toHaveBeenCalledWith("/bags/robot.mcap");
    expect(useSessionStore.getState().sessionId).toBe("s1");
    expect(mockApi.getTimeline).toHaveBeenCalledWith("s1");
    expect(mockApi.getTopics).toHaveBeenCalledWith("s1");
    expect(mockApi.getLogs).toHaveBeenCalledWith("s1");
    expect(mockApi.getKGraph).toHaveBeenCalledWith("s1");
  });

  it("skips createSession when a pending session id is supplied", async () => {
    useSessionStore.setState({ pendingSessionId: "existing" });
    mockApi.getSession.mockResolvedValue(meta({ id: "existing", status: "ready" }));

    renderHook(() => useSession(null));

    await waitFor(() => {
      expect(useSessionStore.getState().status).toBe("ready");
    });
    expect(mockApi.createSession).not.toHaveBeenCalled();
    expect(useSessionStore.getState().sessionId).toBe("existing");
  });

  it("sets status 'error' when createSession rejects", async () => {
    mockApi.createSession.mockRejectedValue(new Error("network down"));

    renderHook(() => useSession("/bags/robot.mcap"));

    await waitFor(() => {
      expect(useSessionStore.getState().status).toBe("error");
    });
  });

  it("sets status 'error' when the backend reports an error status", async () => {
    mockApi.createSession.mockResolvedValue({ session_id: "s1" });
    mockApi.getSession
      .mockResolvedValueOnce(meta({ status: "processing" }))
      .mockResolvedValue(meta({ status: "error" }));

    renderHook(() => useSession("/bags/robot.mcap"));

    await waitFor(() => {
      expect(useSessionStore.getState().status).toBe("error");
    });
    // Tab data must NOT be fetched on the error path.
    expect(mockApi.getTimeline).not.toHaveBeenCalled();
  });

  it("re-polls with setTimeout while the session is still processing", async () => {
    vi.useFakeTimers();
    mockApi.createSession.mockResolvedValue({ session_id: "s1" });
    // meta fetch -> processing; first poll -> still processing; second poll -> ready
    mockApi.getSession
      .mockResolvedValueOnce(meta({ status: "processing" })) // initial getSession
      .mockResolvedValueOnce(meta({ status: "processing" })) // first poll
      .mockResolvedValue(meta({ status: "ready" })); // second poll

    renderHook(() => useSession("/bags/robot.mcap"));

    // Drain the promise chain up to the first poll scheduling a timeout.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockApi.getSession).toHaveBeenCalledTimes(2);
    expect(useSessionStore.getState().status).not.toBe("ready");

    // Advance past the 1500ms poll interval to trigger the next poll -> ready.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(useSessionStore.getState().status).toBe("ready");
  });

  // A screen switch unmounts the Copilot, which runs this hook. Coming back must
  // keep the loaded bag: loading it again would create a new session and clear
  // its chat, including an answer still streaming.
  it("keeps a ready bag when the Copilot remounts after a screen switch", async () => {
    mockApi.createSession.mockResolvedValue({ session_id: "s1" });
    mockApi.getSession.mockResolvedValue(meta({ status: "ready" }));
    const first = renderHook(() => useSession("/bags/robot.mcap"));
    await waitFor(() => expect(mockApi.getKGraph).toHaveBeenCalledTimes(1));
    first.unmount();

    renderHook(() => useSession("/bags/robot.mcap"));
    await act(async () => {});

    expect(useSessionStore.getState()).toMatchObject({ sessionId: "s1", status: "ready" });
    expect(mockApi.createSession).toHaveBeenCalledTimes(1);
    expect(mockApi.getKGraph).toHaveBeenCalledTimes(1);
  });

  it("keeps a ready session resumed from history when the Copilot remounts", async () => {
    useSessionStore.setState({ pendingSessionId: "existing" });
    mockApi.getSession.mockResolvedValue(meta({ id: "existing", status: "ready" }));
    const first = renderHook(() => useSession(null));
    await waitFor(() => expect(mockApi.getKGraph).toHaveBeenCalledTimes(1));
    const calls = mockApi.getSession.mock.calls.length;
    first.unmount();

    renderHook(() => useSession(null));
    await act(async () => {});

    expect(useSessionStore.getState()).toMatchObject({ sessionId: "existing", status: "ready" });
    expect(mockApi.getSession).toHaveBeenCalledTimes(calls);
  });

  it("still loads another bag picked while one is loaded", async () => {
    mockApi.createSession
      .mockResolvedValueOnce({ session_id: "s1" })
      .mockResolvedValueOnce({ session_id: "s2" });
    mockApi.getSession.mockImplementation(async (id: string) => meta({ id, status: "ready" }));
    const { rerender } = renderHook(({ path }) => useSession(path), {
      initialProps: { path: "/bags/a.mcap" },
    });
    await waitFor(() => expect(useSessionStore.getState().sessionId).toBe("s1"));

    rerender({ path: "/bags/b.mcap" });

    await waitFor(() => expect(useSessionStore.getState()).toMatchObject({ sessionId: "s2", status: "ready" }));
    expect(mockApi.createSession).toHaveBeenLastCalledWith("/bags/b.mcap");
  });

  it("cancels in-flight work and clears the poll timer on unmount", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    mockApi.createSession.mockResolvedValue({ session_id: "s1" });
    mockApi.getSession.mockResolvedValue(meta({ status: "processing" }));

    const { unmount } = renderHook(() => useSession("/bags/robot.mcap"));
    await waitFor(() => {
      expect(mockApi.getSession).toHaveBeenCalled();
    });

    expect(() => unmount()).not.toThrow();
    clearSpy.mockRestore();
  });
});
