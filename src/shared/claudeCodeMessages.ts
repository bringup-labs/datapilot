import { CLAUDE_CODE_MIN_VERSION, type ClaudeCodeErrorCode } from "./ipc";

/** Ends an answer the user stopped; the Copilot adds the same marker on Stop. */
export const STOPPED_BY_USER = "*Generation stopped by user.*";

const ERROR_TEXT: Record<Exclude<ClaudeCodeErrorCode, "usage_limit">, string> = {
  not_installed: "Claude Code isn't set up on this computer",
  too_old: `DataPilot needs Claude Code ${CLAUDE_CODE_MIN_VERSION} or later`,
  signed_out: "Claude Code isn't signed in",
  api_key_rejected: "Claude Code's API key was rejected or is out of credit",
  tools_unreachable: "Claude Code couldn't reach DataPilot's tools",
  no_bag: "Claude Code answers questions about a loaded bag. Load a bag first, or switch to DataPilot's agents.",
  failed: "Claude Code couldn't finish this answer",
};

/**
 * What the Copilot says when a Claude Code answer fails. The usage limit names
 * its reset time only when Claude Code reported one (seconds or milliseconds),
 * with the weekday when that isn't today: "until 3:00 PM", "until Mon 9:00 AM".
 */
export function claudeCodeErrorText(code: ClaudeCodeErrorCode, opts?: { resetsAt?: number }): string {
  if (code !== "usage_limit") return ERROR_TEXT[code];
  const resetsAt = opts?.resetsAt;
  const reset = resetsAt === undefined ? null : new Date(resetsAt < 1e12 ? resetsAt * 1000 : resetsAt);
  if (!reset || Number.isNaN(reset.getTime())) {
    return "Your Claude plan's usage limit is reached. Your question is saved.";
  }
  const today = reset.toDateString() === new Date().toDateString();
  const time = reset.toLocaleString(
    "en-US",
    today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" },
  );
  return `Your Claude plan's usage limit is reached until ${time}. Your question is saved.`;
}
