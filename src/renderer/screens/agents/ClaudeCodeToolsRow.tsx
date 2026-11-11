import { useEffect, type JSX } from "react";
import { Icon } from "@renderer/components/Icon";
import { useClaudeCodeStore } from "@renderer/stores/claudeCode";

const ENDPOINT_URL = "http://localhost:8000/mcp";

// A read-only troubleshooting row for the backend's token-protected /mcp
// endpoint that the user's Claude Code uses. It lives outside the editable
// MCP list, so it has no toggle and no edit button.
export function ClaudeCodeToolsRow(): JSX.Element {
  const status = useClaudeCodeStore((s) => s.status);
  const checking = useClaudeCodeStore((s) => s.checking);
  const refresh = useClaudeCodeStore((s) => s.refresh);

  useEffect(() => {
    if (status === null) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- check once on mount
  }, []);

  const tools = status?.tools ?? null;
  // No count and no list while checking or unreachable: there is nothing to name.
  const names = tools?.names ?? [];
  const pill =
    tools === null
      ? { cls: "ghost", label: "checking" }
      : tools.reachable
        ? { cls: "ok", label: "connected" }
        : { cls: "danger", label: "unreachable" };

  return (
    <div
      className="row gap-3"
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--color-border-1)",
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          background: "var(--color-bg-3)",
          color: "var(--color-accent)",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
        }}
      >
        <Icon.Plug size={15} />
      </div>
      <div className="flex1" style={{ minWidth: 0 }}>
        <div className="row gap-2" style={{ flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--color-text-0)",
            }}
          >
            DataPilot tools for Claude Code
          </span>
          <span className={`pill sm ${pill.cls}`}>
            <span className="swatch" />
            {pill.label}
          </span>
          <span className="pill sm ghost mono">http</span>
          {names.length > 0 && (
            <span className="pill sm ghost">{names.length} tools</span>
          )}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--color-text-3)",
            marginTop: 3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {ENDPOINT_URL}
        </div>
        <div
          style={{ fontSize: 11.5, color: "var(--color-text-2)", marginTop: 4 }}
        >
          Read-only, for troubleshooting.
          {names.length > 0 && ` Tools: ${names.join(", ")}`}
        </div>
      </div>
      <div className="row gap-1" style={{ flexShrink: 0 }}>
        <button
          className="btn ghost icon sm"
          aria-label="Check again"
          disabled={checking}
          onClick={() => void refresh()}
        >
          <Icon.Refresh size={12} />
        </button>
      </div>
    </div>
  );
}
