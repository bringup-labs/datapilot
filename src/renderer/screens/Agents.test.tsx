import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { Agents } from "./Agents";
import { useUIStore } from "@renderer/stores/ui";
import { useClaudeCodeStore } from "@renderer/stores/claudeCode";

vi.mock("@renderer/services/api", () => ({
  fetchAgentModels: vi.fn().mockResolvedValue({}),
  setAgentModel: vi.fn(),
  deleteAgentModel: vi.fn(),
}));

const initialUI = useUIStore.getState();
const initialCC = useClaudeCodeStore.getState();

describe("Agents", () => {
  beforeEach(() => {
    useUIStore.setState(initialUI, true);
    useClaudeCodeStore.setState(
      { ...initialCC, refresh: vi.fn().mockResolvedValue(undefined) },
      true,
    );
  });
  afterEach(cleanup);

  it("opens on the MCP tab when asked, and the header counts don't change", async () => {
    useUIStore.setState({ agentsSectionTarget: "mcp" });
    await act(async () => {
      render(<Agents />);
    });
    expect(screen.getByText("Connected servers")).toBeTruthy();
    expect(screen.getByText("DataPilot tools for Claude Code")).toBeTruthy();
    expect(useUIStore.getState().agentsSectionTarget).toBeNull();
    expect(screen.getByText(/4\/6 MCP/)).toBeTruthy();
  });

  it("opens on the agents tab by default", async () => {
    await act(async () => {
      render(<Agents />);
    });
    expect(screen.getByText("Built-in agents")).toBeTruthy();
    expect(screen.queryByText("DataPilot tools for Claude Code")).toBeNull();
  });
});
