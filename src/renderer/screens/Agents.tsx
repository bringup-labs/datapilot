import { useState, useEffect, type JSX } from "react";
import { Icon } from "@renderer/components/Icon";
import { Toggle } from "@renderer/components/ui";
import { useSettingsStore } from "@renderer/stores/settings";
import { useUIStore } from "@renderer/stores/ui";
import { ClaudeCodeToolsRow } from "./agents/ClaudeCodeToolsRow";
import {
  fetchAgentModels,
  setAgentModel,
  deleteAgentModel,
} from "@renderer/services/api";

// ---------------------------------------------------------------------------
// Data — static in Phase 9; no Zustand store needed
// ---------------------------------------------------------------------------

interface AgentDef {
  id: string;
  specialistId: string;
  name: string;
  desc: string;
  iconName: keyof typeof Icon;
  color: string;
  enabled: boolean;
  model: string;
  calls: number;
}

interface MCPDef {
  id: string;
  name: string;
  url: string;
  tools: number;
  transport: string;
  status: "connected" | "disabled" | "error";
  desc: string;
}

const INITIAL_AGENTS: AgentDef[] = [
  {
    id: "rca",
    specialistId: "RootCauseAnalyst",
    name: "Root Cause Analyst",
    desc: 'Traces failure chains across topics, logs, and TF events. Best for "why did X happen" questions.',
    iconName: "Sparkles",
    color: "var(--color-accent)",
    enabled: true,
    model: "default",
    calls: 142,
  },
  {
    id: "anomaly",
    specialistId: "AnomalyDetector",
    name: "Anomaly Detector",
    desc: "Continuously scans sensor streams for statistical outliers and known fault signatures.",
    iconName: "Activity",
    color: "var(--color-warn)",
    enabled: true,
    model: "default",
    calls: 1284,
  },
  {
    id: "perf",
    specialistId: "PerformanceProfiler",
    name: "Performance Profiler",
    desc: "Tracks node-level CPU/RAM/topic-rate regressions across runs and releases.",
    iconName: "Cpu",
    color: "oklch(0.70 0.18 330)",
    enabled: true,
    model: "default",
    calls: 38,
  },
  {
    id: "replay",
    specialistId: "ReplayNarrator",
    name: "Replay Narrator",
    desc: "Generates step-by-step natural-language commentary while a session is replayed.",
    iconName: "Play",
    color: "var(--color-ok)",
    enabled: false,
    model: "default",
    calls: 12,
  },
  {
    id: "safety",
    specialistId: "SafetyAuditor",
    name: "Safety Auditor",
    desc: "Flags ISO 26262 / 21448 contraventions in command and recovery histories.",
    iconName: "Alert",
    color: "var(--color-danger)",
    enabled: false,
    model: "default",
    calls: 0,
  },
  {
    id: "compare",
    specialistId: "ReleaseComparator",
    name: "Release Comparator",
    desc: "Diffs metric distributions between any two bag sets or fleet windows.",
    iconName: "Layers",
    color: "var(--color-accent)",
    enabled: true,
    model: "default",
    calls: 56,
  },
];

