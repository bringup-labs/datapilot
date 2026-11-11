import type { JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "@renderer/components/Icon";
import { PlanCard } from "./PlanCard";
import { FindingsCard } from "./FindingsCard";
import { CausalChain } from "./CausalChain";
import { useChatStore } from "@renderer/stores/chat";
import { useUIStore } from "@renderer/stores/ui";
import { useSettingsStore } from "@renderer/stores/settings";
import { useClaudeCodeStore } from "@renderer/stores/claudeCode";
import {
  formatClaudeCodeUsage,
  NEXT_STEP_LABELS,
} from "@renderer/lib/claudeCodeCopy";
import type { ChatMessage as ChatMessageType } from "@shared/types";
import type { ChatNextStep, WorkspaceTab } from "@shared/types";

interface ChatMessageProps {
  msg: ChatMessageType;
}

function ActionIcon({ name }: { name: string }): JSX.Element | null {
  const Comp = Icon[name as keyof typeof Icon] as
    | ((props: { size?: number }) => JSX.Element)
    | undefined;
  if (!Comp) return null;
  return <Comp size={12} />;
}

export function ChatMessage({ msg }: ChatMessageProps): JSX.Element {
  const setTab = useUIStore((s) => s.setTab);
  const claudeCode = msg.answeredBy === "claude_code";

  const runNextStep = (step: ChatNextStep): void => {
    const ui = useUIStore.getState();
    const chat = useChatStore.getState();
    switch (step) {
      case "open_settings":
        ui.setSettingsSectionTarget("models");
        ui.setScreen("settings");
        break;
      case "sign_in":
        void useClaudeCodeStore.getState().signIn();
        break;
      case "use_datapilot":
        void useSettingsStore
          .getState()
          .setSetting("copilotEngine", "datapilot");
        if (msg.retryQuestion) chat.requestResend(msg.retryQuestion);
        break;
      case "retry":
        if (msg.retryQuestion) chat.requestResend(msg.retryQuestion);
        break;
      case "open_agents":
        ui.setAgentsSectionTarget("mcp");
        ui.setScreen("agents");
        break;
    }
  };

  // True only for the last assistant message while the model is streaming —
  // used to show the thinking-dots placeholder until content arrives.
  const isThinking = useChatStore(
    (s) => s.streaming && s.messages[s.messages.length - 1]?.id === msg.id,
  );

  if (msg.role === "user") {
    return (
      <div
        className="row"
        style={{ justifyContent: "flex-end", padding: "6px 14px" }}
      >
        <div
          style={{
            maxWidth: "85%",
            background: "var(--color-chat-user-bg)",
            border: "1px solid var(--color-chat-user-border)",
            color: "var(--color-chat-user-text)",
            borderRadius: "12px 12px 2px 12px",
            padding: "8px 12px",
            fontSize: 12.5,
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
          }}
        >
          {msg.text}
        </div>
      </div>
    );
  }

  if (msg.role === "system") {
    return (
      <div style={{ padding: "4px 14px" }}>
        <div
          className="row gap-2 dim"
          style={{ fontSize: 11.5, padding: "4px 0" }}
        >
          <Icon.Sparkles size={12} />
          <span>{msg.text}</span>
        </div>
        {msg.nextSteps && msg.nextSteps.length > 0 && (
          <div
            className="row gap-2"
            style={{ flexWrap: "wrap", marginBottom: 4 }}
          >
            {msg.nextSteps.map((step) => (
              <button
                key={step}
                className="btn ghost sm"
                onClick={() => runNextStep(step)}
              >
                {NEXT_STEP_LABELS[step]}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // assistant
  return (
    <div style={{ padding: "6px 14px" }}>
      <div className="row gap-2" style={{ marginBottom: 6 }}>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: claudeCode
              ? "var(--color-bg-3)"
              : "linear-gradient(135deg, var(--color-accent), oklch(0.55 0.18 280))",
            display: "grid",
            placeItems: "center",
            color: "var(--color-bg-0)",
            flexShrink: 0,
          }}
        >
          {claudeCode ? (
            <Icon.Terminal size={12} strokeWidth={2} />
          ) : (
            <Icon.Sparkles size={12} strokeWidth={2} />
          )}
        </div>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            color: "var(--color-text-1)",
          }}
        >
          {claudeCode ? "answered by Claude Code" : "DataPilot"}
        </span>
        {msg.time && (
          <span className="dim" style={{ fontSize: 11 }}>
            · {msg.time}
          </span>
        )}
      </div>

      {/* Animated dots — pre-plan: shown until the first plan step arrives */}
      {isThinking && !msg.plan?.length && !msg.summary && (
        <div className="chat-thinking">
          <span />
          <span />
          <span />
        </div>
      )}

      {msg.plan && msg.plan.length > 0 && (
        <PlanCard
          steps={msg.plan}
          isComposing={isThinking && msg.plan.every((s) => s.done)}
        />
      )}

      {/* Animated dots — mid/post-plan: shown while steps execute and until summary arrives */}
      {isThinking && !!msg.plan?.length && !msg.summary && (
        <div className="chat-thinking" style={{ marginTop: 2 }}>
          <span />
          <span />
          <span />
        </div>
      )}

      {msg.summary && (
        <div className="chat-md" style={{ marginBottom: 8 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {msg.summary}
          </ReactMarkdown>
        </div>
      )}

      {msg.flaggedLogIds && msg.flaggedLogIds.length > 0 && (
        <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
          {`Not found in this bag: ${msg.flaggedLogIds.join(", ")}`}
        </div>
      )}
      {msg.verified === false && (
        <div
          style={{ fontSize: 11, marginBottom: 6, color: "var(--color-warn)" }}
        >
          No verified findings
        </div>
      )}

      {msg.findings && <FindingsCard findings={msg.findings} />}
      {msg.causal && <CausalChain items={msg.causal} />}

      {msg.claudeCodeUsage && (
        <div
          className="row gap-2 dim"
          style={{
            fontSize: 10,
            marginTop: 6,
            fontFamily: "var(--font-mono, monospace)",
            opacity: 0.85,
          }}
        >
          <Icon.Activity size={10} />
          <span>{formatClaudeCodeUsage(msg.claudeCodeUsage)}</span>
        </div>
      )}

      {msg.role === "assistant" && msg.usage && !msg.claudeCodeUsage && (
        <div
          className="row gap-2 dim"
          style={{
            fontSize: 10,
            marginTop: 6,
            fontFamily: "var(--font-mono, monospace)",
            opacity: 0.85,
          }}
        >
          <Icon.Activity size={10} />
          <span>In: {msg.usage.tokens_in.toLocaleString()}</span>
          <span>·</span>
          <span>Out: {msg.usage.tokens_out.toLocaleString()}</span>
          {msg.usage.est_cost_usd !== undefined &&
            msg.usage.est_cost_usd > 0 && (
              <>
                <span>·</span>
                <span>Cost: ${msg.usage.est_cost_usd.toFixed(4)}</span>
              </>
            )}
        </div>
      )}

      {msg.actions && msg.actions.length > 0 && (
        <div className="row gap-2" style={{ flexWrap: "wrap", marginTop: 6 }}>
          {msg.actions.map((a, i) => (
            <button
              key={i}
              className="btn sm"
              onClick={() => setTab(a.target as WorkspaceTab)}
            >
              <ActionIcon name={a.iconName} />
              {a.label}
              <Icon.ArrowRight size={11} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
