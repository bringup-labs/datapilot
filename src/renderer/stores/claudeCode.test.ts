import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useClaudeCodeStore } from "./claudeCode";
import type { ClaudeCodeStatus } from "@shared/ipc";

const initial = useClaudeCodeStore.getState();

const READY: ClaudeCodeStatus = {
  install: { state: "found", path: "/Users/test/.local/bin/claude", version: "2.1.300" },
  auth: { signedIn: true, method: "claude.ai", configDirectory: "/Users/test/.claude" },
  tools: { reachable: true, names: ["a", "b"] },
  ready: true,
};
const SIGNED_OUT: ClaudeCodeStatus = {
  ...READY,
  auth: { signedIn: false, method: "none", configDirectory: null },
  ready: false,
};

function install(claudeCode: Record<string, unknown>): void {
  (window as unknown as { datapilot: unknown }).datapilot = { claudeCode };
}

describe("useClaudeCodeStore", () => {
  beforeEach(() => {
    useClaudeCodeStore.setState(initial, true);
  });
  afterEach(() => {
    delete (window as unknown as { datapilot?: unknown }).datapilot;
  });

  it("refresh stores the status from main", async () => {
    install({ status: vi.fn().mockResolvedValue(READY) });
    const p = useClaudeCodeStore.getState().refresh();
    expect(useClaudeCodeStore.getState().checking).toBe(true);
    await p;
    const s = useClaudeCodeStore.getState();
    expect(s.status).toEqual(READY);
    expect(s.checking).toBe(false);
    expect(s.error).toBeNull();
  });

  it("signIn shows signing-in until main answers, then stores the status", async () => {
    let resolve!: (v: ClaudeCodeStatus) => void;
    install({
      signIn: vi.fn(() => new Promise<ClaudeCodeStatus>((r) => (resolve = r))),
    });
    const p = useClaudeCodeStore.getState().signIn();
    expect(useClaudeCodeStore.getState().signingIn).toBe(true);
    resolve(READY);
    await p;
    const s = useClaudeCodeStore.getState();
    expect(s.signingIn).toBe(false);
    expect(s.status).toEqual(READY);
  });

  it("chooseBinary stores the status it gets back", async () => {
    install({ chooseBinary: vi.fn().mockResolvedValue(SIGNED_OUT) });
    await useClaudeCodeStore.getState().chooseBinary();
    expect(useClaudeCodeStore.getState().status).toEqual(SIGNED_OUT);
  });

  it("chooseBinary keeps main's message when the file isn't Claude Code", async () => {
    install({
      chooseBinary: vi.fn().mockRejectedValue(new Error("That file isn't Claude Code.")),
    });
    await useClaudeCodeStore.getState().chooseBinary();
    expect(useClaudeCodeStore.getState().error).toBe("That file isn't Claude Code.");
  });

  // A rejected ipcRenderer.invoke carries main's message behind the channel
  // and the error's class: show main's message alone.
  it.each(["That file isn't Claude Code.", "Couldn't save that choice."])(
    "chooseBinary shows %j without the prefix Electron adds",
    async (text) => {
      install({
        chooseBinary: vi
          .fn()
          .mockRejectedValue(
            new Error(
              `Error invoking remote method 'claudeCode:chooseBinary': IpcValidationError: ${text}`,
            ),
          ),
      });
      await useClaudeCodeStore.getState().chooseBinary();
      expect(useClaudeCodeStore.getState().error).toBe(text);
    },
  );

  it("strips the prefix from a plain Error raised in main too", async () => {
    install({
      status: vi
        .fn()
        .mockRejectedValue(
          new Error("Error invoking remote method 'claudeCode:status': Error: spawn EACCES"),
        ),
    });
    await useClaudeCodeStore.getState().refresh();
    expect(useClaudeCodeStore.getState().error).toBe("spawn EACCES");
  });

  it("openInstallGuide calls the bridge", async () => {
    const openInstallGuide = vi.fn().mockResolvedValue(undefined);
    install({ openInstallGuide });
    await useClaudeCodeStore.getState().openInstallGuide();
    expect(openInstallGuide).toHaveBeenCalledTimes(1);
  });

  it("does nothing without the preload bridge", async () => {
    const s = useClaudeCodeStore.getState();
    await s.refresh();
    await s.signIn();
    await s.chooseBinary();
    await s.openInstallGuide();
    expect(useClaudeCodeStore.getState()).toMatchObject({
      status: null,
      checking: false,
      signingIn: false,
      error: null,
    });
  });
});
