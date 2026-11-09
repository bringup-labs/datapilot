// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  userData: "",
  bagRoot: "",
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  openPath: vi.fn(),
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
  shell: { openPath: mocks.openPath },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => ({ id: 1 }),
  },
}));

vi.mock("./dockerOrchestrator", () => ({
  dockerOrchestrator: {
    getStatus: () => ({ state: "pending" }),
    getBagRoot: () => mocks.bagRoot,
  },
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
