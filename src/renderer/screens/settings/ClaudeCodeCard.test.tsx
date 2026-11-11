import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ClaudeCodeCard } from "./ClaudeCodeCard";
import { useClaudeCodeStore } from "@renderer/stores/claudeCode";
import { useSettingsStore } from "@renderer/stores/settings";
import type { ClaudeCodeStatus } from "@shared/ipc";

vi.mock("@renderer/services/api", () => ({
  updateBackendKey: vi.fn(),
  clearAllSessions: vi.fn(),
}));

const NAMES = Array.from({ length: 17 }, (_, i) => `tool_${i}`);
const READY: ClaudeCodeStatus = {
  install: { state: "found", path: "/Users/test/.local/bin/claude", version: "2.1.300" },
  auth: { signedIn: true, method: "claude.ai", configDirectory: "/Users/test/.claude" },
  tools: { reachable: true, names: NAMES },
  ready: true,
};
const SIGNED_OUT: ClaudeCodeStatus = {
  ...READY,
  auth: { signedIn: false, method: "none", configDirectory: null },
  ready: false,
};

const initialSettings = useSettingsStore.getState();
const initialStore = useClaudeCodeStore.getState();

interface Spies {
  refresh: ReturnType<typeof vi.fn>;
  signIn: ReturnType<typeof vi.fn>;
  chooseBinary: ReturnType<typeof vi.fn>;
  openInstallGuide: ReturnType<typeof vi.fn>;
  setSetting: ReturnType<typeof vi.fn>;
}

function setup(
  status: ClaudeCodeStatus | null,
  extra: Partial<ReturnType<typeof useClaudeCodeStore.getState>> = {},
  engine: "datapilot" | "claude_code" = "datapilot",
): Spies {
  const spies: Spies = {
    refresh: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue(undefined),
    chooseBinary: vi.fn().mockResolvedValue(undefined),
    openInstallGuide: vi.fn().mockResolvedValue(undefined),
    setSetting: vi.fn().mockResolvedValue(undefined),
  };
  useClaudeCodeStore.setState({
    status,
    checking: false,
    signingIn: false,
    error: null,
    refresh: spies.refresh,
    signIn: spies.signIn,
    chooseBinary: spies.chooseBinary,
    openInstallGuide: spies.openInstallGuide,
    ...extra,
  });
  useSettingsStore.setState({
    copilotEngine: engine,
    claudeCodeModel: "",
    setSetting: spies.setSetting,
  });
  render(<ClaudeCodeCard />);
  return spies;
}

