// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

describe("getMcpToken", () => {
  it("creates one 64-character hex token per launch", async () => {
    const { getMcpToken } = await import("./mcpToken");
    expect(getMcpToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(getMcpToken()).toBe(getMcpToken());
    vi.resetModules();
    const nextLaunch = await import("./mcpToken");
    expect(nextLaunch.getMcpToken()).not.toBe(getMcpToken());
  });
});
