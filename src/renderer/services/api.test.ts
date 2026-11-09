import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSession,
  getSession,
  getTimeline,
  getTopics,
  getLogs,
  getKGraph,
  getSessions,
  deleteSession,
  clearAllSessions,
  updateBackendKey,
  testApiKey,
  streamChat,
  type ChatEventHandler,
} from "./api";

const BASE = "http://localhost:8000";

/** Build a JSON Response with the given status (defaults to 200 OK). */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a streaming Response whose body emits the given encoded chunks. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("JSON helpers", () => {
  describe("happy paths", () => {
    it("createSession POSTs the filepath and returns the session id", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ session_id: "sess-1" }));
      const res = await createSession("/tmp/run.mcap");
      expect(res).toEqual({ session_id: "sess-1" });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE}/api/sessions/create`);
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
      expect(JSON.parse(init.body)).toEqual({ filepath: "/tmp/run.mcap" });
    });

    it("getSession normalizes snake_case fields and parses topics_list", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          id: "s1",
          filename: "a.mcap",
          robot_name: "spot",
          duration_seconds: 12,
          total_messages: 7,
          topics_list: JSON.stringify(["/a", "/b", "/c"]),
          status: "ready",
          updated_at: "2026-01-01T00:00:00Z",
        }),
      );
      const meta = await getSession("s1");
      expect(meta).toMatchObject({
        id: "s1",
        filename: "a.mcap",
        robot: "spot",
        durationSeconds: 12,
        totalMessages: 7,
        topicsCount: 3,
        status: "ready",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/sessions/s1`);
    });

    it("getSession applies defaults for missing optional fields", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ id: "s2", filename: "b.mcap", status: "idle" }),
      );
      const meta = await getSession("s2");
      expect(meta.robot).toBe("unknown");
      expect(meta.durationSeconds).toBe(0);
      expect(meta.totalMessages).toBe(0);
      expect(meta.topicsCount).toBe(0);
    });

    it("getSession counts an array topics_list directly", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          id: "s3",
          filename: "c.mcap",
          status: "ready",
          topics_list: ["/x", "/y"],
        }),
      );
      const meta = await getSession("s3");
      expect(meta.topicsCount).toBe(2);
    });

    it("getSession treats malformed topics_list JSON as zero topics", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          id: "s4",
          filename: "d.mcap",
          status: "ready",
          topics_list: "not-json",
        }),
      );
      const meta = await getSession("s4");
      expect(meta.topicsCount).toBe(0);
    });

    it("getTimeline maps raw events through unchanged", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse([
          { t: 1.5, type: "anomaly", sev: "critical", topic: "/imu", label: "spike" },
        ]),
      );
      const events = await getTimeline("s1");
      expect(events).toEqual([
        { t: 1.5, type: "anomaly", sev: "critical", topic: "/imu", label: "spike" },
      ]);
    });

    it("getTimeline makes failures in a real bag stand out", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse([
          { t: 1, type: "log", sev: "info", topic: "/rosout", label: "ok" },
          { t: 2, type: "log", sev: "warn", topic: "/rosout", label: "warn" },
          { t: 3, type: "log", sev: "error", topic: "/rosout", label: "error" },
          { t: 4, type: "log", sev: "fatal", topic: "/rosout", label: "fatal" },
        ]),
      );
      const events = await getTimeline("s1");
      expect(events.map((e) => [e.type, e.sev])).toEqual([
        ["log", "info"],
        ["log", "warning"],
        ["anomaly", "critical"],
        ["anomaly", "critical"],
      ]);
    });

    it("getTopics fills hz/msgs defaults", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse([{ name: "/odom", type: "nav_msgs/Odometry" }]),
      );
      const topics = await getTopics("s1");
      expect(topics).toEqual([
        { name: "/odom", type: "nav_msgs/Odometry", hz: 0, msgs: 0 },
      ]);
    });

    it("getLogs builds a query string from options and applies field defaults", async () => {
      fetchMock.mockResolvedValue(jsonResponse([{ text: "hi" }]));
      const logs = await getLogs("s1", {
        q: "abort",
        severity: "ERROR",
        limit: 50,
        offset: 10,
      });
      expect(logs).toEqual([{ t: "", node: "", sev: "INFO", text: "hi" }]);

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain(`${BASE}/api/sessions/s1/logs?`);
      expect(url).toContain("q=abort");
      expect(url).toContain("severity=ERROR");
      expect(url).toContain("limit=50");
      expect(url).toContain("offset=10");
    });

    it("getLogs omits the query string when no options are passed", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));
      await getLogs("s1");
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/sessions/s1/logs`);
    });

    it("getLogs treats offset=0 / limit=0 as present (not omitted)", async () => {
      fetchMock.mockResolvedValue(jsonResponse([]));
      await getLogs("s1", { limit: 0, offset: 0 });
      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain("limit=0");
      expect(url).toContain("offset=0");
    });

    it("getKGraph normalizes tuple edges and object edges alike", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          nodes: [{ id: "n1", label: "Session", group: "session" }],
          edges: [["n1", "n2"], { source: "n2", target: "n3" }],
        }),
      );
      const kg = await getKGraph("s1");
      expect(kg.nodes[0]).toMatchObject({ id: "n1", group: "session" });
      expect(kg.edges).toEqual([
        { source: "n1", target: "n2" },
        { source: "n2", target: "n3" },
      ]);
    });

    it("getSessions maps a list of raw sessions", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse([
          { id: "a", filename: "a.mcap", status: "ready" },
          { id: "b", filename: "b.mcap", status: "idle" },
        ]),
      );
      const sessions = await getSessions();
      expect(sessions.map((s) => s.id)).toEqual(["a", "b"]);
    });

    it("deleteSession issues a DELETE and returns the status payload", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: "ok", message: "gone" }));
      const res = await deleteSession("s1");
      expect(res).toEqual({ status: "ok", message: "gone" });
      expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/sessions/s1`);
    });

    it("clearAllSessions DELETEs the collection endpoint", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: "ok", message: "" }));
      await clearAllSessions();
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/sessions`);
      expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
    });

    it("updateBackendKey POSTs provider + key", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: "ok", message: "" }));
      await updateBackendKey("openai", "sk-9");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(`${BASE}/api/settings/keys`);
      expect(JSON.parse(init.body)).toEqual({ provider: "openai", key: "sk-9" });
    });

    it("testApiKey forwards provider/key/endpoint", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: "ok", message: "valid" }));
      await testApiKey("custom", "k", "https://x.test");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        provider: "custom",
        key: "k",
        endpoint: "https://x.test",
      });
    });
  });

  describe("error paths", () => {
    it("rejects a non-ok GET with status in the message", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 404));
      await expect(getSession("missing")).rejects.toThrow(
        "GET /api/sessions/missing → 404",
      );
    });

    it("rejects a non-ok POST with status in the message", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 500));
      await expect(createSession("/x")).rejects.toThrow(
        "POST /api/sessions/create → 500",
      );
    });

    it("rejects a non-ok DELETE with status in the message", async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, 403));
      await expect(deleteSession("s1")).rejects.toThrow(
        "DELETE /api/sessions/s1 → 403",
      );
    });
  });
});

describe("streamChat (SSE parser)", () => {
  it("returns an AbortController immediately", () => {
    fetchMock.mockResolvedValue(sseResponse([]));
    const ac = streamChat("s1", "hi", () => {});
    expect(ac).toBeInstanceOf(AbortController);
  });

  it("POSTs the message + composer overrides to the chat endpoint", async () => {
    fetchMock.mockResolvedValue(sseResponse([]));
    streamChat("s1", "why did it abort?", () => {}, "anthropic", "opus-x");
    // Wait for the fetch microtask to run.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/sessions/s1/chat`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      message: "why did it abort?",
      composer_provider: "anthropic",
      composer_model: "opus-x",
    });
  });

  it("emits parsed events for a normal multi-event stream", async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const onEvent: ChatEventHandler = (event, data) => events.push({ event, data });

    // Two complete SSE frames terminated by a trailing blank line, plus a final
    // empty frame so the last real event is NOT the trailing buffer (issue #34).
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: plan\ndata: {"steps":["a","b"]}\n\n',
        'event: token\ndata: {"text":"hello"}\n\n',
        "\n",
      ]),
    );

    streamChat("s1", "hi", onEvent);
    await vi.waitFor(() => expect(events.length).toBe(2));

    expect(events[0]).toEqual({ event: "plan", data: { steps: ["a", "b"] } });
    expect(events[1]).toEqual({ event: "token", data: { text: "hello" } });
  });

  it("defaults the event name to 'message' when no event: line is present", async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    fetchMock.mockResolvedValue(
      sseResponse(['data: {"v":1}\n\n', "\n"]),
    );
    streamChat("s1", "hi", (event, data) => events.push({ event, data }));
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]).toEqual({ event: "message", data: { v: 1 } });
  });

  it("skips frames with malformed JSON data without throwing", async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    fetchMock.mockResolvedValue(
      sseResponse([
        "event: bad\ndata: {not json}\n\n",
        'event: good\ndata: {"ok":true}\n\n',
        "\n",
      ]),
    );
    streamChat("s1", "hi", (event, data) => events.push({ event, data }));
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]).toEqual({ event: "good", data: { ok: true } });
  });

  it("parses events split across multiple read chunks (buffer reassembly)", async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    fetchMock.mockResolvedValue(
      sseResponse([
        "event: split\nda",
        'ta: {"half":2}\n\n',
        "\n",
      ]),
    );
    streamChat("s1", "hi", (event, data) => events.push({ event, data }));
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]).toEqual({ event: "split", data: { half: 2 } });
  });

  // Regression test for issue #34: when the stream closes WITHOUT a trailing
  // blank-line separator, pump() must still flush the remaining `buffer` so the
  // terminal frame (e.g. the `final` answer) is emitted rather than dropped.
  it("flushes and emits the final buffered event when the stream ends without a blank line (issue #34)", async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    fetchMock.mockResolvedValue(
      // No trailing "\n\n" — this is the last frame and it has no separator.
      sseResponse(['event: done\ndata: {"final":true}']),
    );
    streamChat("s1", "hi", (event, data) => events.push({ event, data }));

    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0].event).toBe("done");
    expect(events[0].data).toEqual({ final: true });
  });

  it("emits an 'error' event when fetch rejects with a network error", async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    fetchMock.mockRejectedValue(new Error("connection refused"));
    streamChat("s1", "hi", (event, data) => events.push({ event, data }));
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0].event).toBe("error");
    expect(events[0].data).toMatchObject({ message: "connection refused" });
  });

  it("emits an 'error' event when the response has no body", async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    // A Response built from null has a null body in jsdom/undici.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    streamChat("s1", "hi", (event, data) => events.push({ event, data }));
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0].event).toBe("error");
    expect(events[0].data).toMatchObject({ message: "No response body" });
  });

  it("stays silent (no error event) when the fetch is aborted", async () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValue(abortErr);
    streamChat("s1", "hi", (event, data) => events.push({ event, data }));
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([]);
  });
});
