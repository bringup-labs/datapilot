import type { ClaudeCodeStatus } from "../../shared/ipc";
import { getAuthStatus } from "./auth";
import { locateClaude } from "./locate";
import { getMcpToken } from "./mcpToken";
import { checkToolEndpoint } from "./toolEndpoint";

export async function getClaudeCodeStatus(opts: {
  home: string;
  savedPath: string | null;
  pathEnv?: string;
  knownDirs?: string[];
  fetchImpl?: typeof fetch;
}): Promise<ClaudeCodeStatus> {
  const [install, tools] = await Promise.all([
    locateClaude({
      pathEnv: opts.pathEnv ?? process.env.PATH,
      home: opts.home,
      savedPath: opts.savedPath,
      knownDirs: opts.knownDirs,
    }),
    checkToolEndpoint({ token: getMcpToken(), fetchImpl: opts.fetchImpl }),
  ]);
  const auth =
    install.state === "found" ? await getAuthStatus(install.path) : null;
  return {
    install,
    auth,
    tools,
    ready: install.state === "found" && !!auth?.signedIn && tools.reachable,
  };
}
