import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ClaudeCodeToolsRow } from "./ClaudeCodeToolsRow";
import { useClaudeCodeStore } from "@renderer/stores/claudeCode";
import type { ClaudeCodeStatus } from "@shared/ipc";

const NAMES = [
  "get_bag_overview",
  ...Array.from({ length: 16 }, (_, i) => `tool_${i}`),
];
const READY: ClaudeCodeStatus = {
  install: { state: "found", path: "/Users/test/.local/bin/claude", version: "2.1.300" },
  auth: { signedIn: true, method: "claude.ai", configDirectory: "/Users/test/.claude" },
  tools: { reachable: true, names: NAMES },
  ready: true,
};

const initialStore = useClaudeCodeStore.getState();

function setup(
  status: ClaudeCodeStatus | null,
  extra: Partial<ReturnType<typeof useClaudeCodeStore.getState>> = {},
): { refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn().mockResolvedValue(undefined);
  useClaudeCodeStore.setState({ status, checking: false, refresh, ...extra });
  render(<ClaudeCodeToolsRow />);
  return { refresh };
}

describe("ClaudeCodeToolsRow", () => {
  beforeEach(() => useClaudeCodeStore.setState(initialStore, true));
  afterEach(cleanup);

  it("shows the endpoint's status and the tools it exposes", () => {
    const { refresh } = setup(READY);
    expect(screen.getByText("DataPilot tools for Claude Code")).toBeTruthy();
    expect(screen.getByText("connected")).toBeTruthy();
    expect(screen.getByText("http")).toBeTruthy();
    expect(screen.getByText("17 tools")).toBeTruthy();
    expect(screen.getByText("http://localhost:8000/mcp")).toBeTruthy();
    expect(screen.getByText(/Read-only, for troubleshooting\./)).toBeTruthy();
    expect(screen.getByText(/get_bag_overview/)).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows unreachable when the endpoint can't be reached, without a tool count or list", () => {
    setup({ ...READY, tools: { reachable: false, names: [] } });
    expect(screen.getByText("unreachable")).toBeTruthy();
    expect(screen.queryByText(/\d+ tools/)).toBeNull();
    expect(screen.queryByText(/Tools:/)).toBeNull();
    expect(screen.getByText("Read-only, for troubleshooting.")).toBeTruthy();
  });

  it("checks on mount when there is no status yet", () => {
    const { refresh } = setup(null, { checking: true });
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByText("checking")).toBeTruthy();
    expect(screen.queryByText(/Tools:/)).toBeNull();
  });

  it("is read-only", () => {
    setup(READY);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("Refresh checks again", () => {
    const { refresh } = setup(READY);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
