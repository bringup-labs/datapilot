import type { JSX } from "react";
import { Icon } from "@renderer/components/Icon";
import { providerDisplayName } from "@renderer/lib/providers";
import { useSettingsStore } from "@renderer/stores/settings";
import { useUIStore } from "@renderer/stores/ui";

const buttonStyle = {
  background: "transparent",
  color: "var(--color-warn-text)",
  border: "1px solid var(--color-warn-border)",
  borderRadius: "6px",
  fontSize: 10.5,
  padding: "3px 8px",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontWeight: 600,
} as const;

export function ConnectBanner(): JSX.Element {
  const copilotEngine = useSettingsStore((s) => s.copilotEngine);
  const defaultProvider = useSettingsStore((s) => s.defaultProvider);
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const setScreen = useUIStore((s) => s.setScreen);
  const setSettingsSectionTarget = useUIStore((s) => s.setSettingsSectionTarget);

  const visible =
    copilotEngine === "datapilot" &&
    defaultProvider !== "ollama" &&
    !apiKeys[defaultProvider];
  if (!visible) return <></>;

  const openModels = (): void => {
    setSettingsSectionTarget("models");
    setScreen("settings");
  };

  return (
    <div
      style={{
        margin: "12px 14px 4px 14px",
        padding: "12px",
        borderRadius: "8px",
        background: "var(--color-warn-bg)",
        border: "1px solid var(--color-warn-border)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxShadow: "var(--shadow-sm)",
        animation: "fadeIn 0.3s ease-out",
        flexShrink: 0,
      }}
    >
      <div className="row gap-2" style={{ alignItems: "flex-start" }}>
        <div
          style={{ color: "var(--color-warn-text)", marginTop: 2, flexShrink: 0 }}
        >
          <Icon.Sparkles size={16} />
        </div>
        <div className="col gap-1" style={{ flex: 1, minWidth: 0 }}>
          <span
            style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-0)" }}
          >
            Connect an AI model
          </span>
          <span
            style={{ fontSize: 11, color: "var(--color-text-2)", lineHeight: 1.4 }}
          >
            Answer with Claude Code on this computer, or add an API key for{" "}
            <b>{providerDisplayName(defaultProvider)}</b>.
          </span>
        </div>
      </div>
      <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
        <button className="btn sm" style={buttonStyle} onClick={openModels}>
          Use Claude Code
        </button>
        <button className="btn sm" style={buttonStyle} onClick={openModels}>
          <Icon.Key size={11} />
          Add an API key
        </button>
      </div>
    </div>
  );
}