const INITIAL_MCP: MCPDef[] = [
  {
    id: "ros",
    name: "ROS Bridge",
    url: "ws://localhost:9090/rosbridge",
    tools: 14,
    transport: "WS",
    status: "connected",
    desc: "Live ROS2 topic/service/action introspection",
  },
  {
    id: "foxglove",
    name: "Foxglove Cloud",
    url: "https://api.foxglove.dev/mcp",
    tools: 8,
    transport: "HTTP",
    status: "connected",
    desc: "Recording library + visualization layouts",
  },
  {
    id: "s3",
    name: "Rosbag S3",
    url: "s3://datapilot-rosbags/",
    tools: 4,
    transport: "STDIO",
    status: "connected",
    desc: "Read/write bag archives, signed URLs",
  },
  {
    id: "gitea",
    name: "Git (self-host)",
    url: "https://git.internal/api/mcp",
    tools: 11,
    transport: "HTTP",
    status: "connected",
    desc: "Repo, PR, issue context for release diffs",
  },
  {
    id: "jira",
    name: "Linear",
    url: "mcp://linear",
    tools: 6,
    transport: "STDIO",
    status: "disabled",
    desc: "File bugs from incidents",
  },
  {
    id: "slack",
    name: "Slack",
    url: "https://slack.com/mcp",
    tools: 3,
    transport: "HTTP",
    status: "error",
    desc: "Post incident summaries to ops channel",
  },
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: MCPDef["status"] }): JSX.Element {
  const map: Record<MCPDef["status"], { cls: string; label: string }> = {
    connected: { cls: "ok", label: "connected" },
    disabled: { cls: "ghost", label: "disabled" },
    error: { cls: "danger", label: "error" },
  };
  const s = map[status];
  return (
    <span className={`pill sm ${s.cls}`}>
      <span className="swatch" />
      {s.label}
    </span>
  );
}

