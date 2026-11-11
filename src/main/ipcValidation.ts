/**
 * Pure, dependency-free runtime guards for Electron IPC payloads.
 *
 * Every `ipcMain.handle` handler in `ipcHandlers.ts` must treat its arguments
 * as untrusted input coming from a potentially compromised renderer (see
 * AGENT.md → "IPC Validation" and "Security & Privacy Guardrails"). These
 * helpers narrow `unknown` into concrete types and throw `IpcValidationError`
 * with a clean, non-sensitive message when the shape is wrong.
 *
 * There is no Zod dependency in this project, so these are explicit TypeScript
 * type guards / asserts. Keep them small and pure so they remain easy to audit
 * and (eventually) unit-test.
 */
import type { ClaudeCodeAskRequest, ClaudeCodeModel } from "@shared/ipc";


/**
 * Error type for rejected IPC payloads. Thrown from guards and surfaced to the
 * renderer as a rejected `invoke` promise — it never crashes the main process.
 */
export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IpcValidationError";
  }
}

/** Narrows an unknown value to a non-empty string, or throws. */
export function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new IpcValidationError(`${label} must be a string`);
  }
  return value;
}

/** Narrows to a string that is non-empty after trimming, or throws. */
export function assertNonEmptyString(value: unknown, label: string): string {
  const str = assertString(value, label);
  if (str.length === 0) {
    throw new IpcValidationError(`${label} must not be empty`);
  }
  return str;
}

/**
 * Keys that must never be accepted as settings/keychain keys because writing
 * to them on a plain object can pollute the prototype chain (resolves #29).
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Allowed characters for settings / keychain keys: identifier-safe only. */
const SAFE_KEY_RE = /^[a-zA-Z0-9_]+$/;

/**
 * Validates a settings/keychain key. Enforces a strict identifier-only charset
 * and explicitly rejects prototype-pollution vectors. Returns the key on
 * success; throws `IpcValidationError` otherwise.
 */
export function assertSafeKey(value: unknown, label = "key"): string {
  const key = assertNonEmptyString(value, label);
  if (FORBIDDEN_KEYS.has(key)) {
    throw new IpcValidationError(`${label} is not allowed`);
  }
  if (!SAFE_KEY_RE.test(key)) {
    throw new IpcValidationError(
      `${label} contains invalid characters (allowed: A-Z a-z 0-9 _)`,
    );
  }
  return key;
}

/**
 * Settings keys that grant the renderer privileged control over the main
 * process and must therefore NOT be writable through the generic `settings:set`
 * handler (issue #31). `docker_socket` repoints the Docker daemon connection —
 * a root-equivalent capability — so it is delivered out of band (env override,
 * validated by `validateDockerSocket`), never from renderer-writable settings.
 */
const PRIVILEGED_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  "docker_socket",
  // The Claude Code binary DataPilot runs; written only by claudeCode:chooseBinary.
  "claude_code_path",
]);

/**
 * Validates a key for the generic `settings:set` write path. Builds on
 * `assertSafeKey` (charset + prototype-pollution) and additionally refuses
 * privileged keys the renderer must not control.
 */
export function assertSettableKey(value: unknown, label = "key"): string {
  const key = assertSafeKey(value, label);
  if (PRIVILEGED_SETTINGS_KEYS.has(key)) {
    throw new IpcValidationError(`${label} is not settable from the renderer`);
  }
  return key;
}

/**
 * Theme values accepted by the renderer contract (`src/shared/ipc.ts`).
 *
 * NOTE: issue #28 mentions the literal union `'light' | 'dark'`, but the live
 * IPC contract and the renderer also use `'system'` (OS-follow mode). Rejecting
 * `'system'` would break a legitimate call, so the guard accepts the full
 * contract union and rejects everything else.
 */
const THEME_VALUES = ["dark", "light", "system"] as const;
export type Theme = (typeof THEME_VALUES)[number];

/** Validates that a value is one of the allowed theme literals. */
export function assertTheme(value: unknown): Theme {
  if (
    typeof value !== "string" ||
    !(THEME_VALUES as readonly string[]).includes(value)
  ) {
    throw new IpcValidationError(
      `theme must be one of: ${THEME_VALUES.join(", ")}`,
    );
  }
  return value as Theme;
}

