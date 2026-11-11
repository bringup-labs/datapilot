// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FAKE_CLAUDE } from "../test/claude-code/fakeClaude";

const mocks = vi.hoisted(() => ({
  userData: "",
  bagRoot: "",
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  openPath: vi.fn(),
  openExternal: vi.fn(),
  currentStatus: vi.fn(),
  runner: {
    ask: vi.fn(),
    stop: vi.fn(),
    killAll: vi.fn(),
    cleanMode: vi.fn(),
  },
  window: {
    id: 1,
    isDestroyed: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
    webContents: { send: vi.fn() },
  },
}));

vi.mock("electron", () => ({
  app: {
    getPath: (name: string) =>
      name === "userData" ? mocks.userData : os.tmpdir(),
    getVersion: () => "0.0.0",
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
  dialog: {
    showOpenDialog: mocks.showOpenDialog,
    showMessageBox: mocks.showMessageBox,
  },
  shell: { openPath: mocks.openPath, openExternal: mocks.openExternal },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => mocks.window,
  },
}));

vi.mock("./dockerOrchestrator", () => ({
  dockerOrchestrator: {
    getStatus: () => ({ state: "pending" }),
    getBagRoot: () => mocks.bagRoot,
  },
}));

vi.mock("./claudeCode", () => ({
  claudeRunner: mocks.runner,
  currentStatus: mocks.currentStatus,
}));

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("settings file location", () => {
  let importTimeDir: string;
  let activeDir: string;

  beforeEach(() => {
    importTimeDir = tempDir("dp-import-");
    activeDir = tempDir("dp-active-");
    mocks.handlers.clear();
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(importTimeDir, { recursive: true, force: true });
    fs.rmSync(activeDir, { recursive: true, force: true });
  });

  // index.ts points `userData` at a separate dev profile, but ES imports are
  // hoisted, so that happens after this module has been evaluated. Resolving
  // the path at import time made dev builds write to the installed app's profile
  // while the orchestrator read secrets from the dev one.
  it("follows the userData directory set after the module is imported", async () => {
    mocks.userData = importTimeDir;
    const { registerIpcHandlers } = await import("./ipcHandlers");

    mocks.userData = activeDir;
    registerIpcHandlers();
    await mocks.handlers.get("settings:set")!({}, "theme", "dark");

    expect(fs.existsSync(path.join(activeDir, "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(importTimeDir, "settings.json"))).toBe(false);
  });
});

describe("file:pickBag", () => {
  let elsewhere: string;
  const pick = () => mocks.handlers.get("file:pickBag")!({ sender: {} });

  beforeEach(async () => {
    mocks.userData = tempDir("dp-user-");
    mocks.bagRoot = tempDir("dp-bags-");
    elsewhere = tempDir("dp-elsewhere-");
    mocks.handlers.clear();
    mocks.showOpenDialog.mockReset();
    mocks.showMessageBox.mockReset();
    mocks.openPath.mockReset();
    vi.resetModules();
    const { registerIpcHandlers } = await import("./ipcHandlers");
    registerIpcHandlers();
  });

  afterEach(() => {
    for (const dir of [mocks.userData, mocks.bagRoot, elsewhere]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function selecting(file: string): string {
    fs.writeFileSync(file, "bag");
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [file],
    });
    return file;
  }

  it("opens in the folder DataPilot can read, offering only formats it parses", async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    await pick();

    const options = mocks.showOpenDialog.mock.calls[0][1];
    expect(options.defaultPath).toBe(mocks.bagRoot);
    expect(options.filters[0].extensions).toEqual(["mcap", "db3"]);
  });

  it("returns a bag inside the bag folder without prompting", async () => {
    const bag = selecting(path.join(mocks.bagRoot, "run.mcap"));

    await expect(pick()).resolves.toBe(bag);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("accepts a bag in a subfolder of the bag folder", async () => {
    fs.mkdirSync(path.join(mocks.bagRoot, "site_a"));
    const bag = selecting(path.join(mocks.bagRoot, "site_a", "run.mcap"));

    await expect(pick()).resolves.toBe(bag);
  });

  // The containers can only see the bag folder. Without this check the backend
  // reports a "parsed" session holding nothing but a file-not-found log line.
  it("refuses a bag outside the bag folder and says where to put it", async () => {
    selecting(path.join(elsewhere, "run.mcap"));
    mocks.showMessageBox.mockResolvedValue({ response: 1 });

    await expect(pick()).resolves.toBeNull();

    const message = mocks.showMessageBox.mock.calls[0][1];
    expect(message.detail).toContain(mocks.bagRoot);
    expect(mocks.openPath).not.toHaveBeenCalled();
  });

  it("can open the bag folder from that message", async () => {
    selecting(path.join(elsewhere, "run.mcap"));
    mocks.showMessageBox.mockResolvedValue({ response: 0 });

    await pick();

    expect(mocks.openPath).toHaveBeenCalledWith(mocks.bagRoot);
  });

  it("refuses a symlink in the bag folder that points outside it", async () => {
    const target = path.join(elsewhere, "real.mcap");
    fs.writeFileSync(target, "bag");
    const link = path.join(mocks.bagRoot, "link.mcap");
    fs.symlinkSync(target, link);
    mocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [link],
    });
    mocks.showMessageBox.mockResolvedValue({ response: 1 });

    await expect(pick()).resolves.toBeNull();
  });
});

describe("Claude Code handlers", () => {
  const sender = { sender: {} };
  const status = { install: { state: "missing" }, auth: null, tools: { reachable: false, names: [] }, ready: false };

  function settingsFile(): Record<string, unknown> {
    const f = path.join(mocks.userData, "settings.json");
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf-8")) : {};
  }

  beforeEach(async () => {
    mocks.userData = tempDir("dp-user-");
    mocks.handlers.clear();
    mocks.showOpenDialog.mockReset();
    mocks.openExternal.mockReset();
    mocks.currentStatus.mockReset().mockResolvedValue(status);
    mocks.runner.ask.mockReset().mockResolvedValue(undefined);
    mocks.runner.stop.mockReset().mockResolvedValue(undefined);
    mocks.window.once.mockReset();
    mocks.window.removeListener.mockReset();
    mocks.window.webContents.send.mockReset();
    vi.resetModules();
    const { registerIpcHandlers } = await import("./ipcHandlers");
    registerIpcHandlers();
  });

  afterEach(() => {
    fs.rmSync(mocks.userData, { recursive: true, force: true });
  });

  it("settings:set refuses to point DataPilot at another claude binary", async () => {
    await expect(
      mocks.handlers.get("settings:set")!(sender, "claude_code_path", "/tmp/evil"),
    ).rejects.toThrow();
    expect(settingsFile()).not.toHaveProperty("claude_code_path");
  });

  it("status reports the current status for the saved path", async () => {
    await expect(mocks.handlers.get("claudeCode:status")!(sender)).resolves.toEqual(status);
    expect(mocks.currentStatus).toHaveBeenCalledWith(null);
  });

  it("chooseBinary saves a file that reports a Claude Code version", async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [FAKE_CLAUDE] });
    await expect(mocks.handlers.get("claudeCode:chooseBinary")!(sender)).resolves.toEqual(status);
    expect(settingsFile().claude_code_path).toBe(FAKE_CLAUDE);
    expect(mocks.currentStatus).toHaveBeenCalledWith(FAKE_CLAUDE);
  });

  it("chooseBinary refuses a file that isn't Claude Code", async () => {
    const txt = path.join(mocks.userData, "notes.txt");
    fs.writeFileSync(txt, "hello");
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [txt] });
    await expect(mocks.handlers.get("claudeCode:chooseBinary")!(sender)).rejects.toThrow(
      "That file isn't Claude Code.",
    );
    expect(settingsFile()).not.toHaveProperty("claude_code_path");
  });

  it("chooseBinary refuses another program that prints a version", async () => {
    const python = path.join(mocks.userData, "python3");
    fs.writeFileSync(python, '#!/bin/sh\necho "Python 3.12.1"\n', { mode: 0o755 });
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [python] });
    await expect(mocks.handlers.get("claudeCode:chooseBinary")!(sender)).rejects.toThrow(
      "That file isn't Claude Code.",
    );
    expect(settingsFile()).not.toHaveProperty("claude_code_path");
  });

  // On macOS the dialog resolves symlinks unless told not to, which turns an
  // nvm or npm `claude` into its cli.js, in a folder without `node`.
  it("chooseBinary keeps a chosen link as it is, and shows hidden folders", async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await mocks.handlers.get("claudeCode:chooseBinary")!(sender);
    expect(mocks.showOpenDialog.mock.calls[0][1].properties).toEqual([
      "openFile",
      "showHiddenFiles",
      "noResolveAliases",
    ]);
  });

  it("chooseBinary saves nothing when the dialog is cancelled", async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(mocks.handlers.get("claudeCode:chooseBinary")!(sender)).resolves.toEqual(status);
    expect(settingsFile()).not.toHaveProperty("claude_code_path");
  });

  it("ask validates the request and streams events to the asking window", async () => {
    await mocks.handlers.get("claudeCode:ask")!(sender, "sub-1", { sessionId: "s1", question: "why?", model: "" });
    const opts = mocks.runner.ask.mock.calls[0][0];
    expect(opts).toMatchObject({ subId: "sub-1", sessionId: "s1", question: "why?", model: "", savedPath: null });
    opts.onEvent({ event: "step-add", data: { label: "Find aborts" } });
    expect(mocks.window.webContents.send).toHaveBeenCalledWith("claudeCode:event:sub-1", {
      event: "step-add",
      data: { label: "Find aborts" },
    });
  });

  it("ask rejects a malformed request without starting a run", async () => {
    await expect(
      mocks.handlers.get("claudeCode:ask")!(sender, "sub-1", { sessionId: "../x", question: "q", model: "" }),
    ).rejects.toThrow();
    await expect(
      mocks.handlers.get("claudeCode:ask")!(sender, "bad id!", { sessionId: "s", question: "q", model: "" }),
    ).rejects.toThrow();
    expect(mocks.runner.ask).not.toHaveBeenCalled();
  });

  it("closing the window stops its run", async () => {
    mocks.runner.ask.mockReturnValue(new Promise(() => {}));
    await mocks.handlers.get("claudeCode:ask")!(sender, "sub-1", { sessionId: "s1", question: "why?", model: "" });
    const onClosed = mocks.window.once.mock.calls.find((c) => c[0] === "closed")![1] as () => void;
    onClosed();
    expect(mocks.runner.stop).toHaveBeenCalledWith("sub-1");
  });

  it("removes its closed listener when the run settles", async () => {
    await mocks.handlers.get("claudeCode:ask")!(sender, "sub-1", { sessionId: "s1", question: "why?", model: "" });
    await new Promise((r) => setImmediate(r));
    const onClosed = mocks.window.once.mock.calls.find((c) => c[0] === "closed")![1];
    expect(mocks.window.removeListener).toHaveBeenCalledWith("closed", onClosed);
  });

  it("stop stops the run by subId", async () => {
    await mocks.handlers.get("claudeCode:stop")!(sender, "sub-1");
    expect(mocks.runner.stop).toHaveBeenCalledWith("sub-1");
  });

  it("openInstallGuide opens the setup page", async () => {
    await mocks.handlers.get("claudeCode:openInstallGuide")!(sender);
    expect(mocks.openExternal).toHaveBeenCalledWith("https://code.claude.com/docs/en/setup");
  });
});
