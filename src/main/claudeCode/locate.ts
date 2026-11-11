import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_CODE_MIN_VERSION,
  type ClaudeCodeInstall,
} from "../../shared/ipc";
import { buildClaudeEnv } from "./env";

export function knownInstallDirs(home: string): string[] {
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

/** The version in `claude --version`'s "2.1.300 (Claude Code)", or null for any other program's output. */
export function parseClaudeVersion(output: string): string | null {
  if (!output.includes("Claude Code")) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function readVersion(binaryPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      ["--version"],
      { env: buildClaudeEnv(process.env, binaryPath), timeout: 15_000 },
      (err, stdout) => resolve(err ? null : parseClaudeVersion(String(stdout))),
    );
  });
}

export interface LocateOptions {
  pathEnv: string | undefined;
  home: string;
  savedPath: string | null;
  knownDirs?: string[];
}

function isExecutable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function locateClaude(
  opts: LocateOptions,
): Promise<ClaudeCodeInstall> {
  const dirs = [
    ...(opts.pathEnv ?? "").split(path.delimiter).filter(Boolean),
    ...(opts.knownDirs ?? knownInstallDirs(opts.home)),
  ];
  const raw = dirs.map((d) => path.join(d, "claude"));
  if (opts.savedPath) raw.push(opts.savedPath);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const c of raw) {
    const key = path.resolve(c);
    if (seen.has(key) || !isExecutable(c)) continue;
    seen.add(key);
    candidates.push(c);
  }
  let tooOld: ClaudeCodeInstall = { state: "missing" };
  for (const c of candidates) {
    const version = await readVersion(c);
    if (!version) continue;
    if (compareVersions(version, CLAUDE_CODE_MIN_VERSION) >= 0) {
      return { state: "found", path: c, version };
    }
    if (tooOld.state === "missing")
      tooOld = { state: "too_old", path: c, version };
  }
  return tooOld;
}
