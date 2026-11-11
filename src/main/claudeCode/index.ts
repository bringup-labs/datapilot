import os from "node:os";
import type { ClaudeCodeStatus } from "@shared/ipc";
import { getAuthStatus } from "./auth";
import { resolveGuidePath } from "./guide";
import { locateClaude } from "./locate";
import { getMcpToken } from "./mcpToken";
import { createClaudeRunner, type ClaudeRunner } from "./runner";
import { getClaudeCodeStatus } from "./status";

// Nothing here touches `electron` at import time: resolveGuidePath only reads
// `app` when it is called.
export const claudeRunner: ClaudeRunner = createClaudeRunner({
  locate: (savedPath) =>
    locateClaude({ pathEnv: process.env.PATH, home: os.homedir(), savedPath }),
  getAuthStatus,
  guidePath: resolveGuidePath,
  getToken: getMcpToken,
});

export function currentStatus(savedPath: string | null): Promise<ClaudeCodeStatus> {
  return getClaudeCodeStatus({ home: os.homedir(), savedPath });
}
