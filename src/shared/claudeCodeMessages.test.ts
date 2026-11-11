import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeCodeErrorText } from "./claudeCodeMessages";
import type { ClaudeCodeErrorCode } from "./ipc";

afterEach(() => vi.useRealTimers());

/** Seconds since the epoch for a local time, as Claude Code reports `resetsAt`. */
const at = (...local: [number, number, number, number, number]) => new Date(...local).getTime() / 1000;

describe("claudeCodeErrorText", () => {
  it.each([
    ["not_installed", "Claude Code isn't set up on this computer"],
    ["too_old", "DataPilot needs Claude Code 2.1.268 or later"],
    ["signed_out", "Claude Code isn't signed in"],
    ["api_key_rejected", "Claude Code's API key was rejected or is out of credit"],
    ["tools_unreachable", "Claude Code couldn't reach DataPilot's tools"],
    ["no_bag", "Claude Code answers questions about a loaded bag. Load a bag first, or switch to DataPilot's agents."],
    ["failed", "Claude Code couldn't finish this answer"],
  ])("words %s as the spec does", (code, text) => expect(claudeCodeErrorText(code as ClaudeCodeErrorCode)).toBe(text));

  it("shows the usage limit's reset time only when Claude Code reports one", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 9, 10, 0) }); // Monday, 10:00
    expect(claudeCodeErrorText("usage_limit")).toBe("Your Claude plan's usage limit is reached. Your question is saved.");
    expect(claudeCodeErrorText("usage_limit", { resetsAt: at(2026, 10, 9, 15, 0) })).toBe(
      "Your Claude plan's usage limit is reached until 3:00 PM. Your question is saved.",
    );
  });

  it("names the day when the limit resets on another day", () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 9, 22, 0) }); // Monday, 22:00
    expect(claudeCodeErrorText("usage_limit", { resetsAt: at(2026, 10, 10, 9, 0) })).toBe(
      "Your Claude plan's usage limit is reached until Tue 9:00 AM. Your question is saved.",
    );
    expect(claudeCodeErrorText("usage_limit", { resetsAt: at(2026, 10, 16, 9, 0) })).toBe(
      "Your Claude plan's usage limit is reached until Mon 9:00 AM. Your question is saved.",
    );
  });

  it("reads the reset time in seconds or milliseconds", () => {
    expect(claudeCodeErrorText("usage_limit", { resetsAt: 1767297600_000 })).toBe(
      claudeCodeErrorText("usage_limit", { resetsAt: 1767297600 }),
    );
  });
});
