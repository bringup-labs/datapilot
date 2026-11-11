// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FAKE_CLAUDE } from "../../test/claude-code/fakeClaude";
import { getClaudeCodeStatus } from "./status";

afterEach(() => vi.unstubAllEnvs());

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const okFetch = () =>
  vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [{ name: "find_aborts" }] },
        }),
      ),
  ) as unknown as typeof fetch;

function withFake() {
  const bin = tmp("dp-bin-");
  fs.symlinkSync(FAKE_CLAUDE, path.join(bin, "claude"));
  return {
    home: tmp("dp-home-"),
    savedPath: null,
    pathEnv: bin,
    knownDirs: [] as string[],
  };
}

describe("getClaudeCodeStatus", () => {
  it("is ready only when Claude Code is found, signed in and the tools answer", async () => {
    const base = withFake();
    const ready = await getClaudeCodeStatus({ ...base, fetchImpl: okFetch() });
    expect(ready.install.state).toBe("found");
    expect(ready.auth).toEqual({
      signedIn: true,
      method: "claude.ai",
      configDirectory: "/home/test/.claude",
    });
    expect(ready.tools).toEqual({ reachable: true, names: ["find_aborts"] });
    expect(ready.ready).toBe(true);

    vi.stubEnv("FAKE_CLAUDE_AUTH_JSON", '{"authMethod":"none"}');
    expect(
      (await getClaudeCodeStatus({ ...base, fetchImpl: okFetch() })).ready,
    ).toBe(false);
    vi.unstubAllEnvs();

    const refused = vi.fn(
      async () => new Response("no", { status: 401 }),
    ) as unknown as typeof fetch;
    expect(
      (await getClaudeCodeStatus({ ...base, fetchImpl: refused })).ready,
    ).toBe(false);
  });

  it("skips the sign-in check when Claude Code is missing", async () => {
    const status = await getClaudeCodeStatus({
      home: tmp("dp-home-"),
      savedPath: null,
      pathEnv: "",
      knownDirs: [],
      fetchImpl: okFetch(),
    });
    expect(status.install).toEqual({ state: "missing" });
    expect(status.auth).toBeNull();
    expect(status.tools.reachable).toBe(true);
    expect(status.ready).toBe(false);
  });
});
