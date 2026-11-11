import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { STOPPED_BY_USER, claudeCodeErrorText } from "../../shared/claudeCodeMessages";
import type {
  ClaudeAuthMethod,
  ClaudeCodeAskRequest,
  ClaudeCodeAuth,
  ClaudeCodeChatEvent,
  ClaudeCodeErrorCode,
  ClaudeCodeFinal,
  ClaudeCodeInstall,
  ClaudeCodeModel,
} from "../../shared/ipc";
import { isPathWithinRoot } from "../ipcValidation";
import { buildClaudeEnv } from "./env";
import { createStreamParser, type ParsedEvent } from "./streamParser";
import { BACKEND_URL, MCP_URL } from "./toolEndpoint";

export const CLAUDE_CODE_MAX_TURNS = 25;

/** How a run keeps out the user's Claude Code customizations: `--safe-mode`, or the narrower fallback switches. */
export type CleanMode = "safe" | "fallback";

const TURN_CAP = `*Claude Code reached DataPilot's limit of ${CLAUDE_CODE_MAX_TURNS} turns for one question.*`;
const TIME_CAP = "*Claude Code ran longer than 10 minutes, so DataPilot stopped it.*";
const FALLBACK_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md"],
});
/** Upper bound for one call to the local backend, so a hung backend can't hold a run (or its Stop) forever. */
const BACKEND_TIMEOUT_MS = 30_000;
/** The backend saves at most this many steps per turn (`AgentTurnComplete.steps`). */
const MAX_SAVED_STEPS = 200;
/** The backend saves at most this many characters of an answer (`AgentTurnComplete.response`). */
const MAX_RESPONSE_CHARS = 100_000;

