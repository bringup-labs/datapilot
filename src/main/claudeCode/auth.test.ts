// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FAKE_CLAUDE,
  readFakeRecords,
} from "../../test/claude-code/fakeClaude";
import { getAuthStatus, parseAuthStatus, signIn } from "./auth";

afterEach(() => vi.unstubAllEnvs());

const recordFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dp-rec-")), "rec.jsonl");

describe("auth status", () => {
  it("reads only authMethod and configDirectory", () => {
    expect(
      parseAuthStatus(
        '{"loggedIn":true,"authMethod":"api_key","configDirectory":"/x","email":"a@b.c"}',
        0,
      ),
    ).toEqual({ signedIn: true, method: "api_key", configDirectory: "/x" });
  });

  it("treats a non-zero exit, authMethod none or unreadable output as signed out", () => {
    expect(parseAuthStatus('{"authMethod":"claude.ai"}', 1).signedIn).toBe(
      false,
    );
    expect(parseAuthStatus('{"authMethod":"none"}', 0)).toEqual({
      signedIn: false,
      method: "none",
      configDirectory: null,
    });
    expect(parseAuthStatus("not json", 0)).toEqual({
      signedIn: false,
      method: "none",
      configDirectory: null,
    });
  });

  // A newer Claude Code may sign in in a way DataPilot doesn't know yet. It is
  // still signed in; who pays isn't known, so it reads as "your cloud provider".
  it("counts an unknown sign-in method as signed in, through a third party", () => {
    expect(parseAuthStatus('{"authMethod":"some_new_sso","configDirectory":"/x"}', 0)).toEqual({
      signedIn: true,
      method: "third_party",
      configDirectory: "/x",
    });
    for (const out of ['{"authMethod":""}', '{"authMethod":5}', "{}"]) {
      expect(parseAuthStatus(out, 0)).toEqual({ signedIn: false, method: "none", configDirectory: null });
    }
    expect(parseAuthStatus('{"authMethod":"some_new_sso"}', 1).signedIn).toBe(false);
  });

  it("asks the binary for its sign-in", async () => {
    vi.stubEnv("FAKE_CLAUDE_AUTH_JSON", '{"authMethod":"third_party"}');
    expect(await getAuthStatus(FAKE_CLAUDE)).toEqual({
      signedIn: true,
      method: "third_party",
      configDirectory: null,
    });
  });

  it("reads a signed-out answer from a non-zero exit", async () => {
    vi.stubEnv(
      "FAKE_CLAUDE_AUTH_JSON",
      '{"loggedIn":false,"authMethod":"none"}',
    );
    expect((await getAuthStatus(FAKE_CLAUDE)).signedIn).toBe(false);
  });
});

describe("signIn", () => {
  it("signs in through claude auth login without reading what it prints, then re-checks", async () => {
    const file = recordFile();
    vi.stubEnv("FAKE_CLAUDE_RECORD", file);
    const result = await signIn(FAKE_CLAUDE);
    expect(readFakeRecords(file).map((r) => r.argv.slice(0, 2))).toEqual([
      ["auth", "login"],
      ["auth", "status"],
    ]);
    expect(result).toEqual({
      signedIn: true,
      method: "claude.ai",
      configDirectory: "/home/test/.claude",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("runs one sign-in at a time", async () => {
    const file = recordFile();
    vi.stubEnv("FAKE_CLAUDE_RECORD", file);
    await Promise.all([signIn(FAKE_CLAUDE), signIn(FAKE_CLAUDE)]);
    expect(
      readFakeRecords(file).filter((r) => r.argv[1] === "login"),
    ).toHaveLength(1);
  });
});
