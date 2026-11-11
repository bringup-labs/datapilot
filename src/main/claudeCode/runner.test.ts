// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { STOPPED_BY_USER, claudeCodeErrorText } from "../../shared/claudeCodeMessages";
import type { ClaudeCodeChatEvent, ClaudeCodeErrorCode } from "../../shared/ipc";
import { FAKE_CLAUDE, readFakeRecords } from "../../test/claude-code/fakeClaude";
import { buildArgs, buildRecap, createClaudeRunner, type ClaudeRunner, type RunnerDeps } from "./runner";

const SAFE = { mcpConfigPath: "/t/mcp-config.json", guidePath: "/g.md", model: "" as const, maxTurns: 25 };
const TURN_CAP = "*Claude Code reached DataPilot's limit of 25 turns for one question.*";
const TIME_CAP = "*Claude Code ran longer than 10 minutes, so DataPilot stopped it.*";
const RESETS_AT = 1767297600;

/** What the backend's complete endpoint answers for a saved turn; it echoes `response`. */
const ENVELOPE = {
  response: "",
  plan: [{ label: "Get bag overview", tool: "get_bag_overview" }],
  findings: [{ sev: "warning", text: "Lidar dropout", log_ids: ["sess-1:l_8"] }],
  causal: [],
  audit_trail: [],
  citations: [],
  usage: { tokens_in: 1500, tokens_out: 200, est_cost_usd: 0.0123 },
  partial: false,
  answered_by: "claude_code",
  verified: true,
  flagged_log_ids: [],
  claude_code_usage: { model: "claude-sonnet-4-5-20250929", auth_method: "claude.ai", tool_calls: 3, est_cost_usd: 0.0123 },
};

interface BackendRequest {
  url: string;
  method: string;
  body: any;
}

function fakeBackend(opts: {
  createStatus?: number;
  rows?: unknown[];
  messagesStatus?: number;
  completeStatus?: number;
  offline?: boolean;
  completeOffline?: boolean;
} = {}) {
  const requests: BackendRequest[] = [];
  let turns = 0;
  const reply = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init?.method ?? "GET", body });
    if (opts.offline) throw new TypeError("fetch failed");
    if (url.endsWith("/agent-turns")) {
      return opts.createStatus ? reply(opts.createStatus, { detail: "no" }) : reply(201, { turn_id: `turn-${++turns}` });
    }
    if (url.endsWith("/messages")) return reply(opts.messagesStatus ?? 200, opts.rows ?? []);
    if (url.endsWith("/complete")) {
      if (opts.completeOffline) throw new TypeError("fetch failed");
      if (opts.completeStatus) return reply(opts.completeStatus, { detail: "no" });
      if (body.steps.length > 200) return reply(422, { detail: "steps: at most 200 items" }); // AgentTurnComplete's limit
      if (body.response.length > 100_000) return reply(422, { detail: "response: at most 100000 characters" }); // ditto
      return reply(200, body.status === "failed" ? { status: "discarded" } : { ...ENVELOPE, response: body.response });
    }
    return reply(404, { detail: "Not Found" });
  };
  const completeBodies = () => requests.filter((q) => q.url.endsWith("/complete")).map((q) => q.body);
  return { requests, fetch: fetchImpl as typeof fetch, completeBody: () => completeBodies().at(-1), completeBodies };
}