export function buildArgs(opts: {
  mcpConfigPath: string;
  guidePath: string;
  model: ClaudeCodeModel;
  maxTurns: number;
  mode: CleanMode;
}): string[] {
  const args = [
    "-p", "--no-session-persistence",
    "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--mcp-config", opts.mcpConfigPath, "--strict-mcp-config",
    "--tools", "", "--allowedTools", "mcp__datapilot", "--permission-mode", "dontAsk",
    "--append-system-prompt-file", opts.guidePath,
    "--max-turns", String(opts.maxTurns),
  ];
  if (opts.mode === "safe") args.push("--safe-mode");
  else args.push("--settings", FALLBACK_SETTINGS, "--disable-slash-commands");
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export interface HistoryRow {
  role: string;
  content: string;
  answered_by?: string | null;
  findings?: Array<{ sev?: string; text?: string; log_ids?: string[] }> | null;
}

const RECAP_TURNS = 6;
const RECAP_QUESTION_CHARS = 600;
const RECAP_SUMMARY_CHARS = 600;
const RECAP_FINDINGS = 5;
const RECAP_FINDING_CHARS = 200;
const RECAP_LOG_IDS = 3;

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max)}…` : value);

function findingLines(findings: unknown): string[] {
  if (!Array.isArray(findings)) return [];
  const lines: string[] = [];
  for (const finding of findings) {
    if (lines.length === RECAP_FINDINGS) break;
    if (typeof finding !== "object" || finding === null) continue;
    const { sev, text, log_ids } = finding as Record<string, unknown>;
    const body = trimmed(text);
    if (!body) continue;
    const ids = Array.isArray(log_ids)
      ? log_ids.filter((id): id is string => typeof id === "string" && id !== "").slice(0, RECAP_LOG_IDS)
      : [];
    const cited = ids.length ? ` (${ids.join(", ")})` : "";
    lines.push(`- [${trimmed(sev) || "info"}] ${clip(body, RECAP_FINDING_CHARS)}${cited}`);
  }
  return lines;
}

/**
 * The chat so far, for a Claude Code run that starts with no memory: the last
 * six questions with their summaries and verified findings, shortened, then
 * the new question in full. It never starts with "/", which `claude -p` would
 * read as a slash command (ROS topic names start with one).
 */
export function buildRecap(rows: HistoryRow[], question: string): string {
  const turns: Array<{ asked: string; answer: HistoryRow | null }> = [];
  for (const row of rows) {
    if (row?.role === "user") turns.push({ asked: clip(trimmed(row.content), RECAP_QUESTION_CHARS), answer: null });
    else if (row?.role === "assistant") {
      const last = turns.at(-1);
      if (last && !last.answer) last.answer = row;
    }
  }
  if (turns.length === 0) return question.trimStart().startsWith("/") ? `Question:\n${question}` : question;
  const blocks = turns.slice(-RECAP_TURNS).map(({ asked, answer }) => {
    if (!answer) return `Q: ${asked}\nA: (no answer)`;
    const who = answer.answered_by === "claude_code" ? "Claude Code" : "DataPilot's agents";
    const lines = [`Q: ${asked}`, `A (${who}): ${clip(trimmed(answer.content), RECAP_SUMMARY_CHARS)}`];
    const findings = findingLines(answer.findings);
    if (findings.length) lines.push("Verified findings:", ...findings);
    return lines.join("\n");
  });
  return `Earlier in this chat, oldest first:\n\n${blocks.join("\n\n")}\n\nQuestion:\n${question}`;
}

export interface RunnerDeps {
  locate(savedPath: string | null): Promise<ClaudeCodeInstall>;
  getAuthStatus(binaryPath: string): Promise<ClaudeCodeAuth>;
  guidePath(): string;
  getToken(): string;
  backendUrl?: string; // default BACKEND_URL
  mcpUrl?: string; // default MCP_URL
  fetchImpl?: typeof fetch;
  tmpRoot?: string; // default: os.tmpdir(), or "/tmp" when that is inside the home folder
  stopGraceMs?: number; // default 5_000
  runTimeoutMs?: number; // default 600_000
}

export interface AskOptions extends ClaudeCodeAskRequest {
  subId: string;
  savedPath: string | null;
  onEvent(event: ClaudeCodeChatEvent): void;
}

export interface ClaudeRunner {
  ask(opts: AskOptions): Promise<void>;
  stop(subId: string): Promise<void>;
  killAll(): void;
  cleanMode(): CleanMode | null;
}

/** One question. It has at most one Claude Code process at a time, all in one run folder. */
interface Run {
  child: ChildProcess | null;
  folder: string | null;
  /** A Claude Code process was started for this question. */
  spawned: boolean;
  stopReason: "user" | "timeout" | null;
  /** Ended by killAll (DataPilot is quitting): no turn completion and no event. */
  killed: boolean;
  /** The time cap and the stop escalations, cleared when the run settles. */
  timers: Set<NodeJS.Timeout>;
  /** Resolves when `ask` has settled. Never rejects. */
  settled: Promise<void>;
}

/** A created turn, ready for Claude Code. */
interface Turn {
  binaryPath: string;
  authMethod: ClaudeAuthMethod;
  turnId: string;
}

/** What one Claude Code process needs. */
interface Launch {
  turn: Turn;
  cwd: string;
  mcpConfigPath: string;
  guidePath: string;
  model: ClaudeCodeModel;
  recap: string;
}

/** What Claude Code reported during the run. */
interface Report {
  model: string;
  steps: Array<{ tool: string; label: string }>;
  result: Extract<ParsedEvent, { kind: "result" }> | null;
  failure: { code: ClaudeCodeErrorCode; resetsAt?: number } | null;
  toolsUnreachable: boolean;
  /** How the last Claude Code process ended, for the log: "exit code 1", "signal SIGTERM" or "error ENOENT". */
  exit: string | null;
}

/** A question that failed before Claude Code started, and why, for the log. */
interface Refusal {
  code: ClaudeCodeErrorCode;
  detail: string | null;
}

type Send = (event: ClaudeCodeChatEvent) => void;

type Ending =
  | { status: "completed" | "stopped"; response: string }
  /** `code` null: stopped before Claude Code started, so the turn is dropped without an event. */
  | { status: "failed"; code: ClaudeCodeErrorCode | null; resetsAt?: number; detail: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** Stopped, or quitting: a run checks this before each step and before starting Claude Code. */
const isHalted = (run: Run) => run.killed || run.stopReason !== null;

/** At most `max` characters, without splitting a surrogate pair. Python, which checks the limit, counts no more. */
function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** The answer so far, then the marker. Within the backend's limit, so the marker is never what gets cut. */
const withMarker = (resultText: string | undefined, marker: string) =>
  `${clipText(resultText ?? "", MAX_RESPONSE_CHARS - marker.length - 2)}\n\n${marker}`.trim();

/**
 * A failure's code for the log: a system error code such as ECONNREFUSED, or
 * the error's class. Never its message, which can hold paths.
 */
function errorCode(err: unknown): string {
  const e = (typeof err === "object" && err !== null ? err : {}) as { code?: unknown; name?: unknown; cause?: unknown };
  const cause = (typeof e.cause === "object" && e.cause !== null ? e.cause : {}) as { code?: unknown };
  for (const value of [cause.code, e.code, e.name]) {
    if (typeof value === "string" && /^\w+$/.test(value)) return value;
  }
  return "unknown";
}

/**
 * One line in the app's log per failure. It carries only an exit code, a
 * signal, an HTTP status or an error code: never the question, the recap,
 * the token, Claude Code's output or a path.
 */
function warn(what: string, detail: string | null): void {
  console.warn(`[claudeCode] ${what}${detail ? ` (${detail})` : ""}`);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** The OS temp folder, unless it sits inside the home folder, where a CLAUDE.md above the run could apply. */
function defaultTmpRoot(): string {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const tmp = os.tmpdir();
  return isPathWithinRoot(real(tmp), real(os.homedir()), path.sep) ? "/tmp" : tmp;
}

/**
 * Answers Copilot questions with the user's own Claude Code: one clean,
 * throwaway `claude -p` run per question, at most one per bag session, with
 * DataPilot's tools reached through the backend's token-protected `/mcp`.
 */
export function createClaudeRunner(deps: RunnerDeps): ClaudeRunner {
  const backendUrl = deps.backendUrl ?? BACKEND_URL;
  const mcpUrl = deps.mcpUrl ?? MCP_URL;
  const doFetch = deps.fetchImpl ?? fetch;
  const stopGraceMs = deps.stopGraceMs ?? 5_000;
  const runTimeoutMs = deps.runTimeoutMs ?? 600_000;

  /** The clean mode that connected DataPilot's tools, kept for the rest of the app session. */
  let remembered: CleanMode | null = null;
  const runs = new Set<Run>();
  const bySub = new Map<string, Run>();
  const bySession = new Map<string, Run>();
  /** Claude Code processes whose output has closed: nothing of theirs holds a run any more. */
  const closed = new WeakSet<ChildProcess>();
  const isOpen = (child: ChildProcess) => !closed.has(child);

  const backendFetch = (url: string, init: RequestInit = {}) =>
    doFetch(url, { ...init, signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS) });

  /** Calls `fn` after `ms`, unless the run settles first. */
  function later(run: Run, ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      run.timers.delete(timer);
      fn();
    }, ms);
    run.timers.add(timer);
  }

  /**
   * Signals Claude Code and every process it started. Claude Code is spawned
   * detached, so it leads its own process group, and a wrapper that starts the
   * real program as a child, rather than exec-ing it, can't keep it out of reach.
   */
  function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return; // it never started
    try {
      process.kill(-child.pid, signal);
    } catch {
      // ESRCH: no process of the group is left. Claude Code itself, should it
      // have left its group, still gets the signal.
      child.kill(signal);
    }
  }

  /**
   * SIGTERM, then SIGKILL if its output is still open after the grace period,
   * so the run always ends. Should a process outside the group still hold the
   * output open a grace period after that, once Claude Code has exited, the
   * output is let go, so the run settles.
   */
  function terminate(run: Run, child: ChildProcess): void {
    if (!isOpen(child)) return;
    signalGroup(child, "SIGTERM");
    later(run, stopGraceMs, () => {
      if (!isOpen(child)) return;
      signalGroup(child, "SIGKILL");
      later(run, stopGraceMs, () => {
        const release = () => {
          if (!isOpen(child)) return;
          child.stdout?.destroy();
          child.stderr?.destroy();
        };
        if (hasExited(child)) release();
        else child.once("exit", release);
      });
    });
  }

  /** SIGINT, then SIGTERM and SIGKILL, each after the grace period. Only the first stop counts. */
  function interrupt(run: Run, reason: "user" | "timeout"): void {
    if (run.stopReason) return;
    run.stopReason = reason;
    const child = run.child;
    if (!child || !isOpen(child)) return; // not started, or done: the run ends at its next step
    signalGroup(child, "SIGINT");
    later(run, stopGraceMs, () => terminate(run, child));
  }

  function removeFolder(run: Run): void {
    if (!run.folder) return;
    try {
      fs.rmSync(run.folder, { recursive: true, force: true });
    } catch {
      // Best effort: there is nothing more to try.
    }
  }

  function ask(opts: AskOptions): Promise<void> {
    const run: Run = {
      child: null,
      folder: null,
      spawned: false,
      stopReason: null,
      killed: false,
      timers: new Set(),
      settled: Promise.resolve(),
    };
    // Registered before any await, so a later question for this bag waits for this one.
    const previous = bySession.get(opts.sessionId);
    runs.add(run);
    bySub.set(opts.subId, run);
    bySession.set(opts.sessionId, run);
    run.settled = (async () => {
      try {
        if (previous) {
          interrupt(previous, "user");
          await previous.settled;
        }
        await execute(run, opts);
      } catch {
        // execute reports its own failures; this only keeps ask from ever rejecting.
      } finally {
        for (const timer of run.timers) clearTimeout(timer);
        removeFolder(run);
        runs.delete(run);
        if (bySub.get(opts.subId) === run) bySub.delete(opts.subId);
        if (bySession.get(opts.sessionId) === run) bySession.delete(opts.sessionId);
      }
    })();
    return run.settled;
  }

  async function execute(run: Run, opts: AskOptions): Promise<void> {
    const send: Send = (event) => {
      try {
        opts.onEvent(event);
      } catch {
        // The asking window may be gone; the run still finishes and saves its turn.
      }
    };
    const sendError = (code: ClaudeCodeErrorCode, detail: string | null, resetsAt?: number) => {
      warn(`error ${code}`, detail);
      send({ event: "error", data: { code, message: claudeCodeErrorText(code, { resetsAt }) } });
    };
    const sessionUrl = `${backendUrl}/api/sessions/${encodeURIComponent(opts.sessionId)}`;

    let turn: Turn | Refusal | null;
    try {
      turn = await startTurn(run, opts, sessionUrl);
    } catch (err) {
      turn = { code: "failed", detail: errorCode(err) };
    }
    if (turn === null) return;
    if (!("turnId" in turn)) {
      if (!isHalted(run)) sendError(turn.code, turn.detail);
      return;
    }

    // A turn exists from here on, so it is always completed, unless DataPilot is quitting.
    const report: Report = { model: "", steps: [], result: null, failure: null, toolsUnreachable: false, exit: null };
    let ending: Ending;
    try {
      if (!isHalted(run)) {
        const recap = await readRecap(sessionUrl, opts.question);
        if (!isHalted(run)) await converse(run, opts, turn, recap, report, send);
      }
      ending = decide(run, report);
    } catch (err) {
      // An unexpected error. It goes unreported only when the user stopped before Claude Code started.
      ending = { status: "failed", code: (run.spawned || !isHalted(run)) ? "failed" : null, detail: errorCode(err) };
    }
    if (run.killed) return;

    let reached = true;
    let saved: unknown = null;
    let saveDetail: string | null = null;
    try {
      const res = await backendFetch(`${sessionUrl}/agent-turns/${encodeURIComponent(turn.turnId)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: opts.question,
          response: ending.status === "failed" ? "" : ending.response,
          model: report.model,
          auth_method: turn.authMethod,
          usage: {
            tokens_in: report.result?.tokensIn ?? 0,
            tokens_out: report.result?.tokensOut ?? 0,
            est_cost_usd: report.result?.costUsd ?? 0,
          },
          steps: report.steps.slice(0, MAX_SAVED_STEPS),
          status: ending.status,
        }),
      });
      const body = await readJson(res);
      if (res.ok) saved = body;
      saveDetail = `HTTP ${res.status}`;
    } catch (err) {
      reached = false;
      saveDetail = errorCode(err);
    }
    if (ending.status === "failed") {
      if (ending.code) sendError(ending.code, ending.detail, ending.resetsAt);
      return;
    }
    if (!reached) return sendError("tools_unreachable", saveDetail);
    if (!isRecord(saved) || typeof saved.response !== "string") return sendError("failed", saveDetail);
    send({ event: "final", data: saved as unknown as ClaudeCodeFinal });
  }

  /** Checks the install and the sign-in, then creates the turn. Null: stopped first, so nothing to report. */
  async function startTurn(run: Run, opts: AskOptions, sessionUrl: string): Promise<Turn | Refusal | null> {
    const refuse = (code: ClaudeCodeErrorCode, detail: string | null = null): Refusal => ({ code, detail });
    const install = await deps.locate(opts.savedPath);
    if (isHalted(run)) return null;
    if (install.state === "missing") return refuse("not_installed");
    if (install.state === "too_old") return refuse("too_old");
    const auth = await deps.getAuthStatus(install.path);
    if (isHalted(run)) return null;
    if (!auth.signedIn) return refuse("signed_out");
    let res: Response;
    try {
      res = await backendFetch(`${sessionUrl}/agent-turns`, { method: "POST" });
    } catch (err) {
      return isHalted(run) ? null : refuse("tools_unreachable", errorCode(err));
    }
    const body = await readJson(res);
    if (res.ok && isRecord(body) && typeof body.turn_id === "string" && body.turn_id) {
      return { binaryPath: install.path, authMethod: auth.method, turnId: body.turn_id };
    }
    if (isHalted(run)) return null;
    return refuse(res.status === 404 || res.status === 409 ? "no_bag" : "tools_unreachable", `HTTP ${res.status}`);
  }

  /**
   * The recap of this chat, or the question alone when the history can't be
   * read. Both come from buildRecap, so the text never starts with a slash.
   */
  async function readRecap(sessionUrl: string, question: string): Promise<string> {
    try {
      const res = await backendFetch(`${sessionUrl}/messages`);
      const rows = await readJson(res);
      if (res.ok && Array.isArray(rows)) return buildRecap(rows as HistoryRow[], question);
    } catch {
      // The question goes alone.
    }
    return buildRecap([], question);
  }

  /**
   * Runs Claude Code in a fresh run folder. When safe mode isn't known to work
   * yet and it hides DataPilot's tools, or Claude Code exits before init (as it
   * does on a switch it doesn't accept), it runs once more with the fallback
   * switches, in the same folder and for the same turn. No model request comes
   * before init, so that retry costs nothing.
   */
  async function converse(run: Run, opts: AskOptions, turn: Turn, recap: string, report: Report, send: Send): Promise<void> {
    const folder = fs.mkdtempSync(path.join(deps.tmpRoot ?? defaultTmpRoot(), "datapilot-claude-"));
    run.folder = folder;
    fs.chmodSync(folder, 0o700);
    const cwd = path.join(folder, "cwd");
    fs.mkdirSync(cwd, { mode: 0o700 });
    const mcpConfigPath = path.join(folder, "mcp-config.json");
    const headers = {
      Authorization: `Bearer ${deps.getToken()}`,
      "X-DataPilot-Session": opts.sessionId,
      "X-DataPilot-Turn": turn.turnId,
    };
    const config = { mcpServers: { datapilot: { type: "http", url: mcpUrl, headers } } };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    const launch: Launch = { turn, cwd, mcpConfigPath, guidePath: deps.guidePath(), model: opts.model, recap };

    let mode: CleanMode = remembered ?? "safe";
    for (;;) {
      if (isHalted(run)) return;
      const connected = await runClaude(run, launch, mode, report, send);
      if (connected === true || isHalted(run)) return;
      if (mode === "safe" && remembered === null) {
        if (connected === null) warn("Claude Code exited before init under --safe-mode", report.exit);
        mode = "fallback";
        report.failure = null;
        report.result = null;
        continue;
      }
      if (connected === false) report.toolsUnreachable = true;
      return;
    }
  }

  /**
   * Starts one Claude Code process and feeds its stream-json into the report.
   * Resolves once it has exited and its output is read, with whether
   * DataPilot's tools connected (null when it never said).
   */
  function runClaude(run: Run, launch: Launch, mode: CleanMode, report: Report, send: Send): Promise<boolean | null> {
    return new Promise((resolve) => {
      const { binaryPath, authMethod } = launch.turn;
      const args = buildArgs({
        mcpConfigPath: launch.mcpConfigPath,
        guidePath: launch.guidePath,
        model: launch.model,
        maxTurns: CLAUDE_CODE_MAX_TURNS,
        mode,
      });
      const env = buildClaudeEnv(process.env, binaryPath, {
        // No cached tool list, so init reports DataPilot's server as connected or failed.
        MCP_DISCOVERY_CACHE: "0",
        ...(mode === "fallback" ? { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } : {}),
      });
      // Detached: Claude Code leads its own process group, which Stop and quitting signal as a whole.
      const child = spawn(binaryPath, args, { cwd: launch.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      run.child = child;
      if (!run.spawned) later(run, runTimeoutMs, () => interrupt(run, "timeout")); // the time cap covers the whole question
      run.spawned = true;

      let connected: boolean | null = null;
      const parser = createStreamParser({ authMethod });
      const handle = (event: ParsedEvent): void => {
        switch (event.kind) {
          case "init":
            if (connected !== null) return;
            connected = event.datapilotConnected;
            if (event.model) report.model = event.model;
            if (!connected) {
              terminate(run, child);
            } else if (remembered === null) {
              remembered = mode;
              console.log(`[claudeCode] clean runs use ${mode}`);
            }
            return;
          case "tool-start":
            report.steps.push({ tool: event.tool, label: event.label });
            send({ event: "step-add", data: { label: event.label } });
            return;
          case "tool-done":
            send({
              event: "step-done",
              data: event.isError ? { idx: event.idx, output_summary: "returned an error" } : { idx: event.idx },
            });
            return;
          case "failure":
            // Keep the first failure; a later report of the same failure may add its reset time.
            if (!report.failure) report.failure = { code: event.code, resetsAt: event.resetsAt };
            else if (report.failure.resetsAt === undefined && event.code === report.failure.code) {
              report.failure.resetsAt = event.resetsAt;
            }
            return;
          case "result":
            report.result = event;
            return;
        }
      };

      // "close" comes after the exit and after stdout has ended, so every line has been read.
      // A failed spawn emits "error", then "close" with no output.
      let spawnError: string | null = null;
      child.on("error", (err) => {
        spawnError ??= errorCode(err);
      });
      child.on("close", (code, signal) => {
        closed.add(child);
        report.exit = spawnError ? `error ${spawnError}` : signal ? `signal ${signal}` : `exit code ${code}`;
        resolve(connected);
      });
      child.stdin.on("error", () => {}); // EPIPE when it exits before reading the question
      child.stderr.on("error", () => {});
      child.stderr.resume(); // drained and discarded
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on("error", () => {});
      lines.on("line", (line) => {
        if (connected === false) return; // a run without DataPilot's tools is being ended
        try {
          for (const event of parser.feed(line)) handle(event);
        } catch {
          // One bad line must never take down the main process.
        }
      });
      // The recap and the question go on stdin, never in argv.
      child.stdin.end(launch.recap);
    });
  }

  function decide(run: Run, report: Report): Ending {
    if (!run.spawned) return { status: "failed", code: null, detail: null };
    if (run.stopReason === "user") return { status: "stopped", response: withMarker(report.result?.text, STOPPED_BY_USER) };
    if (run.stopReason === "timeout") return { status: "stopped", response: withMarker(report.result?.text, TIME_CAP) };
    if (report.toolsUnreachable) return { status: "failed", code: "tools_unreachable", detail: report.exit };
    const result = report.result;
    if (result?.subtype === "error_max_turns") return { status: "stopped", response: withMarker(result.text, TURN_CAP) };
    if (result?.subtype === "success" && !result.isError && !report.failure) {
      return { status: "completed", response: clipText(result.text, MAX_RESPONSE_CHARS) };
    }
    return {
      status: "failed",
      code: report.failure?.code ?? "failed",
      resetsAt: report.failure?.resetsAt,
      detail: report.exit,
    };
  }

  function stop(subId: string): Promise<void> {
    const run = bySub.get(subId);
    if (!run) return Promise.resolve();
    interrupt(run, "user");
    return run.settled;
  }

  /** For quitting: SIGTERM only, to each Claude Code's whole group, since DataPilot exits right after. */
  function killAll(): void {
    for (const run of runs) {
      run.killed = true;
      if (run.child && isOpen(run.child)) signalGroup(run.child, "SIGTERM");
      removeFolder(run);
    }
  }

  return { ask, stop, killAll, cleanMode: () => remembered };
}
