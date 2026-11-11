import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { ClaudeAuthMethod, ClaudeCodeAuth } from "../../shared/ipc";
import { buildClaudeEnv } from "./env";

const METHODS: readonly ClaudeAuthMethod[] = [
  "claude.ai",
  "oauth_token",
  "api_key",
  "api_key_helper",
  "third_party",
  "none",
];

const SIGNED_OUT: ClaudeCodeAuth = {
  signedIn: false,
  method: "none",
  configDirectory: null,
};

/** Reads only `authMethod` and `configDirectory`; every other field is ignored. */
export function parseAuthStatus(
  stdout: string,
  exitCode: number | null,
): ClaudeCodeAuth {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ...SIGNED_OUT };
  }
  if (typeof data !== "object" || data === null) return { ...SIGNED_OUT };
  const rec = data as Record<string, unknown>;
  const raw = rec.authMethod;
  // A method this version doesn't know is still a sign-in. Who pays isn't
  // known, so it reads as "your cloud provider", like third_party.
  const method: ClaudeAuthMethod = METHODS.includes(raw as ClaudeAuthMethod)
    ? (raw as ClaudeAuthMethod)
    : typeof raw === "string" && raw.trim() !== ""
      ? "third_party"
      : "none";
  const configDirectory =
    typeof rec.configDirectory === "string" ? rec.configDirectory : null;
  return {
    signedIn: exitCode === 0 && method !== "none",
    method,
    configDirectory,
  };
}

export function getAuthStatus(binaryPath: string): Promise<ClaudeCodeAuth> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      ["auth", "status"],
      { env: buildClaudeEnv(process.env, binaryPath), timeout: 15_000 },
      (err, stdout) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : null
          : 0;
        resolve(parseAuthStatus(String(stdout ?? ""), code));
      },
    );
  });
}

let inFlight: Promise<ClaudeCodeAuth> | null = null;
let loginProc: ChildProcess | null = null;

/** Runs Claude Code's own sign-in. Its output is never read. */
export function signIn(
  binaryPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<ClaudeCodeAuth> {
  if (inFlight) return inFlight;
  const run = new Promise<void>((resolve) => {
    const child = spawn(binaryPath, ["auth", "login"], {
      env: buildClaudeEnv(process.env, binaryPath),
      stdio: "ignore",
    });
    loginProc = child;
    const timer = setTimeout(
      () => child.kill("SIGTERM"),
      opts.timeoutMs ?? 300_000,
    );
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once("error", done);
    child.once("exit", done);
  });
  inFlight = run
    .then(() => getAuthStatus(binaryPath))
    .finally(() => {
      inFlight = null;
      loginProc = null;
    });
  return inFlight;
}

export function cancelSignIn(): void {
  loginProc?.kill("SIGTERM");
}
