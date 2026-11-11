// @vitest-environment node
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FAKE_CLAUDE } from "../../test/claude-code/fakeClaude";
import {
  compareVersions,
  knownInstallDirs,
  locateClaude,
  parseClaudeVersion,
} from "./locate";

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const link = (dir: string) =>
  fs.symlinkSync(FAKE_CLAUDE, path.join(dir, "claude"));
const oldClaude = (dir: string) =>
  fs.writeFileSync(
    path.join(dir, "claude"),
    '#!/bin/sh\necho "2.1.100 (Claude Code)"\n',
    {
      mode: 0o755,
    },
  );

describe("locateClaude", () => {
  it("reads the version from claude --version", () => {
    expect(parseClaudeVersion("2.1.300 (Claude Code)\n")).toBe("2.1.300");
    expect(parseClaudeVersion("command not found")).toBeNull();
    // Another program's version isn't Claude Code's, as when choosing python3.
    expect(parseClaudeVersion("Python 3.12.1\n")).toBeNull();
    expect(parseClaudeVersion("v22.14.0\n")).toBeNull();
    expect(compareVersions("2.1.268", "2.1.300")).toBeLessThan(0);
    expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
  });

  it("finds claude on PATH first", async () => {
    const bin = tmp("dp-path-");
    link(bin);
    expect(
      await locateClaude({
        pathEnv: `${bin}:/usr/bin`,
        home: tmp("dp-home-"),
        savedPath: null,
        knownDirs: [],
      }),
    ).toEqual({
      state: "found",
      path: path.join(bin, "claude"),
      version: "2.1.300",
    });
  });

  it("finds claude in a known install folder when opened from the Dock", async () => {
    const home = tmp("dp home ");
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    link(path.join(home, ".local", "bin"));
    expect(
      await locateClaude({
        pathEnv: "/usr/bin:/bin",
        home,
        savedPath: null,
        knownDirs: knownInstallDirs(home),
      }),
    ).toEqual({
      state: "found",
      path: path.join(home, ".local", "bin", "claude"),
      version: "2.1.300",
    });
  });

  it("uses the saved path when nothing else is found", async () => {
    const elsewhere = tmp("dp-saved-");
    link(elsewhere);
    const saved = path.join(elsewhere, "claude");
    expect(
      await locateClaude({
        pathEnv: "",
        home: tmp("dp-home-"),
        savedPath: saved,
        knownDirs: [],
      }),
    ).toEqual({ state: "found", path: saved, version: "2.1.300" });
  });

  it("skips a too-old binary for a new enough one, and reports too_old when none is", async () => {
    const a = tmp("dp-old-");
    oldClaude(a);
    const b = tmp("dp-new-");
    link(b);
    const found = await locateClaude({
      pathEnv: `${a}:${b}`,
      home: tmp("h"),
      savedPath: null,
      knownDirs: [],
    });
    expect(found).toMatchObject({
      state: "found",
      path: path.join(b, "claude"),
    });
    expect(
      await locateClaude({
        pathEnv: a,
        home: tmp("h"),
        savedPath: null,
        knownDirs: [],
      }),
    ).toEqual({
      state: "too_old",
      path: path.join(a, "claude"),
      version: "2.1.100",
    });
  });

  it("reports missing when nothing is found", async () => {
    expect(
      await locateClaude({
        pathEnv: "",
        home: tmp("h"),
        savedPath: null,
        knownDirs: [],
      }),
    ).toEqual({
      state: "missing",
    });
  });
});