/** The backend's MAX_MESSAGE_CHARS. */
export const MAX_QUESTION_CHARS = 32_000;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CLAUDE_MODELS: readonly string[] = ["", "sonnet", "opus", "haiku"];

/** Validates a Copilot question for Claude Code; returns only the three known fields. */
export function assertClaudeCodeAskRequest(value: unknown): ClaudeCodeAskRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IpcValidationError("request must be an object");
  }
  const { sessionId, question, model } = value as Record<string, unknown>;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    throw new IpcValidationError("sessionId is invalid");
  }
  if (typeof question !== "string" || question.trim() === "") {
    throw new IpcValidationError("question must be a non-empty string");
  }
  if (question.length > MAX_QUESTION_CHARS) {
    throw new IpcValidationError("question is too long");
  }
  if (typeof model !== "string" || !CLAUDE_MODELS.includes(model)) {
    throw new IpcValidationError("model is not supported");
  }
  return { sessionId, question, model: model as ClaudeCodeModel };
}

/** Allowed characters for a renderer-supplied log-stream subscription id. */
const SUB_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Validates a `docker:logs` subscription id. */
export function assertSubId(value: unknown): string {
  const subId = assertNonEmptyString(value, "subId");
  // Bound the length so a hostile renderer cannot use the id (which becomes an
  // IPC channel name and a Map key) as an unbounded-memory vector.
  if (subId.length > 128) {
    throw new IpcValidationError("subId is too long");
  }
  if (!SUB_ID_RE.test(subId)) {
    throw new IpcValidationError(
      "subId contains invalid characters (allowed: A-Z a-z 0-9 _ -)",
    );
  }
  return subId;
}

/**
 * Canonical set of Docker services this app orchestrates, mirroring
 * `docker-compose.yml`. The orchestrator accepts either the bare service name
 * (`backend`) or the prefixed container name (`datapilot-backend`), so both
 * forms are allowed here.
 */
const KNOWN_SERVICES: ReadonlySet<string> = new Set([
  "neo4j",
  "backend",
  "mcap-parser",
  "rosbag-reader",
  "trajectory-analyzer",
  "planner-failure-inspector",
  "anomaly-detector",
  "report-composer",
]);

/**
 * Validates that a value names one of the known Docker services, accepting
 * either the bare or the `datapilot-`-prefixed form. Returns the value
 * unchanged (the orchestrator does its own normalization).
 */
export function assertKnownService(value: unknown): string {
  const service = assertNonEmptyString(value, "service");
  const bare = service.startsWith("datapilot-")
    ? service.slice("datapilot-".length)
    : service;
  if (!KNOWN_SERVICES.has(bare)) {
    throw new IpcValidationError(`unknown service: ${service}`);
  }
  return service;
}

/**
 * File extensions that are executable or otherwise unsafe to hand to the OS
 * "open" handler. Matched case-insensitively against the canonicalized path's
 * extension (see `isUnsafeOpenTarget`).
 */
const UNSAFE_OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  ".app",
  ".sh",
  ".command",
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".scpt",
  ".scptd",
  ".zsh",
  ".bash",
  ".ksh",
  ".csh",
  ".fish",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".js",
  ".mjs",
  ".cjs",
  ".jse",
  ".wsf",
  ".wsh",
  ".msi",
  ".msp",
  ".reg",
  ".pkg",
  ".dmg",
  ".jar",
  ".applescript",
  ".action",
  ".workflow",
  ".terminal",
]);

/**
 * Returns true if the (already canonicalized) path has an extension that should
 * never be passed to `shell.openPath` because the OS may execute it.
 *
 * Note the `.app`/`.scptd`/`.workflow` bundles are directories; a path *inside*
 * such a bundle is also rejected by checking every segment for an unsafe
 * extension.
 */
