import type { ClaudeCodeTools } from "../../shared/ipc";

export const BACKEND_URL = "http://localhost:8000";
export const MCP_URL = "http://localhost:8000/mcp";

/** Asks the backend's `/mcp` endpoint for its tool list with this launch's token. */
export async function checkToolEndpoint(opts: {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ClaudeCodeTools> {
  const down: ClaudeCodeTools = { reachable: false, names: [] };
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
    });
    if (!res.ok) return down;
    const body = (await res.json()) as { result?: { tools?: unknown } };
    const tools = body?.result?.tools;
    if (!Array.isArray(tools)) return down;
    const names = tools
      .map((t) => (t as { name?: unknown })?.name)
      .filter((n): n is string => typeof n === "string");
    return { reachable: true, names };
  } catch {
    return down;
  }
}