function AgentCard({
  a,
  overrideModel,
  defaultModel,
  onToggle,
  onSaveModel,
  onResetModel,
}: {
  a: AgentDef;
  overrideModel: string | null;
  defaultModel: string;
  onToggle: (id: string, v: boolean) => void;
  onSaveModel: (specialistId: string, modelId: string) => Promise<void>;
  onResetModel: (specialistId: string) => Promise<void>;
}): JSX.Element {
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [modelInput, setModelInput] = useState("");
  const [saving, setSaving] = useState(false);

  const effectiveModel = overrideModel || defaultModel || "gemini-3.1-flash-lite";
  const Comp = Icon[a.iconName] as
    | ((props: { size?: number }) => JSX.Element)
    | undefined;

  function handleOpenConfig() {
    setModelInput(overrideModel || defaultModel || "");
    setIsConfiguring(true);
  }

  async function handleSave() {
    if (!modelInput.trim()) return;
    setSaving(true);
    try {
      await onSaveModel(a.specialistId, modelInput.trim());
      setIsConfiguring(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    try {
      await onResetModel(a.specialistId);
      setIsConfiguring(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="card"
      style={{
        padding: 16,
        opacity: a.enabled ? 1 : 0.7,
        transition: "opacity 0.15s",
      }}
    >
      <div className="row gap-3" style={{ marginBottom: 10 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: "var(--color-bg-3)",
            color: a.color,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          {Comp ? <Comp size={18} /> : null}
        </div>
        <div className="flex1" style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--color-text-0)",
            }}
          >
            {a.name}
          </div>
          <div className="mono dim" style={{ fontSize: 10.5, marginTop: 2 }}>
            {effectiveModel}
            {overrideModel && (
              <span className="pill sm ok" style={{ marginLeft: 6, fontSize: 9 }}>
                overridden
              </span>
            )}
          </div>
        </div>
        <Toggle
          on={a.enabled}
          onChange={(v) => onToggle(a.id, v)}
          label={`${a.name} enabled`}
        />
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--color-text-2)",
          lineHeight: 1.5,
          marginBottom: 12,
        }}
      >
        {a.desc}
      </div>
      <div className="row gap-2">
        <span className="pill sm ghost mono">
          {a.calls.toLocaleString()} calls · 7d
        </span>
        <div className="flex1" />
        <button
          className="btn ghost sm"
          onClick={handleOpenConfig}
        >
          <Icon.Settings size={11} />
          Config
        </button>
      </div>

      {/* Inline model config panel */}
      {isConfiguring && (
        <div
          style={{
            marginTop: 12,
            padding: "12px",
            background: "var(--color-bg-1)",
            borderRadius: 6,
            border: "1px solid var(--color-border-1)",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--color-text-2)",
              marginBottom: 8,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Model override
          </div>
          <div className="input" style={{ marginBottom: 8 }}>
            <input
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
              placeholder={`default (${defaultModel})`}
              style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") setIsConfiguring(false);
              }}
              autoFocus
            />
          </div>
          <div className="row gap-2">
            <button
              className="btn ghost sm"
              onClick={handleReset}
              disabled={saving || !overrideModel}
              title="Remove override and use default model"
            >
              Reset to default
            </button>
            <div className="flex1" />
            <button
              className="btn ghost sm"
              onClick={() => setIsConfiguring(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="btn primary sm"
              onClick={handleSave}
              disabled={saving || !modelInput.trim()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MCPRow({
  m,
  onToggle,
}: {
  m: MCPDef;
  onToggle: (id: string, v: boolean) => void;
}): JSX.Element {
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
            {m.name}
          </span>
          <StatusPill status={m.status} />
          <span className="pill sm ghost mono">{m.transport}</span>
          <span className="pill sm ghost">{m.tools} tools</span>
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
          {m.url}
        </div>
        <div
          style={{ fontSize: 11.5, color: "var(--color-text-2)", marginTop: 4 }}
        >
          {m.desc}
        </div>
      </div>
      <div className="row gap-1" style={{ flexShrink: 0 }}>
        <button className="btn ghost icon sm">
          <Icon.Refresh size={12} />
        </button>
        <button className="btn ghost sm">Edit</button>
        <Toggle
          on={m.status === "connected"}
          onChange={(v) => onToggle(m.id, v)}
          label={`${m.name} enabled`}
        />
      </div>
    </div>
  );
}

function AddMCPForm({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div className="card" style={{ margin: "0 0 18px", padding: 18 }}>
      <div className="row gap-2" style={{ marginBottom: 12 }}>
        <Icon.Plus size={14} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--color-text-0)",
          }}
        >
          Add MCP server
        </span>
        <div className="flex1" />
        <button className="btn ghost icon sm" onClick={onClose}>
          <Icon.X size={12} />
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <FieldInput label="Name" placeholder="e.g. Internal RAG" />
        <FieldSelect
          label="Transport"
          options={["STDIO", "HTTP", "WebSocket"]}
        />
        <div style={{ gridColumn: "1 / 3" }}>
          <FieldInput
            label="URL / Command"
            placeholder="https://… or npx -y @scope/mcp-server"
            mono
          />
        </div>
        <div style={{ gridColumn: "1 / 3" }}>
          <FieldInput
            label="Authentication"
            placeholder="Bearer / Header / None"
          />
        </div>
      </div>
      <div className="row gap-2" style={{ marginTop: 14 }}>
        <button className="btn ghost sm">Test connection</button>
        <div className="flex1" />
        <button className="btn ghost sm" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary sm">
          <Icon.Check size={12} />
          Add server
        </button>
      </div>
    </div>
  );
}

/** Minimal field helpers used only inside AddMCPForm */
function FieldInput({
  label,
  placeholder,
  mono,
}: {
  label: string;
  placeholder?: string;
  mono?: boolean;
}): JSX.Element {
  return (
    <div className="col" style={{ gap: 6 }}>
      <label
        style={{
          fontSize: 11.5,
          fontWeight: 500,
          color: "var(--color-text-2)",
        }}
      >
        {label}
      </label>
      <div className="input" style={{ height: 32 }}>
        <input
          placeholder={placeholder}
          style={{
            fontFamily: mono ? "var(--font-mono)" : "inherit",
            fontSize: mono ? 12 : 13,
          }}
        />
      </div>
    </div>
  );
}

function FieldSelect({
  label,
  options,
}: {
  label: string;
  options: string[];
}): JSX.Element {
  return (
    <div className="col" style={{ gap: 6 }}>
      <label
        style={{
          fontSize: 11.5,
          fontWeight: 500,
          color: "var(--color-text-2)",
        }}
      >
        {label}
      </label>
      <div className="input" style={{ height: 32 }}>
        <select
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--color-text-1)",
            font: "inherit",
          }}
        >
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

const ROUTING_OPTIONS = [
  {
    key: "auto",
    label: "Auto-route",
    desc: "Coordinator picks the best agent per turn",
  },
  {
    key: "parallel",
    label: "Parallel",
    desc: "All agents run, results merged & ranked",
  },
  {
    key: "manual",
    label: "Manual",
    desc: "You pick the agent in each message",
  },
] as const;

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function Agents(): JSX.Element {
  const [agents, setAgents] = useState<AgentDef[]>(INITIAL_AGENTS);
  const [mcps, setMcps] = useState<MCPDef[]>(INITIAL_MCP);
  const [showAdd, setShowAdd] = useState(false);
  const agentsSectionTarget = useUIStore((s) => s.agentsSectionTarget);
  const setAgentsSectionTarget = useUIStore((s) => s.setAgentsSectionTarget);
  const [section, setSection] = useState<"agents" | "mcp">(
    agentsSectionTarget ?? "agents",
  );
  const [routing, setRouting] = useState<"auto" | "parallel" | "manual">(
    "auto",
  );
  const [agentOverrides, setAgentOverrides] = useState<Record<string, string>>({});
  const defaultModel = useSettingsStore((s) => s.defaultModel);

  useEffect(() => {
    if (!agentsSectionTarget) return;
    setSection(agentsSectionTarget);
    setAgentsSectionTarget(null);
  }, [agentsSectionTarget, setAgentsSectionTarget]);

  useEffect(() => {
    fetchAgentModels()
      .then(setAgentOverrides)
      .catch(() => {});
  }, []);

  const enabledAgents = agents.filter((a) => a.enabled).length;
  const connectedMcps = mcps.filter((m) => m.status === "connected").length;

  const handleAgentToggle = (id: string, v: boolean) =>
    setAgents((prev) =>
      prev.map((a) => (a.id === id ? { ...a, enabled: v } : a)),
    );

  const handleMCPToggle = (id: string, v: boolean) =>
    setMcps((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, status: v ? "connected" : "disabled" } : m,
      ),
    );

  const handleSaveModel = async (specialistId: string, modelId: string) => {
    await setAgentModel(specialistId, modelId);
    setAgentOverrides((prev) => ({ ...prev, [specialistId]: modelId }));
  };

  const handleResetModel = async (specialistId: string) => {
    await deleteAgentModel(specialistId);
    setAgentOverrides((prev) => {
      const next = { ...prev };
      delete next[specialistId];
      return next;
    });
  };

  return (
    <div
      className="col flex1"
      style={{ minHeight: 0, minWidth: 0, background: "var(--color-bg-0)" }}
    >
      {/* Header */}
      <div
        className="row gap-3"
        style={{
          padding: "14px 18px",
          borderBottom: "1px solid var(--color-border-1)",
          flexShrink: 0,
        }}
      >
        <div className="col">
          <div className="row gap-2">
            <h2
              style={{
                margin: 0,
                fontSize: 16,
                fontWeight: 600,
                color: "var(--color-text-0)",
              }}
            >
              Agents & MCP
            </h2>
            <span className="pill sm ghost mono">
              {enabledAgents}/{agents.length} agents · {connectedMcps}/
              {mcps.length} MCP
            </span>
          </div>
          <span className="dim" style={{ fontSize: 11.5, marginTop: 2 }}>
            Compose your copilot — toggle specialist agents and external tool
            servers.
          </span>
        </div>
        <div className="flex1" />
        {/* Segment control */}
        <div
          className="row gap-1"
          style={{
            background: "var(--color-bg-1)",
            border: "1px solid var(--color-border-1)",
            borderRadius: 7,
            padding: 3,
          }}
        >
          <button
            className={`btn sm ${section === "agents" ? "" : "ghost"}`}
            style={{ height: 24 }}
            onClick={() => setSection("agents")}
          >
            <Icon.Bot size={12} />
            Agents
          </button>
          <button
            className={`btn sm ${section === "mcp" ? "" : "ghost"}`}
            style={{ height: 24 }}
            onClick={() => setSection("mcp")}
          >
            <Icon.Plug size={12} />
            MCP Servers
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex1" style={{ overflowY: "auto" }}>
        {section === "agents" && (
          <div style={{ padding: 18 }}>
            {/* Agents grid */}
            <div className="row gap-2" style={{ marginBottom: 14 }}>
              <span className="section-h">Built-in agents</span>
              <div className="flex1" />
              <button className="btn ghost sm">
                <Icon.Plus size={12} />
                Create custom agent
              </button>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
                gap: 12,
              }}
            >
              {agents.map((a) => (
                <AgentCard
                  key={a.id}
                  a={a}
                  overrideModel={agentOverrides[a.specialistId] ?? null}
                  defaultModel={defaultModel}
                  onToggle={handleAgentToggle}
                  onSaveModel={handleSaveModel}
                  onResetModel={handleResetModel}
                />
              ))}
            </div>

            {/* Routing strategy */}
            <div className="card" style={{ marginTop: 22, padding: 16 }}>
              <div className="row gap-2" style={{ marginBottom: 10 }}>
                <Icon.Sparkles size={14} />
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--color-text-0)",
                  }}
                >
                  Routing strategy
                </span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--color-text-2)",
                  lineHeight: 1.5,
                  marginBottom: 12,
                }}
              >
                How DataPilot orchestrates the enabled agents when you ask a
                question.
              </div>
              <div className="row gap-2">
                {ROUTING_OPTIONS.map(({ key, label, desc }) => (
                  <label
                    key={key}
                    className="card"
                    style={{
                      flex: 1,
                      padding: "10px 12px",
                      cursor: "pointer",
                      borderColor:
                        routing === key
                          ? "var(--color-accent)"
                          : "var(--color-border-1)",
                      background:
                        routing === key
                          ? "var(--color-accent-bg)"
                          : "var(--color-bg-2)",
                    }}
                  >
                    <div className="row gap-2" style={{ marginBottom: 4 }}>
                      <input
                        type="radio"
                        name="route"
                        checked={routing === key}
                        onChange={() => setRouting(key)}
                      />
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 600,
                          color: "var(--color-text-0)",
                        }}
                      >
                        {label}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--color-text-2)" }}>
                      {desc}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {section === "mcp" && (
          <div style={{ padding: 18 }}>
            {/* MCP header */}
            <div className="row gap-2" style={{ marginBottom: 14 }}>
              <span className="section-h">Connected servers</span>
              <span className="dim mono" style={{ fontSize: 11 }}>
                · tools surface to all enabled agents
              </span>
              <div className="flex1" />
              <button className="btn ghost sm">
                <Icon.Globe size={12} />
                Marketplace
              </button>
              <button
                className="btn primary sm"
                onClick={() => setShowAdd(true)}
              >
                <Icon.Plus size={12} />
                Add MCP server
              </button>
            </div>

            {/* MCP list */}
            <div
              className="panel"
              style={{ overflow: "hidden", marginBottom: 18 }}
            >
              <ClaudeCodeToolsRow />
              {mcps.map((m) => (
                <MCPRow key={m.id} m={m} onToggle={handleMCPToggle} />
              ))}
            </div>

            {/* Inline add form */}
            {showAdd && <AddMCPForm onClose={() => setShowAdd(false)} />}

            {/* Audit log info */}
            <div className="card" style={{ padding: 14 }}>
              <div className="row gap-2">
                <Icon.Alert size={13} />
                <span style={{ fontSize: 12, color: "var(--color-text-1)" }}>
                  MCP servers run locally on your machine. Outgoing tool calls
                  show in{" "}
                  <span
                    className="mono"
                    style={{ color: "var(--color-accent)" }}
                  >
                    ~/.datapilot/audit.log
                  </span>
                  .
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