export function isUnsafeOpenTarget(canonicalPath: string): boolean {
  const lower = canonicalPath.toLowerCase();
  // Reject if any path segment ends with an unsafe extension (covers both the
  // leaf file and any *.app / *.workflow bundle ancestor in the path).
  const segments = lower.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments) {
    const dot = segment.lastIndexOf(".");
    if (dot <= 0) continue;
    const ext = segment.slice(dot);
    if (UNSAFE_OPEN_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

export interface DockerSocketOptions {
  /** The platform default socket path used when no override is supplied. */
  platformDefault: string;
  /** Whether the host is Windows (named-pipe form instead of a unix socket). */
  isWindows: boolean;
  /**
   * Directories an override socket is allowed to live in (non-Windows). The
   * override's parent directory must match one of these exactly. Computed by
   * the orchestrator from vetted locations (e.g. `/var/run`, `~/.colima/...`).
   */
  allowedDirs: readonly string[];
}

/**
 * Validates a Docker socket path (issue #31).
 *
 * The renderer can no longer write `docker_socket` (see `assertSettableKey`);
 * the only override channel is a trusted environment variable. We still sanity-
 * check that value so a bad env cannot repoint the daemon connection to an
 * arbitrary location. Empty/missing → the platform default. On Windows only the
 * `\\.\pipe\` named-pipe form is accepted. On Unix the path must be absolute,
 * free of `..` traversal and URL schemes, and its parent directory must be on
 * the allow-list (or equal the platform default). Throws otherwise.
 */
export function validateDockerSocket(
  value: unknown,
  opts: DockerSocketOptions,
): string {
  const { platformDefault, isWindows, allowedDirs } = opts;
  if (value === undefined || value === null || value === "") {
    return platformDefault;
  }
  const socket = assertString(value, "docker_socket");
  if (socket === platformDefault) return socket;

  if (isWindows) {
    if (/^\\\\\.\\pipe\\[A-Za-z0-9_.-]+$/.test(socket)) return socket;
    throw new IpcValidationError(
      "docker_socket must be a \\\\.\\pipe\\ named pipe",
    );
  }

  if (socket.includes("://")) {
    throw new IpcValidationError("docker_socket must be a filesystem socket");
  }
  if (!socket.startsWith("/")) {
    throw new IpcValidationError("docker_socket must be an absolute path");
  }
  if (socket.split("/").includes("..")) {
    throw new IpcValidationError("docker_socket must not contain '..'");
  }
  const lastSlash = socket.lastIndexOf("/");
  const dir = lastSlash <= 0 ? "/" : socket.slice(0, lastSlash);
  if (!allowedDirs.includes(dir)) {
    throw new IpcValidationError("docker_socket is in a disallowed directory");
  }
  return socket;
}

/** ROS bag extensions recognized as "open with DataPilot" targets. */
const BAG_EXT_RE = /\.(mcap|db3|bag)$/i;

/**
 * Extracts a bag file path from a process argv array (issue #51).
 *
 * Used by the `second-instance` handler so that double-clicking a `.mcap` /
 * `.db3` / `.bag` while the app is already running opens it. Flags (leading
 * `-`) and non-string entries are ignored; returns the first bag-like argument
 * or `null` if none is present.
 */
export function extractBagPathFromArgv(
  argv: readonly unknown[],
): string | null {
  for (const arg of argv) {
    if (typeof arg !== "string") continue;
    if (arg.startsWith("-")) continue;
    if (BAG_EXT_RE.test(arg)) return arg;
  }
  return null;
}

/**
 * Returns true if `child` is equal to, or nested under, `root`. Both inputs
 * must already be canonicalized (resolved + normalized). Comparison is
 * separator-aware so `/home/userfoo` is NOT considered under `/home/user`.
 */
export function isPathWithinRoot(
  child: string,
  root: string,
  separator: string,
): boolean {
  // Windows paths are case-insensitive; compare case-folded there so casing
  // differences (e.g. drive letters) don't reject a legitimately-nested path.
  const ci = process.platform === "win32";
  const c = ci ? child.toLowerCase() : child;
  const r = ci ? root.toLowerCase() : root;
  if (c === r) return true;
  const rootWithSep = r.endsWith(separator) ? r : r + separator;
  return c.startsWith(rootWithSep);
}
