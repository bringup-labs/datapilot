/**
 * Typed IPC contracts shared by main, preload, and renderer.
 *
 * Convention:
 *   - Channel names follow `<namespace>:<verb>` (e.g. `docker:status`).
 *   - Request and response shapes are declared here.
 *   - Preload exposes a strongly-typed `window.datapilot.*` surface.
 */

export type DockerStatus =
  | { state: "pending"; progress?: number; step?: string }
  | { state: "ready" }
  | { state: "error"; code: DockerErrorCode; message: string };

export type DockerErrorCode =
  | "daemon_off"
  | "permission_denied"
  | "image_pull_failed"
  | "port_conflict"
  | "unknown";

export interface StorageUsage {
  path: string;
  resolvedPath: string;
  exists: boolean;
  totalBytes: number;
  fileCount: number;
  /** True if a depth/entry cap stopped the walk before completion (#37). */
  truncated?: boolean;
}

/** Result of a `keychain:set` write so the renderer can surface failures (#51). */
export interface KeychainSetResult {
  ok: boolean;
  error?: string;
}

/** Oldest Claude Code release DataPilot supports. */
export const CLAUDE_CODE_MIN_VERSION = "2.1.268";
export const CLAUDE_CODE_INSTALL_GUIDE_URL = "https://code.claude.com/docs/en/setup";

export type CopilotEngine = "datapilot" | "claude_code";
export type ClaudeCodeModel = "" | "sonnet" | "opus" | "haiku";
export type ClaudeAuthMethod =
  | "claude.ai"
  | "oauth_token"
  | "api_key"
  | "api_key_helper"
  | "third_party"
  | "none";

export type ClaudeCodeErrorCode =
  | "not_installed"
  | "too_old"
  | "signed_out"
  | "usage_limit"
  | "api_key_rejected"
  | "tools_unreachable"
  | "no_bag"
  | "failed";

export type ClaudeCodeInstall =
  | { state: "found"; path: string; version: string }
  | { state: "too_old"; path: string; version: string }
  | { state: "missing" };

export interface ClaudeCodeAuth {
  signedIn: boolean;
  method: ClaudeAuthMethod;
  configDirectory: string | null;
}

export interface ClaudeCodeTools {
  reachable: boolean;
  names: string[];
}

export interface ClaudeCodeStatus {
  install: ClaudeCodeInstall;
  auth: ClaudeCodeAuth | null;
  tools: ClaudeCodeTools;
  ready: boolean;
}

/** A Copilot question for Claude Code about the bag open in `sessionId`. */
export interface ClaudeCodeAskRequest {
  sessionId: string;
  question: string;
  model: ClaudeCodeModel;
}

/** A Claude Code answer as the backend saved it (the turn-completion envelope). */
export interface ClaudeCodeFinal {
  response: string;
  findings: Array<{ sev: string; text: string; detail?: string; log_ids: string[] }>;
  causal: Array<{ label: string; log_id?: string }>;
  plan: Array<{ label: string; tool: string }>;
  usage: { tokens_in: number; tokens_out: number; est_cost_usd: number };
  partial: boolean;
  answered_by: "claude_code";
  verified: boolean;
  flagged_log_ids: string[];
  claude_code_usage: { model: string; auth_method: ClaudeAuthMethod; tool_calls: number; est_cost_usd: number };
}

/** Chat events from a Claude Code run, in the shape the Copilot's chat handler takes. */
export type ClaudeCodeChatEvent =
  | { event: "step-add"; data: { label: string } }
  | { event: "step-done"; data: { idx: number; output_summary?: string } }
  | { event: "final"; data: ClaudeCodeFinal }
  | { event: "error"; data: { code: ClaudeCodeErrorCode; message: string } };

export interface DatapilotApi {
  /** Returns the current Electron app version and platform info. Available immediately. */
  app: {
    version(): Promise<string>;
    platform(): Promise<NodeJS.Platform>;
    userDataPath(): Promise<string>;
    homePath(): Promise<string>;
  };
  /** Controls and monitors the local Docker services stack. */
  docker: {
    status(): Promise<DockerStatus>;
    retry(): Promise<void>;
    onStatusChanged(callback: (status: DockerStatus) => void): () => void;
    /**
     * Streams logs from a service container (e.g. "backend" or "datapilot-backend").
     * Returns an unsubscribe function that closes the stream on the main side.
     */
    streamLogs(
      service: string,
      onChunk: (chunk: string) => void,
    ): Promise<() => Promise<void>>;
  };
  /** Prompts user to pick a ROS bag file via native OS dialogs. */
  file: {
    pickBag(): Promise<string | null>;
    /**
     * Fires when a second app instance is launched with a bag file argument
     * ("Open with DataPilot" on an already-running app, #51). Returns an
     * unsubscribe function.
     */
    onOpenBag(callback: (bagPath: string) => void): () => void;
  };
  /** Theme preference operations. */
  theme: {
    get(): Promise<"dark" | "light" | "system">;
    set(theme: "dark" | "light" | "system"): Promise<void>;
  };
  /** Local storage settings (e.g., config parameters). */
  settings: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
  };
  /** Secure credential storage using Electron's safeStorage. */
  keychain: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<KeychainSetResult>;
  };
  /** Launches file/folder path with host defaults. */
  shell: {
    openPath(path: string): Promise<void>;
  };
  /** Filesystem usage helpers for renderer panels. */
  storage: {
    usage(path: string): Promise<StorageUsage>;
  };
  /** Claude Code as a Copilot engine. The renderer never supplies a path or URL. */
  claudeCode: {
    status(): Promise<ClaudeCodeStatus>;
    signIn(): Promise<ClaudeCodeStatus>;
    /** Opens a native file dialog; rejects with "That file isn't Claude Code." for a file without a version. */
    chooseBinary(): Promise<ClaudeCodeStatus>;
    openInstallGuide(): Promise<void>;
    /** Resolves once the run has started; the returned function stops it and unsubscribes. */
    ask(
      request: ClaudeCodeAskRequest,
      onEvent: (event: ClaudeCodeChatEvent) => void,
    ): Promise<() => Promise<void>>;
  };
}

declare global {
  interface Window {
    datapilot: DatapilotApi;
  }
}

export {};
