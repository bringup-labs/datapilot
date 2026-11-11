import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindingsCard } from "./FindingsCard";
import { PlanCard } from "./PlanCard";
import { ChatMessage } from "./ChatMessage";
import { useChatStore } from "@renderer/stores/chat";
import { useUIStore } from "@renderer/stores/ui";
import { useSettingsStore } from "@renderer/stores/settings";
import { useClaudeCodeStore } from "@renderer/stores/claudeCode";
import type {
  ChatMessage as ChatMessageType,
  Finding,
  PlanStep,
} from "@shared/types";

// Reset the zustand stores between tests so ChatMessage's `isThinking`
// derivation (streaming + last-message id) is deterministic.
beforeEach(() => {
  useChatStore.setState({ messages: [], streaming: false });
  useUIStore.setState({ tab: "timeline" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("FindingsCard", () => {
  const findings: Finding[] = [
    { sev: "critical", text: "Planner aborted at t=12.4s", detail: "node /move_base" },
    { sev: "warning", text: "Battery dipped to 18%" },
    { sev: "info", text: "Localization recovered" },
  ];

  it("renders the section title", () => {
    render(<FindingsCard findings={findings} />);
    expect(screen.getByText("Key findings")).toBeInTheDocument();
  });

  it("renders one row per finding with its text", () => {
    render(<FindingsCard findings={findings} />);
    expect(screen.getByText("Planner aborted at t=12.4s")).toBeInTheDocument();
    expect(screen.getByText("Battery dipped to 18%")).toBeInTheDocument();
    expect(screen.getByText("Localization recovered")).toBeInTheDocument();
  });

  it("renders the optional detail line when present", () => {
    render(<FindingsCard findings={findings} />);
    expect(screen.getByText("node /move_base")).toBeInTheDocument();
  });

  it("renders a severity pill per finding mapped to the right tone", () => {
    render(<FindingsCard findings={findings} />);
    // SeverityDot maps critical->danger, warning->warn, info->accent
    expect(screen.getByText("critical")).toHaveClass("pill", "danger");
    expect(screen.getByText("warning")).toHaveClass("pill", "warn");
    expect(screen.getByText("info")).toHaveClass("pill", "accent");
  });

  it("renders empty (just the header) when given no findings", () => {
    render(<FindingsCard findings={[]} />);
    expect(screen.getByText("Key findings")).toBeInTheDocument();
    expect(screen.queryByText("critical")).toBeNull();
  });
});

describe("PlanCard", () => {
  const steps: PlanStep[] = [
    {
      label: "Index diagnostics",
      done: true,
      active: false,
      confidence: 0.92,
      outputSummary: "1,204 messages indexed",
    },
    { label: "Trace causal edges", done: false, active: true },
    { label: "Compose answer", done: false, active: false },
  ];

  it("renders the plan title and every step label", () => {
    render(<PlanCard steps={steps} />);
    expect(screen.getByText("Analysis Plan")).toBeInTheDocument();
    expect(screen.getByText("Index diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Trace causal edges")).toBeInTheDocument();
    expect(screen.getByText("Compose answer")).toBeInTheDocument();
  });

  it("shows a rounded confidence badge for completed steps", () => {
    render(<PlanCard steps={steps} />);
    expect(screen.getByText("92%")).toBeInTheDocument();
  });

  it("shows a running indicator for the active step", () => {
    render(<PlanCard steps={steps} />);
    expect(screen.getByText("running…")).toBeInTheDocument();
  });

  it("renders a collapsible details summary for completed steps with output", () => {
    render(<PlanCard steps={steps} />);
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByText("1,204 messages indexed")).toBeInTheDocument();
  });

  it("shows the composing indicator only when isComposing is set", () => {
    const { rerender } = render(<PlanCard steps={steps} />);
    expect(screen.queryByText("Composing response…")).toBeNull();
    rerender(<PlanCard steps={steps} isComposing />);
    expect(screen.getByText("Composing response…")).toBeInTheDocument();
  });
});

describe("ChatMessage", () => {
  it("renders a user message bubble with its text", () => {
    const msg: ChatMessageType = {
      id: "u1",
      role: "user",
      text: "Why did the robot stop?",
    };
    render(<ChatMessage msg={msg} />);
    expect(screen.getByText("Why did the robot stop?")).toBeInTheDocument();
  });

  it("renders a system message with its text", () => {
    const msg: ChatMessageType = {
      id: "s1",
      role: "system",
      text: "Session restored",
    };
    render(<ChatMessage msg={msg} />);
    expect(screen.getByText("Session restored")).toBeInTheDocument();
  });

  it("renders an assistant message with the DataPilot label and timestamp", () => {
    const msg: ChatMessageType = {
      id: "a1",
      role: "assistant",
      summary: "The planner aborted.",
      time: "10:42",
    };
    render(<ChatMessage msg={msg} />);
    expect(screen.getByText("DataPilot")).toBeInTheDocument();
    expect(screen.getByText(/10:42/)).toBeInTheDocument();
  });

  it("renders the assistant summary markdown", () => {
    const msg: ChatMessageType = {
      id: "a2",
      role: "assistant",
      summary: "The **planner** aborted",
    };
    render(<ChatMessage msg={msg} />);
    // remark renders **planner** as a <strong>
    const strong = screen.getByText("planner");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders nested PlanCard, FindingsCard and CausalChain when present", () => {
    const msg: ChatMessageType = {
      id: "a3",
      role: "assistant",
      plan: [{ label: "Index", done: true, active: false }],
      findings: [{ sev: "critical", text: "Hard stop" }],
      causal: [{ text: "Sensor dropout" }, { text: "Recovery failed" }],
    };
    render(<ChatMessage msg={msg} />);
    expect(screen.getByText("Analysis Plan")).toBeInTheDocument();
    expect(screen.getByText("Key findings")).toBeInTheDocument();
    expect(screen.getByText("Root cause chain")).toBeInTheDocument();
    expect(screen.getByText("Sensor dropout")).toBeInTheDocument();
  });

  it("renders token usage when provided", () => {
    const msg: ChatMessageType = {
      id: "a4",
      role: "assistant",
      summary: "done",
      usage: { tokens_in: 1234, tokens_out: 567, est_cost_usd: 0.0123 },
    };
    render(<ChatMessage msg={msg} />);
    expect(screen.getByText("In: 1,234")).toBeInTheDocument();
    expect(screen.getByText("Out: 567")).toBeInTheDocument();
    expect(screen.getByText("Cost: $0.0123")).toBeInTheDocument();
  });

  it("renders action buttons and switches the workspace tab on click", async () => {
    const user = userEvent.setup();
    const msg: ChatMessageType = {
      id: "a5",
      role: "assistant",
      summary: "see the map",
      actions: [{ iconName: "Map", label: "Open Map", target: "map" }],
    };
    render(<ChatMessage msg={msg} />);
    const btn = screen.getByRole("button", { name: /Open Map/ });
    await user.click(btn);
    expect(useUIStore.getState().tab).toBe("map");
  });

  it("shows the thinking dots for the streaming last assistant message before content arrives", () => {
    const msg: ChatMessageType = { id: "stream-1", role: "assistant" };
    // Make this the last message in a streaming session.
    useChatStore.setState({ messages: [msg], streaming: true });
    const { container } = render(<ChatMessage msg={msg} />);
    expect(container.querySelector(".chat-thinking")).not.toBeNull();
  });

  it("does not show thinking dots once a summary is present", () => {
    const msg: ChatMessageType = {
      id: "stream-2",
      role: "assistant",
      summary: "answer ready",
    };
    useChatStore.setState({ messages: [msg], streaming: true });
    const { container } = render(<ChatMessage msg={msg} />);
    expect(container.querySelector(".chat-thinking")).toBeNull();
  });

  it("renders an action label even when the icon name is unknown to the Icon map", () => {
    const msg: ChatMessageType = {
      id: "a6",
      role: "assistant",
      summary: "x",
      actions: [{ iconName: "NotARealIcon", label: "Mystery", target: "logs" }],
    };
    render(<ChatMessage msg={msg} />);
    // ActionIcon returns null for unknown names; the label still renders.
    expect(
      screen.getByRole("button", { name: /Mystery/ }),
    ).toBeInTheDocument();
  });
});

describe("ChatMessage accessibility (issue #49)", () => {
  // issue #49 — the assistant action buttons carry visible label text, so they
  // already expose a non-empty accessible name and do NOT need an extra
  // aria-label (which would only duplicate the visible text). This asserts the
  // correct accessible behavior: the name comes from the visible label.
  it("action buttons expose an accessible name from their visible label text", () => {
    const msg: ChatMessageType = {
      id: "a7",
      role: "assistant",
      summary: "x",
      actions: [{ iconName: "Map", label: "Open Map", target: "map" }],
    };
    render(<ChatMessage msg={msg} />);
    const btn = screen.getByRole("button", { name: /Open Map/ });
    // Accessible name is non-empty and sourced from the visible label.
    expect(btn).toHaveAccessibleName(/Open Map/);
    expect(within(btn).getByText("Open Map")).toBeInTheDocument();
  });
});

describe("Claude Code answers", () => {
  const answer: ChatMessageType = {
    id: "a1",
    role: "assistant",
    time: "10:42",
    summary: "Planner aborted.",
    answeredBy: "claude_code",
    verified: true,
    claudeCodeUsage: {
      model: "claude-sonnet-4-5-20250929",
      authMethod: "claude.ai",
      toolCalls: 7,
      estCostUsd: 0.0123,
    },
  };

  it("says the answer came from Claude Code", () => {
    render(<ChatMessage msg={answer} />);
    expect(screen.getByText("answered by Claude Code")).toBeInTheDocument();
    expect(screen.queryByText("DataPilot")).toBeNull();
  });
  it("shows the plan usage line instead of token counts", () => {
    render(<ChatMessage msg={{ ...answer, usage: { tokens_in: 1, tokens_out: 1 } }} />);
    expect(
      screen.getByText("Claude Code · Sonnet · 7 tool calls · counted against your Claude plan"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^In:/)).toBeNull();
  });
  it("shows Claude Code's cost estimate for an API key", () => {
    render(
      <ChatMessage
        msg={{
          ...answer,
          claudeCodeUsage: { model: "claude-opus-4-1", authMethod: "api_key", toolCalls: 1, estCostUsd: 0.0123 },
        }}
      />,
    );
    expect(screen.getByText("Claude Code · Opus · 1 tool call · est. $0.0123")).toBeInTheDocument();
  });
  it("says No verified findings when nothing passed the evidence check", () => {
    render(<ChatMessage msg={{ ...answer, verified: false }} />);
    expect(screen.getByText("No verified findings")).toBeInTheDocument();
  });
  it("lists summary log IDs that aren't in this bag", () => {
    render(<ChatMessage msg={{ ...answer, flaggedLogIds: ["l_999", "other-bag:l_5"] }} />);
    expect(screen.getByText("Not found in this bag: l_999, other-bag:l_5")).toBeInTheDocument();
  });

  describe("next steps", () => {
    const sys = (nextSteps: ChatMessageType["nextSteps"]): ChatMessageType => ({
      id: "e1",
      role: "system",
      text: "Your Claude plan's usage limit is reached. Your question is saved.",
      nextSteps,
      retryQuestion: "why?",
    });
    beforeEach(() => {
      useChatStore.setState({ pendingResend: null });
      useUIStore.setState({ screen: "copilot", settingsSectionTarget: null, agentsSectionTarget: null });
    });

    it("offers next steps on a Claude Code error", async () => {
      const setSetting = vi.fn();
      useSettingsStore.setState({ setSetting });
      render(<ChatMessage msg={sys(["use_datapilot", "retry"])} />);
      await userEvent.click(screen.getByRole("button", { name: "Answer with DataPilot's agents" }));
      expect(setSetting).toHaveBeenCalledWith("copilotEngine", "datapilot");
      expect(useChatStore.getState().pendingResend).toBe("why?");
    });
    it("Retry resends the question", async () => {
      render(<ChatMessage msg={sys(["retry"])} />);
      await userEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(useChatStore.getState().pendingResend).toBe("why?");
    });
    it("Open Settings goes to the models section", async () => {
      render(<ChatMessage msg={sys(["open_settings"])} />);
      await userEvent.click(screen.getByRole("button", { name: "Open Settings" }));
      expect(useUIStore.getState().settingsSectionTarget).toBe("models");
      expect(useUIStore.getState().screen).toBe("settings");
    });
    it("Open Agents & MCP goes to the mcp section", async () => {
      render(<ChatMessage msg={sys(["open_agents"])} />);
      await userEvent.click(screen.getByRole("button", { name: "Open Agents & MCP" }));
      expect(useUIStore.getState().agentsSectionTarget).toBe("mcp");
      expect(useUIStore.getState().screen).toBe("agents");
    });
    it("Sign in calls Claude Code sign-in", async () => {
      const signIn = vi.fn().mockResolvedValue(undefined);
      useClaudeCodeStore.setState({ signIn });
      render(<ChatMessage msg={sys(["sign_in"])} />);
      await userEvent.click(screen.getByRole("button", { name: "Sign in with Claude Code" }));
      expect(signIn).toHaveBeenCalled();
    });
  });
});

it("FindingsCard shows each finding's cited log IDs in short form", () => {
  render(
    <FindingsCard findings={[{ sev: "critical", text: "Planner aborted", logIds: ["sess-1:l_5", "sess-1:l_8"] }]} />,
  );
  expect(screen.getByText("l_5 · l_8")).toBeInTheDocument();
});
