// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildClaudeEnv } from "./env";

describe("buildClaudeEnv", () => {
  it("prepends the binary's folder to PATH and adds or removes nothing else", () => {
    const base = {
      PATH: "/usr/bin:/bin",
      ANTHROPIC_API_KEY: "sk-user",
      HOME: "/home/u",
    };
    const env = buildClaudeEnv(base, "/opt/claude/bin/claude");
    expect(env.PATH).toBe("/opt/claude/bin:/usr/bin:/bin");
    expect(Object.keys(env).sort()).toEqual(Object.keys(base).sort());
    expect(env.ANTHROPIC_API_KEY).toBe("sk-user");
    expect(
      buildClaudeEnv({ PATH: "/opt/claude/bin:/bin" }, "/opt/claude/bin/claude")
        .PATH,
    ).toBe("/opt/claude/bin:/bin");
    expect(
      buildClaudeEnv(base, "/x/claude", {
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      }).CLAUDE_CODE_DISABLE_AUTO_MEMORY,
    ).toBe("1");
  });
});
