import { randomBytes } from "node:crypto";

/**
 * Bearer token that guards the backend's `/mcp` tool endpoint. Generated once
 * per app launch and held only in memory here; it reaches the backend through
 * the mode-0600 secrets file (`mcp_token`), never through the environment or
 * logs.
 */
let token: string | undefined;

export function getMcpToken(): string {
  token ??= randomBytes(32).toString("hex");
  return token;
}