describe("ClaudeCodeCard", () => {
  beforeEach(() => {
    useClaudeCodeStore.setState(initialStore, true);
    useSettingsStore.setState(initialSettings, true);
  });
  afterEach(cleanup);

  it("shows the title, hint and row labels, and checks on mount", () => {
    const s = setup(READY);
    expect(screen.getByText("Claude Code on this computer")).toBeTruthy();
    expect(
      screen.getByText(
        "Answers Copilot questions with the Claude Code installed here, using its own sign-in.",
      ),
    ).toBeTruthy();
    for (const l of ["Installed", "Signed in", "DataPilot's tools", "Model", "Use for Copilot"]) {
      expect(screen.getAllByText(l).length).toBeGreaterThan(0);
    }
    expect(s.refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the version and path when Claude Code is installed", () => {
    setup(READY);
    expect(screen.getByText("Claude Code 2.1.300")).toBeTruthy();
    expect(screen.getByText("/Users/test/.local/bin/claude")).toBeTruthy();
  });

  it("offers the install guide, Check again and Choose location when it's missing", () => {
    const s = setup({ ...READY, install: { state: "missing" }, auth: null, ready: false });
    expect(screen.getByText("Not found on this computer.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open install guide" }));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose location…" }));
    expect(s.openInstallGuide).toHaveBeenCalledTimes(1);
    expect(s.refresh).toHaveBeenCalledTimes(2); // mount + click
    expect(s.chooseBinary).toHaveBeenCalledTimes(1);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("names the minimum version and the update command when it's too old", () => {
    setup({
      ...READY,
      install: { state: "too_old", path: "/opt/claude", version: "2.1.100" },
      ready: false,
    });
    expect(screen.getByText(/DataPilot needs Claude Code 2\.1\.268 or later/)).toBeTruthy();
    expect(screen.getByText(/Found 2\.1\.100 at \/opt\/claude/)).toBeTruthy();
    expect(screen.getByText("claude update")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Choose location…" })).toBeNull();
  });

  it("shows the error under the installed row", () => {
    setup({ ...READY, install: { state: "missing" } }, { error: "That file isn't Claude Code." });
    expect(screen.getByText("That file isn't Claude Code.")).toBeTruthy();
  });

  it("shows who pays and the settings folder when signed in", () => {
    setup(READY);
    expect(screen.getByText("Signed in with your Claude plan")).toBeTruthy();
    expect(screen.getByText("Settings folder: /Users/test/.claude")).toBeTruthy();
  });

  it("offers Sign in with Claude Code and the terminal fallback when signed out", () => {
    const s = setup(SIGNED_OUT);
    expect(screen.getByText("Claude Code isn't signed in.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude Code" }));
    expect(s.signIn).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Or run/)).toBeTruthy();
    expect(screen.getByText("claude", { selector: "code" })).toBeTruthy();
    expect(screen.getByText(/and type \/login\./)).toBeTruthy();
    expect(
      screen.getByText(
        "If you set ANTHROPIC_API_KEY, a proxy or a cloud provider in your shell, DataPilot doesn't see it when opened from the Dock or app menu. Put those settings in the env block of Claude Code's settings file, or sign in with Claude Code.",
      ),
    ).toBeTruthy();
  });

  // The folder shows which Claude Code sign-in DataPilot reads, so a user
  // signed in from the terminal can spot that it's another one.
  it("shows the settings folder when signed out too", () => {
    setup({ ...SIGNED_OUT, auth: { signedIn: false, method: "none", configDirectory: "/Users/test/.claude-work" } });
    expect(screen.getByText("Claude Code isn't signed in.")).toBeTruthy();
    expect(screen.getByText("Settings folder: /Users/test/.claude-work")).toBeTruthy();
  });

  it("shows no settings folder when Claude Code reports none", () => {
    setup(SIGNED_OUT);
    expect(screen.queryByText(/Settings folder:/)).toBeNull();
  });

  it("disables the sign-in button while waiting for the browser", () => {
    setup(SIGNED_OUT, { signingIn: true });
    const b = screen.getByRole("button", {
      name: "Waiting for sign-in in your browser…",
    }) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
  });

  it("shows how many tools Claude Code can reach", () => {
    setup(READY);
    expect(screen.getByText("17 tools for the open bag, on this computer")).toBeTruthy();
  });

  it("says the tools are unreachable otherwise, with Check again", () => {
    const s = setup({ ...READY, tools: { reachable: false, names: [] }, ready: false });
    expect(
      screen.getByText("Not reachable yet. DataPilot's services may still be starting."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(s.refresh).toHaveBeenCalledTimes(2);
  });

  it("enables Use for Copilot only when every check passes", () => {
    setup(SIGNED_OUT);
    const sw = screen.getByRole("switch", { name: "Use for Copilot" }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(screen.getByText("Available when every check above passes.")).toBeTruthy();
    cleanup();
    setup(READY);
    const sw2 = screen.getByRole("switch", { name: "Use for Copilot" }) as HTMLButtonElement;
    expect(sw2.disabled).toBe(false);
    expect(screen.queryByText("Available when every check above passes.")).toBeNull();
  });

  it("turning on Use for Copilot makes Claude Code the Copilot engine", () => {
    const s = setup(READY);
    fireEvent.click(screen.getByRole("switch", { name: "Use for Copilot" }));
    expect(s.setSetting).toHaveBeenCalledWith("copilotEngine", "claude_code");
  });

  it("always lets the user turn Use for Copilot off", () => {
    const s = setup(SIGNED_OUT, {}, "claude_code");
    const sw = screen.getByRole("switch", { name: "Use for Copilot" }) as HTMLButtonElement;
    expect(sw.disabled).toBe(false);
    fireEvent.click(sw);
    expect(s.setSetting).toHaveBeenCalledWith("copilotEngine", "datapilot");
  });

  it("names the model menu for screen readers", () => {
    setup(READY);
    expect(screen.getByRole("combobox", { name: "Model" })).toBeTruthy();
  });

  it("saves the model choice", () => {
    const s = setup(READY);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Opus" } });
    expect(s.setSetting).toHaveBeenCalledWith("claudeCodeModel", "opus");
  });

  it("shows the privacy note", () => {
    setup(READY);
    expect(
      screen.getByText(
        "Your question and the log excerpts Claude Code reads go to Anthropic under your own account. DataPilot never sees your Claude sign-in.",
      ),
    ).toBeTruthy();
  });
});
