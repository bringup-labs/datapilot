// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { checkToolEndpoint } from "./toolEndpoint";

describe("checkToolEndpoint", () => {
  it("lists DataPilot's tools with this launch's token", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              tools: [{ name: "find_aborts" }, { name: "submit_findings" }],
            },
          }),
        ),
    );
    expect(
      await checkToolEndpoint({ token: "t".repeat(64), fetchImpl }),
    ).toEqual({
      reachable: true,
      names: ["find_aborts", "submit_findings"],
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://localhost:8000/mcp");
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${"t".repeat(64)}`,
      Accept: "application/json, text/event-stream",
    });
    expect(JSON.parse(init?.body as string)).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/list",
    });
  });

  it("reports unreachable on a network error or a refused token", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await checkToolEndpoint({ token: "t", fetchImpl: down })).toEqual({
      reachable: false,
      names: [],
    });
    const refused = vi.fn(async () => new Response("no", { status: 401 }));
    expect(await checkToolEndpoint({ token: "t", fetchImpl: refused })).toEqual(
      {
        reachable: false,
        names: [],
      },
    );
  });

  it("reports unreachable when the answer has no tool list", async () => {
    const odd = vi.fn(async () => new Response(JSON.stringify({ result: {} })));
    expect(await checkToolEndpoint({ token: "t", fetchImpl: odd })).toEqual({
      reachable: false,
      names: [],
    });
  });
});