let tmp: string;
let recordFile: string;
let guideFile: string;
let backend: ReturnType<typeof fakeBackend>;
let runners: ClaudeRunner[];
let firstStepAdd: Promise<void>;
let markFirstStepAdd: () => void;
let logSpy: MockInstance;
let warnSpy: MockInstance;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dp-runner-"));
  recordFile = path.join(tmp, "rec.jsonl");
  guideFile = path.join(tmp, "datapilot-guide.md");
  fs.writeFileSync(guideFile, "DataPilot's guide\n");
  backend = fakeBackend();
  runners = [];
  firstStepAdd = new Promise((resolve) => (markFirstStepAdd = resolve));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const r of runners) r.killAll();
  // A program a wrapper scenario started can outlive a failed test: end it here.
  for (const rec of readFakeRecords(recordFile)) {
    if (rec.argv[0] === "--hold-output") {
      try {
        process.kill(rec.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runner(overrides: Partial<RunnerDeps> = {}): ClaudeRunner {
  const r = createClaudeRunner({
    locate: async () => ({ state: "found", path: FAKE_CLAUDE, version: "2.1.300" }),
    getAuthStatus: async () => ({ signedIn: true, method: "claude.ai", configDirectory: "/home/test/.claude" }),
    guidePath: () => guideFile,
    getToken: () => "t".repeat(64),
    fetchImpl: backend.fetch,
    stopGraceMs: 200,
    ...overrides,
  });
  runners.push(r);
  return r;
}

async function ask(r: ClaudeRunner, scenario: string, question = "Why did the robot stop?", subId = "sub-1") {
  vi.stubEnv("FAKE_CLAUDE_SCENARIO", scenario);
  vi.stubEnv("FAKE_CLAUDE_RECORD", recordFile);
  const events: ClaudeCodeChatEvent[] = [];
  await r.ask({
    subId,
    sessionId: "sess-1",
    question,
    model: "",
    savedPath: null,
    onEvent: (e) => {
      events.push(e);
      if (e.event === "step-add") markFirstStepAdd();
    },
  });
  return events;
}

const errorEvent = (code: ClaudeCodeErrorCode, resetsAt?: number): ClaudeCodeChatEvent => ({
  event: "error",
  data: { code, message: claudeCodeErrorText(code, { resetsAt }) },
});

/** The program a wrapper scenario started, from its own record. */
const heldBy = () => readFakeRecords(recordFile).find((x) => x.argv[0] === "--hold-output")!;

const isGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
};

describe("buildArgs", () => {
  it("always passes the clean-run flags and never the forbidden ones", () => {
    for (const mode of ["safe", "fallback"] as const) {
      const args = buildArgs({ mcpConfigPath: "/t/mcp-config.json", guidePath: "/g.md", model: "", maxTurns: 25, mode });
      expect(args.slice(0, 2)).toEqual(["-p", "--no-session-persistence"]);
      expect(args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--strict-mcp-config", "--allowedTools", "mcp__datapilot", "--permission-mode", "dontAsk"]));
      expect(args[args.indexOf("--tools") + 1]).toBe("");
      expect(args[args.indexOf("--mcp-config") + 1]).toBe("/t/mcp-config.json");
      expect(args[args.indexOf("--append-system-prompt-file") + 1]).toBe("/g.md");
      expect(args[args.indexOf("--max-turns") + 1]).toBe("25");
      for (const banned of ["--bare", "--system-prompt", "--restricted", "--setting-sources", "--model"]) expect(args).not.toContain(banned);
    }
    expect(buildArgs({ ...SAFE, mode: "safe" })).toContain("--safe-mode");
    const fb = buildArgs({ ...SAFE, mode: "fallback" });
    expect(fb).not.toContain("--safe-mode"); expect(fb).toContain("--disable-slash-commands");
    expect(JSON.parse(fb[fb.indexOf("--settings") + 1])).toEqual({ disableAllHooks: true, claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md"] });
    expect(buildArgs({ ...SAFE, mode: "safe", model: "opus" })).toEqual(expect.arrayContaining(["--model", "opus"]));
  });
});

describe("Claude Code runner", () => {
  it("answers a question through a clean, throwaway Claude Code run", async () => {
    const question = 'Why did it stop? $(rm -rf ~) "quoted"';
    const events = await ask(runner(), "success", question);
    const [rec] = readFakeRecords(recordFile);
    expect(rec.stdin!.endsWith(question)).toBe(true);
    expect(rec.argv.join(" ")).not.toContain("Why did it stop");
    expect(rec.mcpConfig).toEqual({ mcpServers: { datapilot: { type: "http", url: "http://localhost:8000/mcp", headers: {
      Authorization: `Bearer ${"t".repeat(64)}`, "X-DataPilot-Session": "sess-1", "X-DataPilot-Turn": "turn-1" } } } });
    expect(rec.mcpConfigMode).toBe("600");
    expect(rec.mcpDiscoveryCache).toBe("0");
    expect(rec.cwdEntries).toEqual([]);
    expect(rec.cwd.startsWith(os.homedir())).toBe(false);
    expect(rec.path.split(path.delimiter)[0]).toBe(path.dirname(FAKE_CLAUDE));
    expect(fs.existsSync(path.dirname(rec.cwd))).toBe(false);                       // run folder deleted
    expect(events.filter((e) => e.event === "step-add").map((e) => e.data.label))
      .toEqual(["Get bag overview", "Retrieve logs · planner abort", "Submit findings"]);
    expect(events.map((e) => e.event)).toEqual(["step-add", "step-done", "step-add", "step-done", "step-add", "step-done", "final"]);
    expect(events.filter((e) => e.event === "step-done").map((e) => e.data)).toEqual([{ idx: 0 }, { idx: 1 }, { idx: 2 }]);
    expect(events.at(-1)).toEqual({ event: "final", data: expect.objectContaining({ answered_by: "claude_code" }) });
    expect(backend.completeBody()).toEqual({ question, response: "The planner aborted after the lidar dropped out (l_8).",
      model: "claude-sonnet-4-5-20250929", auth_method: "claude.ai", usage: { tokens_in: 1500, tokens_out: 200, est_cost_usd: 0.0123 },
      steps: [{ tool: "get_bag_overview", label: "Get bag overview" }, { tool: "retrieve_logs", label: "Retrieve logs · planner abort" },
              { tool: "submit_findings", label: "Submit findings" }], status: "completed" });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain("t".repeat(64));
  });

  it("sends a recap of the chat on stdin, or the question alone when the history can't be read", async () => {
    backend = fakeBackend({ rows: [
      { role: "user", content: "What failed?" },
      { role: "assistant", content: "The lidar.", answered_by: "datapilot", findings: null },
    ] });
    await ask(runner(), "success", "And why?");
    backend = fakeBackend({ messagesStatus: 500 });
    await ask(runner(), "success", "And why?");
    const [withHistory, withoutHistory] = readFakeRecords(recordFile);
    expect(withHistory.stdin).toBe("Earlier in this chat, oldest first:\n\nQ: What failed?\nA (DataPilot's agents): The lidar.\n\nQuestion:\nAnd why?");
    expect(withoutHistory.stdin).toBe("And why?");
  });

  it("never starts Claude Code's stdin with a slash, even when the history can't be read", async () => {
    const question = "/scan dropped out at 12 s, why?";
    await ask(runner(), "success", question);
    backend = fakeBackend({ messagesStatus: 500 });
    await ask(runner(), "success", question);
    const recs = readFakeRecords(recordFile);
    expect(recs).toHaveLength(2);
    for (const rec of recs) {
      expect(rec.stdin!.startsWith("/")).toBe(false);
      expect(rec.stdin).toBe(`Question:\n${question}`);
    }
  });

  it("marks a step whose tool returned an error", async () => {
    const events = await ask(runner(), "tool-error");
    expect(events.find((e) => e.event === "step-done")).toEqual({ event: "step-done", data: { idx: 0, output_summary: "returned an error" } });
    expect(backend.completeBody()).toMatchObject({ status: "completed", response: "No aborts found." });
  });

  it("falls back from safe mode once when it hides DataPilot's tools, and remembers that", async () => {
    const r = runner();
    await ask(r, "safe-mode-hides-mcp"); await ask(r, "safe-mode-hides-mcp");
    const recs = readFakeRecords(recordFile);
    expect(recs.map((x) => x.argv.includes("--safe-mode"))).toEqual([true, false, false]);
    expect(recs[1].argv).toContain("--disable-slash-commands"); expect(recs[1].autoMemory).toBe("1");
    expect(recs[0].autoMemory).toBeNull();
    expect(recs.map((x) => x.mcpDiscoveryCache)).toEqual(["0", "0", "0"]);
    expect(r.cleanMode()).toBe("fallback");
    expect(logSpy.mock.calls).toEqual([["[claudeCode] clean runs use fallback"]]);
    expect(backend.completeBodies().map((b) => b.status)).toEqual(["completed", "completed"]);
  });

  it("keeps safe mode when DataPilot's tools load under it", async () => {
    const r = runner();
    expect(r.cleanMode()).toBeNull();
    await ask(r, "success"); await ask(r, "success");
    expect(readFakeRecords(recordFile).map((x) => x.argv.includes("--safe-mode"))).toEqual([true, true]);
    expect(r.cleanMode()).toBe("safe");
    expect(logSpy.mock.calls).toEqual([["[claudeCode] clean runs use safe"]]);
  });

  it("doesn't blame safe mode when the tools are unreachable in both modes", async () => {
    const r = runner();
    expect(await ask(r, "no-mcp")).toEqual([errorEvent("tools_unreachable")]);
    expect(readFakeRecords(recordFile).map((x) => x.argv.includes("--safe-mode"))).toEqual([true, false]);
    expect(r.cleanMode()).toBeNull();
    expect(backend.completeBodies().map((b) => b.status)).toEqual(["failed"]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("falls back once when Claude Code exits before init under safe mode, as with a flag it refuses", async () => {
    const r = runner();
    const events = await ask(r, "safe-mode-exits");
    expect(events.at(-1)).toEqual({ event: "final", data: expect.objectContaining({ answered_by: "claude_code" }) });
    const recs = readFakeRecords(recordFile);
    expect(recs.map((x) => x.argv.includes("--safe-mode"))).toEqual([true, false]);
    expect(recs[1].cwd).toBe(recs[0].cwd);              // the same run folder
    expect(recs[1].mcpConfig).toEqual(recs[0].mcpConfig); // and the same turn
    expect(r.cleanMode()).toBe("fallback");
    expect(backend.completeBodies().map((b) => b.status)).toEqual(["completed"]);
    expect(warnSpy.mock.calls).toEqual([["[claudeCode] Claude Code exited before init under --safe-mode (exit code 1)"]]);
  });

  it("fails when Claude Code exits before init in both modes, and remembers neither", async () => {
    const r = runner();
    expect(await ask(r, "exits-before-init")).toEqual([errorEvent("failed")]);
    expect(readFakeRecords(recordFile).map((x) => x.argv.includes("--safe-mode"))).toEqual([true, false]);
    expect(r.cleanMode()).toBeNull();
    expect(backend.completeBodies().map((b) => b.status)).toEqual(["failed"]);
    expect(warnSpy.mock.calls).toEqual([
      ["[claudeCode] Claude Code exited before init under --safe-mode (exit code 1)"],
      ["[claudeCode] error failed (exit code 1)"],
    ]);
  });

  it("doesn't fall back when safe mode is already known to work", async () => {
    const r = runner();
    await ask(r, "success");
    expect(await ask(r, "exits-before-init")).toEqual([errorEvent("failed")]);
    expect(readFakeRecords(recordFile).map((x) => x.argv.includes("--safe-mode"))).toEqual([true, true]);
    expect(r.cleanMode()).toBe("safe");
  });

  it("logs a failure with its HTTP status or error code only", async () => {
    backend = fakeBackend({ createStatus: 500 });
    await ask(runner(), "success", "Why did /home/someone/secret stop?");
    backend = fakeBackend({ offline: true });
    await ask(runner(), "success");
    expect(warnSpy.mock.calls).toEqual([
      ["[claudeCode] error tools_unreachable (HTTP 500)"],
      ["[claudeCode] error tools_unreachable (TypeError)"],
    ]);
  });

  it("checks the install and the sign-in before creating a turn", async () => {
    const cases: Array<[Partial<RunnerDeps>, ClaudeCodeErrorCode]> = [
      [{ locate: async () => ({ state: "missing" }) }, "not_installed"],
      [{ locate: async () => ({ state: "too_old", path: FAKE_CLAUDE, version: "2.1.100" }) }, "too_old"],
      [{ getAuthStatus: async () => ({ signedIn: false, method: "none", configDirectory: null }) }, "signed_out"],
    ];
    for (const [deps, code] of cases) expect(await ask(runner(deps), "success")).toEqual([errorEvent(code)]);
    expect(backend.requests).toEqual([]);
    expect(readFakeRecords(recordFile)).toEqual([]);
  });

  it("says when the bag isn't loaded", async () => {
    for (const status of [404, 409]) {
      backend = fakeBackend({ createStatus: status });
      expect(await ask(runner(), "success")).toEqual([errorEvent("no_bag")]);
      expect(backend.completeBodies()).toEqual([]);
    }
    expect(readFakeRecords(recordFile)).toEqual([]);
  });

  it("says when DataPilot's backend can't be reached", async () => {
    for (const b of [fakeBackend({ createStatus: 500 }), fakeBackend({ offline: true })]) {
      backend = b;
      expect(await ask(runner(), "success")).toEqual([errorEvent("tools_unreachable")]);
    }
    expect(readFakeRecords(recordFile)).toEqual([]);
  });

  it("reports an answer the backend couldn't save", async () => {
    backend = fakeBackend({ completeStatus: 500 });
    const rejected = await ask(runner(), "success");
    backend = fakeBackend({ completeOffline: true });
    const unreachable = await ask(runner(), "success");
    for (const [events, code] of [[rejected, "failed"], [unreachable, "tools_unreachable"]] as const) {
      expect(events.filter((e) => e.event === "error" || e.event === "final")).toEqual([errorEvent(code)]);
    }
  });

  it("reports the plan's usage limit and drops the turn", async () => {
    const events = await ask(runner(), "usage-limit");
    expect(events.at(-1)).toEqual(errorEvent("usage_limit", RESETS_AT));
    expect((events.at(-1)!.data as { message: string }).message).toContain("usage limit is reached until");
    expect(events.filter((e) => e.event === "error" || e.event === "final")).toHaveLength(1);
    expect(backend.completeBody()).toMatchObject({ status: "failed" });
  });

  it("takes the reset time from a later report of the same usage limit", async () => {
    expect((await ask(runner(), "usage-limit-reset-later")).at(-1)).toEqual(errorEvent("usage_limit", RESETS_AT));
  });

  it("reports a crash and leaves nothing on disk", async () => {
    expect(await ask(runner(), "crash")).toEqual([errorEvent("failed")]);
    expect(backend.completeBody()).toMatchObject({ status: "failed" });
    const [rec] = readFakeRecords(recordFile);
    expect(fs.existsSync(path.dirname(rec.cwd))).toBe(false);
  });

  it("saves a run that hit the turn limit as stopped", async () => {
    const events = await ask(runner(), "max-turns");
    expect(backend.completeBody()).toMatchObject({ status: "stopped", response: TURN_CAP });
    expect(events.at(-1)).toEqual({ event: "final", data: expect.objectContaining({ response: TURN_CAP }) });
  });

  it("stop ends the run with SIGINT and saves what it had as stopped", async () => {
    const r = runner();
    await expect(r.stop("unknown")).resolves.toBeUndefined();
    const pending = ask(r, "stop");
    await firstStepAdd;
    await r.stop("sub-1");
    expect(backend.completeBody()).toMatchObject({ status: "stopped", response: STOPPED_BY_USER,
      usage: { tokens_in: 300, tokens_out: 20, est_cost_usd: 0.002 }, steps: [{ tool: "get_bag_overview", label: "Get bag overview" }] });
    expect((await pending).at(-1)).toEqual({ event: "final", data: expect.objectContaining({ response: STOPPED_BY_USER }) });
  });

  it("stop escalates to SIGTERM after the grace period", async () => {
    const r = runner();
    const pending = ask(r, "stop-ignores-sigint");
    await firstStepAdd;
    const started = performance.now();
    await r.stop("sub-1");
    expect(performance.now() - started).toBeGreaterThanOrEqual(150);
    const [rec] = readFakeRecords(recordFile);
    expect(isGone(rec.pid)).toBe(true);
    await pending;
    expect(backend.completeBody()).toMatchObject({ status: "stopped", response: STOPPED_BY_USER,
      usage: { tokens_in: 0, tokens_out: 0, est_cost_usd: 0 } });
  });

  it("kills a run that ignores SIGINT and SIGTERM, so stop and the next question still settle", async () => {
    const r = runner();
    const first = ask(r, "stop-ignores-sigterm", "q1", "a");
    await firstStepAdd;
    const started = performance.now();
    const second = ask(r, "success", "q2", "b");
    await r.stop("a");
    expect(performance.now() - started).toBeGreaterThanOrEqual(300); // SIGTERM after 200 ms, SIGKILL 200 ms later
    await Promise.all([first, second]);
    const [rec] = readFakeRecords(recordFile);
    expect(isGone(rec.pid)).toBe(true);
    expect(backend.completeBodies().map((b) => b.status)).toEqual(["stopped", "completed"]);
  });

  it("kills a run without DataPilot's tools that ignores SIGTERM", async () => {
    expect(await ask(runner(), "no-mcp-ignores-sigterm")).toEqual([errorEvent("tools_unreachable")]);
    const recs = readFakeRecords(recordFile);
    expect(recs.map((x) => x.argv.includes("--safe-mode"))).toEqual([true, false]);
    for (const rec of recs) expect(isGone(rec.pid)).toBe(true);
  });

  it("stop also ends the program a wrapper started, which ignores SIGINT and SIGTERM and holds the output", async () => {
    const r = runner();
    const pending = ask(r, "wrapper");
    await firstStepAdd;
    await r.stop("sub-1");
    expect((await pending).at(-1)).toEqual({ event: "final", data: expect.objectContaining({ response: STOPPED_BY_USER }) });
    const [wrapperRec] = readFakeRecords(recordFile);
    expect(isGone(wrapperRec.pid)).toBe(true);
    await vi.waitFor(() => expect(isGone(heldBy().pid)).toBe(true)); // reaped by init, not by us
  });

  it("killAll signals Claude Code's whole process group", async () => {
    const r = runner();
    const pending = ask(r, "stop");
    await firstStepAdd;
    const [rec] = readFakeRecords(recordFile);
    const kill = vi.spyOn(process, "kill");
    r.killAll();
    expect(kill).toHaveBeenCalledWith(-rec.pid, "SIGTERM");
    await pending;
    expect(isGone(rec.pid)).toBe(true);
  });

  it("settles a stop even when a program outside its group keeps the output open", async () => {
    const r = runner();
    const pending = ask(r, "wrapper-escapes");
    await firstStepAdd;
    await r.stop("sub-1");
    expect((await pending).at(-1)).toEqual({ event: "final", data: expect.objectContaining({ response: STOPPED_BY_USER }) });
    const held = heldBy().pid;
    expect(isGone(held)).toBe(false); // out of reach of the group's signals
    process.kill(held, "SIGKILL");
    await vi.waitFor(() => expect(isGone(held)).toBe(true));
  });

  it("saves at most the first 200 steps, the backend's limit, so a long run isn't lost", async () => {
    const events = await ask(runner(), "long-run");
    expect(events.filter((e) => e.event === "step-add")).toHaveLength(201);
    expect(events.at(-1)).toEqual({ event: "final", data: expect.objectContaining({ answered_by: "claude_code" }) });
    const { steps, status } = backend.completeBody();
    expect(status).toBe("completed");
    expect(steps).toHaveLength(200);
    expect(steps[0]).toEqual({ tool: "retrieve_logs", label: "Retrieve logs · q0" });
    expect(steps.at(-1)).toEqual({ tool: "retrieve_logs", label: "Retrieve logs · q199" });
  });

  it("caps the answer it saves at the backend's 100,000 characters, keeping the stop marker", async () => {
    const completed = await ask(runner(), "long-answer");
    const capped = await ask(runner(), "long-max-turns");
    for (const events of [completed, capped]) expect(events.at(-1)?.event).toBe("final");
    const [answer, stopped] = backend.completeBodies();
    expect(answer.status).toBe("completed");
    expect(answer.response).toBe(`a${"😀".repeat(49_999)}`); // the split pair at the cut is dropped
    expect(stopped.status).toBe("stopped");
    expect(stopped.response.length).toBe(100_000);
    expect(stopped.response.endsWith(`😀\n\n${TURN_CAP}`)).toBe(true);
    expect(stopped.response.isWellFormed()).toBe(true);
  });

  it("stops a run that goes past the time cap", async () => {
    const events = await ask(runner({ runTimeoutMs: 300 }), "stop");
    expect(backend.completeBody()).toMatchObject({ status: "stopped", response: TIME_CAP });
    expect(events.at(-1)).toEqual({ event: "final", data: expect.objectContaining({ response: TIME_CAP }) });
  });

  it("a stop before Claude Code starts ends the question quietly and drops the turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let markAsked!: () => void;
    const asked = new Promise<void>((resolve) => (markAsked = resolve));
    const r = runner({
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/messages")) {
          markAsked();
          await gate;
        }
        return backend.fetch(input, init);
      }) as typeof fetch,
    });
    const pending = ask(r, "success");
    await asked;
    const stopped = r.stop("sub-1");
    release();
    await stopped;
    expect(await pending).toEqual([]);
    expect(backend.completeBodies().map((b) => b.status)).toEqual(["failed"]);
    expect(readFakeRecords(recordFile)).toEqual([]);
  });

  it("a new question for the same bag waits for the previous run to end", async () => {   // Review Focus 3
    const r = runner();
    const first = ask(r, "stop", "q1", "a"); await firstStepAdd;
    const second = ask(r, "success", "q2", "b");
    await Promise.all([first, second]);
    const urls = backend.requests.map((q) => q.url.replace("http://localhost:8000", ""));
    expect(urls.indexOf("/api/sessions/sess-1/agent-turns/turn-1/complete")).toBeLessThan(urls.lastIndexOf("/api/sessions/sess-1/agent-turns"));
    expect(backend.completeBodies().map((b) => b.status)).toEqual(["stopped", "completed"]);
    for (const rec of readFakeRecords(recordFile)) expect(fs.existsSync(path.dirname(rec.cwd))).toBe(false);
  });

  it("killAll terminates running processes and deletes their folders", async () => {
    const r = runner();
    const pending = ask(r, "stop");
    await firstStepAdd;
    const [rec] = readFakeRecords(recordFile);
    r.killAll();
    expect(fs.existsSync(path.dirname(rec.cwd))).toBe(false);
    expect((await pending).map((e) => e.event)).toEqual(["step-add"]);
    expect(isGone(rec.pid)).toBe(true);
    expect(backend.completeBodies()).toEqual([]);
  });

  it("never rejects: an unexpected failure becomes one error event", async () => {
    expect(await ask(runner({ locate: () => Promise.reject(new Error("boom")) }), "success")).toEqual([errorEvent("failed")]);
    expect(backend.requests).toEqual([]);
    expect(await ask(runner({ tmpRoot: path.join(tmp, "missing") }), "success")).toEqual([errorEvent("failed")]);
    expect(backend.completeBodies().map((b) => b.status)).toEqual(["failed"]);
    expect(readFakeRecords(recordFile)).toEqual([]);
  });
});

describe("buildRecap", () => {
  it("keeps the last six turns, trims long summaries and lists verified findings", () => {
    const rows = Array.from({ length: 8 }, (_, i) => [
      { role: "user", content: `q${i}` },
      { role: "assistant", content: i === 7 ? "s".repeat(1000) : `a${i}`, answered_by: i % 2 ? "claude_code" : "datapilot",
        findings: [{ sev: "warning", text: `f${i}`, log_ids: ["sess-1:l_1", "sess-1:l_2", "sess-1:l_3", "sess-1:l_4"] }] },
    ]).flat();
    const recap = buildRecap(rows, "next?");
    expect(recap).not.toContain("Q: q1\n"); expect(recap).toContain("Q: q2\nA (DataPilot's agents): a2");
    expect(recap).toContain(`A (Claude Code): ${"s".repeat(600)}…`);
    expect(recap).toContain("- [warning] f2 (sess-1:l_1, sess-1:l_2, sess-1:l_3)");
    expect(recap.endsWith("Question:\nnext?")).toBe(true);
  });

  it("marks a question that got no answer", () => expect(buildRecap([{ role: "user", content: "q" }], "next?")).toContain("Q: q\nA: (no answer)"));

  it("is just the question when there is no history", () => expect(buildRecap([], "next?")).toBe("next?"));

  it("puts a header before a first question that starts with a slash, so it isn't read as a slash command", () =>
    expect(buildRecap([], "/odom stopped publishing, why?")).toBe("Question:\n/odom stopped publishing, why?"));

  it("also guards a slash after leading spaces", () =>
    expect(buildRecap([], "  /scan dropped out?")).toBe("Question:\n  /scan dropped out?"));

  it("shortens earlier questions but keeps the new question whole", () => {
    const long = "q".repeat(1000);
    const recap = buildRecap([{ role: "user", content: long }, { role: "assistant", content: "a" }], `next ${long}`);
    expect(recap).toContain(`Q: ${"q".repeat(600)}…\nA (DataPilot's agents): a`);
    expect(recap.endsWith(`Question:\nnext ${long}`)).toBe(true);
  });

  it("lists at most five findings and drops the parentheses when a finding has no IDs", () => {
    const findings = Array.from({ length: 7 }, (_, i) => ({ sev: "info", text: `f${i}`, log_ids: [] as string[] }));
    const recap = buildRecap([{ role: "user", content: "q" }, { role: "assistant", content: "a", findings }], "next?");
    expect(recap).toBe("Earlier in this chat, oldest first:\n\nQ: q\nA (DataPilot's agents): a\nVerified findings:\n"
      + "- [info] f0\n- [info] f1\n- [info] f2\n- [info] f3\n- [info] f4\n\nQuestion:\nnext?");
  });
});
