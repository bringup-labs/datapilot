import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ClaudeCodeStatus } from "@shared/ipc";
import { useSettingsStore } from "@renderer/stores/settings";
import { useClaudeCodeStore } from "@renderer/stores/claudeCode";
import { useUIStore } from "@renderer/stores/ui";
import { EngineMenu } from "./EngineMenu";

const READY_WITH_API_KEY: ClaudeCodeStatus = {
  install: { state: "found", path: "/usr/local/bin/claude", version: "2.1.300" },
  auth: { signedIn: true, method: "api_key", configDirectory: "/Users/t/.claude" },
  tools: { reachable: true, names: ["a"] },
  ready: true,
};
const SIGNED_OUT: ClaudeCodeStatus = {
  ...READY_WITH_API_KEY,
  auth: { signedIn: false, method: "none", configDirectory: null },
  ready: false,
};

const settingsInitial = useSettingsStore.getState();
const uiInitial = useUIStore.getState();
const ccInitial = useClaudeCodeStore.getState();

describe("EngineMenu", () => {
  const setSetting = vi.fn();
  beforeEach(() => {
    setSetting.mockReset();
    useSettingsStore.setState(
      {
        ...settingsInitial,
        defaultProvider: "google",
        defaultModel: "gemini-3.1-flash-lite",
        copilotEngine: "datapilot",
        claudeCodeModel: "",
        setSetting,
      },
      true,
    );
    useUIStore.setState(uiInitial, true);
    useClaudeCodeStore.setState({ ...ccInitial, status: READY_WITH_API_KEY }, true);
  });

  it("shows the current engine on the pill", () => {
    const { unmount } = render(<EngineMenu />);
    expect(
      screen.getByRole("button", { name: /gemini-3.1-flash-lite/ }),
    ).toBeInTheDocument();
    unmount();
    useSettingsStore.setState({ copilotEngine: "claude_code", claudeCodeModel: "sonnet" });
    render(<EngineMenu />);
    expect(screen.getByText("Claude Code · Sonnet")).toBeInTheDocument();
  });

  it("lists DataPilot's agents and Claude Code with model and who pays", async () => {
    const user = userEvent.setup();
    render(<EngineMenu />);
    await user.click(screen.getByRole("button", { name: /gemini-3.1-flash-lite/ }));
    expect(screen.getByText("Answer with")).toBeInTheDocument();
    expect(
      screen.getByText("Gemini (Google) · gemini-3.1-flash-lite"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Claude Code's default · your API key"),
    ).toBeInTheDocument();
  });

  it("choosing Claude Code applies from the next question on", async () => {
    const user = userEvent.setup();
    render(<EngineMenu />);
    await user.click(screen.getByRole("button", { name: /gemini-3.1-flash-lite/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /Claude Code/ }));
    expect(setSetting).toHaveBeenCalledWith("copilotEngine", "claude_code");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("offers Set up when Claude Code isn't ready and opens its Settings card", async () => {
    useClaudeCodeStore.setState({ status: SIGNED_OUT });
    const user = userEvent.setup();
    render(<EngineMenu />);
    await user.click(screen.getByRole("button", { name: /gemini-3.1-flash-lite/ }));
    expect(screen.getByText("Set up")).toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: /Claude Code/ }));
    expect(useUIStore.getState().screen).toBe("settings");
    expect(useUIStore.getState().settingsSectionTarget).toBe("models");
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("checks the status when opened without one", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    useClaudeCodeStore.setState({ status: null, refresh });
    const user = userEvent.setup();
    render(<EngineMenu />);
    await user.click(screen.getByRole("button", { name: /gemini-3.1-flash-lite/ }));
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText("Checking…")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    render(<EngineMenu />);
    const pill = screen.getByRole("button", { name: /gemini-3.1-flash-lite/ });
    await user.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(pill).toHaveAttribute("aria-expanded", "false");
  });
});
