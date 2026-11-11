import { useEffect, useState, type JSX } from "react";
import { Icon } from "@renderer/components/Icon";
import { billingLabel, modelDisplayName } from "@renderer/lib/claudeCodeCopy";
import { providerDisplayName } from "@renderer/lib/providers";
import { useClaudeCodeStore } from "@renderer/stores/claudeCode";
import { useSettingsStore } from "@renderer/stores/settings";
import { useUIStore } from "@renderer/stores/ui";

const ellipsis = {
  display: "block",
  maxWidth: "100%",
  overflow: "hidden",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
} as const;

const itemStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "8px 12px",
  background: "transparent",
  border: "none",
  textAlign: "left",
  cursor: "pointer",
  color: "var(--color-text-0)",
} as const;

export function EngineMenu(): JSX.Element {
  const [open, setOpen] = useState(false);
  const defaultProvider = useSettingsStore((s) => s.defaultProvider);
  const defaultModel = useSettingsStore((s) => s.defaultModel);
  const copilotEngine = useSettingsStore((s) => s.copilotEngine);
  const claudeCodeModel = useSettingsStore((s) => s.claudeCodeModel);
  const setSetting = useSettingsStore((s) => s.setSetting);
  const status = useClaudeCodeStore((s) => s.status);
  const refresh = useClaudeCodeStore((s) => s.refresh);
  const setScreen = useUIStore((s) => s.setScreen);
  const setSettingsSectionTarget = useUIStore((s) => s.setSettingsSectionTarget);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const agentsModel =
    (defaultModel || "").trim() || `${defaultProvider} default`;
  const claudeModelName = modelDisplayName(claudeCodeModel);
  const usingClaude = copilotEngine === "claude_code";
  const pillLabel = !usingClaude
    ? agentsModel
    : claudeCodeModel === ""
      ? "Claude Code"
      : `Claude Code · ${claudeModelName}`;

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next && status === null) void refresh();
  };

  const chooseAgents = (): void => {
    setSetting("copilotEngine", "datapilot");
    setOpen(false);
  };

  const chooseClaude = (): void => {
    if (status?.ready) {
      setSetting("copilotEngine", "claude_code");
    } else {
      setSettingsSectionTarget("models");
      setScreen("settings");
    }
    setOpen(false);
  };

  const claudeSub =
    status === null
      ? "Checking…"
      : status.auth && status.ready
        ? `${claudeModelName} · ${billingLabel(status.auth.method)}`
        : "";

  return (
    <>
      <button
        type="button"
        className="pill sm ghost mono"
        style={{ maxWidth: 170, minWidth: 0, cursor: "pointer" }}
        title={pillLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <span style={ellipsis}>{pillLabel}</span>
        <Icon.ChevronDown size={10} />
      </button>
      {open && (
        <>
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 99,
            }}
            onClick={() => setOpen(false)}
          />
          <div
            className="card"
            role="menu"
            aria-label="Answer with"
            style={{
              position: "absolute",
              top: 40,
              left: 14,
              width: 300,
              zIndex: 100,
              boxShadow: "var(--shadow-lg)",
              background: "var(--color-bg-2)",
              borderColor: "var(--color-border-2)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "8px 12px",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--color-text-2)",
                borderBottom: "1px solid var(--color-border-1)",
              }}
            >
              Answer with
            </div>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!usingClaude}
              style={itemStyle}
              onClick={chooseAgents}
            >
              <span className="col" style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>
                  DataPilot's agents
                </span>
                <span
                  style={{ fontSize: 10.5, color: "var(--color-text-2)", ...ellipsis }}
                >
                  {`${providerDisplayName(defaultProvider)} · ${agentsModel}`}
                </span>
              </span>
              {!usingClaude && <Icon.Check size={12} />}
            </button>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={usingClaude}
              style={itemStyle}
              onClick={chooseClaude}
            >
              <span className="col" style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>Claude Code</span>
                {claudeSub && (
                  <span
                    style={{ fontSize: 10.5, color: "var(--color-text-2)", ...ellipsis }}
                  >
                    {claudeSub}
                  </span>
                )}
              </span>
              {status !== null && !status.ready && (
                <span style={{ fontSize: 11, color: "var(--color-text-2)" }}>
                  Set up
                </span>
              )}
              {usingClaude && <Icon.Check size={12} />}
            </button>
          </div>
        </>
      )}
    </>
  );
}
