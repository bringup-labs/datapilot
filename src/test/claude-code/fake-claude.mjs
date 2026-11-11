#!/usr/bin/env node
// Fake `claude` executable for tests. Behavior is driven by FAKE_CLAUDE_* env vars.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const env = process.env;
const isRun = argv.includes("-p") || argv.includes("--print");

/** Reads stdin to the end, as `claude -p` does with its prompt. */
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function record(stdin) {
  if (!env.FAKE_CLAUDE_RECORD) return;
  const i = argv.indexOf("--mcp-config");
  let mcpConfig = null;
  let mcpConfigMode = null;
  if (i >= 0 && argv[i + 1]) {
    const arg = argv[i + 1];
    try {
      mcpConfig = parseJson(fs.readFileSync(arg, "utf8"));
      mcpConfigMode = (fs.statSync(arg).mode & 0o777).toString(8);
    } catch {
      mcpConfig = parseJson(arg);
    }
  }
  const entry = {
    argv,
    cwd: process.cwd(),
    cwdEntries: fs.readdirSync(process.cwd()),
    path: env.PATH ?? "",
    autoMemory: env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
    mcpDiscoveryCache: env.MCP_DISCOVERY_CACHE ?? null,
    mcpConfig,
    mcpConfigMode,
    stdin,
    pid: process.pid,
  };
  fs.appendFileSync(env.FAKE_CLAUDE_RECORD, JSON.stringify(entry) + "\n");
}

const fixture = (name) =>
  fs.readFileSync(new URL(`./streams/${name}.jsonl`, import.meta.url), "utf8");
const print = (text) =>
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

/**
 * Keeps the fake alive until a signal ends it. It gives up after 30 s, so a
 * failed test never leaves it running.
 */
function waitForSignal() {
  const keepAlive = setInterval(() => {}, 1_000);
  const giveUp = setTimeout(() => process.exit(2), 30_000);
  return () => {
    clearInterval(keepAlive);
    clearTimeout(giveUp);
  };
}

/** An answer longer than the backend saves (100,000 characters), split surrogate pair included. */
function longResult(subtype) {
  const [init] = fixture("success").trim().split("\n");
  print(init);
  print(
    JSON.stringify({
      type: "result",
      subtype,
      is_error: subtype !== "success",
      result: `a${"😀".repeat(80_000)}`,
      num_turns: 4,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1000, output_tokens: 200 },
    }),
  );
}

/**
 * A wrapper that starts the real program as its own child instead of
 * exec-ing it. That child keeps the run's output open and ignores SIGINT and
 * SIGTERM; with `ownGroup`, it also leaves the wrapper's process group.
 */
function wrapper(ownGroup) {
  waitForSignal(); // the wrapper itself ends on the first signal
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--hold-output"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    detached: ownGroup,
  });
  child.once("message", () => {
    child.disconnect();
    print(fixture("stop"));
  });
}

/** `claude -p`: replays a recorded stream-json run chosen by FAKE_CLAUDE_SCENARIO. */
function run(scenario) {
  switch (scenario) {
    case "wrapper":
      wrapper(false);
      return;
    case "wrapper-escapes":
      wrapper(true);
      return;
    case "safe-mode-exits": // refuses safe mode's switches, as an unsupported flag would
      if (argv.includes("--safe-mode")) process.exitCode = 1;
      else print(fixture("success"));
      return;
    case "exits-before-init":
      process.exitCode = 1;
      return;
    case "long-answer":
      longResult("success");
      return;
    case "long-max-turns":
      longResult("error_max_turns");
      return;
    case "crash":
      print(fixture("success").split("\n")[0]);
      process.exitCode = 1;
      return;
    case "stop": {
      const done = waitForSignal();
      process.on("SIGINT", () => {
        done();
        print(fixture("stop-result"));
      });
      print(fixture("stop"));
      return;
    }
    case "stop-ignores-sigint":
      waitForSignal();
      process.on("SIGINT", () => {});
      print(fixture("stop"));
      return;
    case "stop-ignores-sigterm": // only SIGKILL ends it
      waitForSignal();
      process.on("SIGINT", () => {});
      process.on("SIGTERM", () => {});
      print(fixture("stop"));
      return;
    case "no-mcp-ignores-sigterm":
      waitForSignal();
      process.on("SIGTERM", () => {});
      print(fixture("no-mcp"));
      return;
    case "long-run": {
      // 201 tool calls, one more than the backend saves, then a normal answer.
      const lines = fixture("success").trim().split("\n");
      print(lines[0]);
      for (let i = 0; i < 201; i++) {
        const id = `t${i}`;
        const input = { query: `q${i}` };
        print(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "mcp__datapilot__retrieve_logs", input }] } }));
        print(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] } }));
      }
      print(lines.at(-1));
      return;
    }
    case "safe-mode-hides-mcp":
      if (!argv.includes("--safe-mode")) {
        print(fixture("success"));
        return;
      }
      waitForSignal();
      print(
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "s1",
          mcp_servers: [],
          model: "claude-sonnet-4-5-20250929",
        }),
      );
      return;
    case "no-mcp":
      waitForSignal();
      print(fixture("no-mcp"));
      return;
    default:
      print(fixture(scenario));
  }
}

const stdin = isRun ? await readStdin() : null;
record(stdin);

if (argv[0] === "--version") {
  console.log(`${env.FAKE_CLAUDE_VERSION ?? "2.1.300"} (Claude Code)`);
} else if (argv[0] === "auth" && argv[1] === "status") {
  const json =
    env.FAKE_CLAUDE_AUTH_JSON ??
    '{"loggedIn":true,"authMethod":"claude.ai","configDirectory":"/home/test/.claude","email":"someone@example.com"}';
  console.log(json);
  process.exit(parseJson(json)?.authMethod === "none" ? 1 : 0);
} else if (argv[0] === "auth" && argv[1] === "login") {
  console.log("Opening https://claude.ai/oauth?code=SECRET");
  process.exit(Number(env.FAKE_CLAUDE_LOGIN_EXIT ?? 0));
} else if (argv[0] === "--hold-output") {
  // The program a wrapper started (see wrapper()): only SIGKILL ends it.
  waitForSignal();
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  process.send("ready");
} else if (isRun) {
  run(env.FAKE_CLAUDE_SCENARIO ?? "success");
}
