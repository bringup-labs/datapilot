import { useState, useEffect, type JSX, type ReactNode } from "react";
import { Icon } from "@renderer/components/Icon";
import { Toggle } from "@renderer/components/ui";
import { useTheme } from "@renderer/hooks/useTheme";
import type { Theme } from "@renderer/hooks/useTheme";
import { useSettingsStore, ACCENT_PRESETS } from "@renderer/stores/settings";
import { useUIStore } from "@renderer/stores/ui";
import * as api from "@renderer/services/api";
import type { StorageUsage } from "@shared/ipc";
import { FieldSelect, SectionCard, Row } from "./settings/parts";
import { ClaudeCodeCard } from "./settings/ClaudeCodeCard";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Provider {
  id: string;
  name: string;
  models: string[];
  keyHint: string;
  endpoint: string;
  color: string;
}

const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    name: "Claude (Anthropic)",
    models: ["claude-opus-4", "claude-sonnet-4.5", "claude-haiku-4.5"],
    keyHint: "sk-ant-…",
    endpoint: "https://api.anthropic.com",
    color: "oklch(0.65 0.14 30)",
  },
  {
    id: "openai",
    name: "OpenAI",
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
    keyHint: "sk-…",
    endpoint: "https://api.openai.com/v1",
    color: "oklch(0.65 0.14 150)",
  },
  {
    id: "google",
    name: "Gemini (Google)",
    models: [
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash (medium thinking)",
      "gemini-3.5-flash (high thinking)",
      "gemini-3.1-pro-preview",
    ],
    keyHint: "AIza…",
    endpoint: "https://generativelanguage.googleapis.com",
    color: "oklch(0.65 0.14 240)",
  },
  {
    id: "ollama",
    name: "Ollama (local)",
    models: ["llama-3.3-70b", "qwen-2.5-coder-32b"],
    keyHint: "— none —",
    endpoint: "http://localhost:11434",
    color: "oklch(0.65 0.14 300)",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    models: [
      "deepseek-ai/deepseek-r1",
      "meta/llama-3.3-70b-instruct",
      "nvidia/llama-3.1-nemotron-70b-instruct",
      "mistralai/mistral-large-2-instruct",
    ],
    keyHint: "nvapi-…",
    endpoint: "https://integrate.api.nvidia.com/v1",
    color: "oklch(0.65 0.18 150)",
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    models: [],
    keyHint: "sk-…",
    endpoint: "https://…",
    color: "oklch(0.65 0.05 240)",
  },
];

const SECTIONS = [
  { id: "general", label: "General", icon: <Icon.Settings size={14} /> },
  { id: "models", label: "Models & API Keys", icon: <Icon.Key size={14} /> },
  { id: "docker", label: "Docker & Runtime", icon: <Icon.Box size={14} /> },
  { id: "storage", label: "Storage & Data", icon: <Icon.Database size={14} /> },
  { id: "shortcuts", label: "Shortcuts", icon: <Icon.Code size={14} /> },
  { id: "about", label: "About", icon: <Icon.Sparkles size={14} /> },
] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const precision = value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIdx]}`;
}

type SectionId = (typeof SECTIONS)[number]["id"];

// ---------------------------------------------------------------------------
// Shared field primitives
// ---------------------------------------------------------------------------

interface FieldInputProps {
  label?: string;
  placeholder?: string;
  value?: string;
  mono?: boolean;
  type?: string;
  onChange?: (v: string) => void;
  hint?: string;
  after?: ReactNode;
}

function FieldInput({
  label,
  placeholder,
  value,
  mono,
  type = "text",
  onChange,
  hint,
  after,
}: FieldInputProps): JSX.Element {
  return (
    <div className="col" style={{ gap: 6 }}>
      {label && (
        <label
          style={{
            fontSize: 11.5,
            fontWeight: 500,
            color: "var(--color-text-2)",
          }}
        >
          {label}
        </label>
      )}
      <div className="input" style={{ height: 32 }}>
        <input
          type={type}
          placeholder={placeholder}
          value={onChange ? value : undefined}
          defaultValue={!onChange ? value : undefined}
          onChange={onChange ? (e) => onChange(e.target.value) : undefined}
          style={{
            fontFamily: mono ? "var(--font-mono)" : "inherit",
            fontSize: mono ? 12 : 13,
          }}
        />
        {after}
      </div>
      {hint && (
        <span className="dim" style={{ fontSize: 11 }}>
          {hint}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KeyInput — API key card with reveal/copy
// ---------------------------------------------------------------------------

function KeyInput({
  provider,
  value,
  onChange,
  isDefault,
  onSetDefault,
  status,
  defaultModel,
  onModelChange,
  customEndpoint,
  onEndpointChange,
  onRefreshModels,
}: {
  provider: Provider;
  value: string;
  onChange: (v: string) => void;
  isDefault: boolean;
  onSetDefault: () => void;
  status: "connected" | "not_set" | "error";
  defaultModel?: string;
  onModelChange?: (v: string) => void;
  customEndpoint?: string;
  onEndpointChange?: (v: string) => void;
  onRefreshModels?: (models: string[]) => void;
}): JSX.Element {
  const [reveal, setReveal] = useState(false);
  const [localStatus, setLocalStatus] = useState<
    "idle" | "testing" | "success" | "error"
  >(status === "connected" ? "success" : status === "error" ? "error" : "idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setLocalStatus(
      status === "connected"
        ? "success"
        : status === "error"
          ? "error"
          : "idle",
    );
    setErrorMsg(null);
  }, [status, value]);

  const handleTest = async () => {
    if (!value && provider.id !== "ollama") {
      alert(
        `Cannot test connection: No API key configured for ${provider.name}.`,
      );
      return;
    }
    setLocalStatus("testing");
    setErrorMsg(null);
    try {
      const endpoint =
        provider.id === "custom" ? customEndpoint : provider.endpoint;
      await api.testApiKey(provider.id, value, endpoint);
      setLocalStatus("success");
      void handleRefresh();
    } catch (err: any) {
      setLocalStatus("error");
      setErrorMsg(err.message || "Verification failed");
    }
  };

  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!value && provider.id !== "ollama") {
      alert(
        `Cannot refresh models: No credentials configured for ${provider.name}.`,
      );
      return;
    }
    setRefreshing(true);
    try {
      const endpoint =
        provider.id === "custom" ? customEndpoint : provider.endpoint;
      const fetchedModels = await api.fetchProviderModels(
        provider.id,
        value,
        endpoint,
      );
      if (onRefreshModels) {
        onRefreshModels(fetchedModels);
      }
    } catch (err: any) {
      alert(`Failed to refresh models: ${err.message || err}`);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="card" style={{ padding: 14, marginBottom: 10 }}>
      <div className="row gap-3" style={{ marginBottom: 12 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            background: "var(--color-bg-3)",
            color: provider.color,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          <Icon.Sparkles size={15} />
        </div>
        <div className="flex1">
          <div className="row gap-2">
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--color-text-0)",
              }}
            >
              {provider.name}
            </span>
            {localStatus === "success" && (
              <span className="pill sm ok">
                <span className="swatch" />
                connected
              </span>
            )}
            {localStatus === "idle" && (
              <span className="pill sm ghost">
                {provider.id === "ollama" ? "not tested" : "no key"}
              </span>
            )}
            {localStatus === "testing" && (
              <span className="pill sm ghost">
                <span
                  className="swatch"
                  style={{ animation: "pulse 1s infinite" }}
                />
                testing...
              </span>
            )}
            {localStatus === "error" && (
              <span
                className="pill sm danger"
                title={errorMsg ?? "401 unauthorized"}
              >
                <span className="swatch" />
                {errorMsg ? errorMsg.substring(0, 30) : "401 unauthorized"}
              </span>
            )}
            {isDefault && (
              <span className="pill sm accent">
                <span className="swatch" />
                default
              </span>
            )}
          </div>
          <div className="mono dim" style={{ fontSize: 10.5, marginTop: 2 }}>
            {provider.endpoint}
          </div>
        </div>
        <button
          className="btn ghost sm"
          onClick={onSetDefault}
          disabled={isDefault}
        >
          {isDefault ? "Default" : "Set default"}
        </button>
      </div>

      <div
        style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 10 }}
      >
        <FieldInput
          label="API key"
          mono
          placeholder={provider.keyHint}
          value={value}
          type={reveal ? "text" : "password"}
          onChange={onChange}
          after={
            <div className="row gap-1">
              {/* #39: no clipboard copy — secrets must not leave safeStorage
                  (the system clipboard is readable by other processes). */}
              <button
                className="btn ghost icon sm"
                onClick={() => setReveal((r) => !r)}
                title={reveal ? "Hide" : "Reveal"}
                aria-label={reveal ? "Hide API key" : "Reveal API key"}
                style={{ height: 22, width: 22 }}
              >
                {reveal ? <Icon.EyeOff size={12} /> : <Icon.Eye size={12} />}
              </button>
            </div>
          }
        />
        {provider.models.length > 0 ? (
          <FieldSelect
            label="Default model"
            options={provider.models}
            value={defaultModel}
            onChange={onModelChange}
          />
        ) : (
          <FieldInput
            label="Custom endpoint"
            mono
            placeholder="https://api.example.com/v1"
            value={customEndpoint}
            onChange={onEndpointChange}
          />
        )}
      </div>

      <div className="row gap-2" style={{ marginTop: 10 }}>
        <button
          className="btn ghost sm"
          onClick={handleTest}
          disabled={localStatus === "testing"}
        >
          <Icon.Refresh
            size={11}
            className={localStatus === "testing" ? "spin" : ""}
          />
          {localStatus === "testing" ? "Testing..." : "Test"}
        </button>
        {provider.id !== "custom" && (
          <button
            className="btn ghost sm"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <Icon.Download size={11} className={refreshing ? "spin" : ""} />
            {refreshing ? "Refreshing..." : "Refresh models"}
          </button>
        )}
        <div className="flex1" />
        <button
          className="btn ghost sm"
          style={{ color: "var(--color-danger)" }}
          onClick={() => onChange("")}
        >
          <Icon.Trash size={11} />
          Remove
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section views
// ---------------------------------------------------------------------------

function GeneralSection({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: (t: Theme) => void;
}): JSX.Element {
  const {
    accentColor,
    uiDensity,
    monoFreq,
    telemetryUsage,
    telemetryCrash,
    setSetting,
  } = useSettingsStore();

  const handleThemeClick = (key: string) => {
    if (key === "system") {
      const prefersDark = !window.matchMedia?.("(prefers-color-scheme: light)")
        .matches;
      setTheme(prefersDark ? "dark" : "light");
    } else {
      setTheme(key as Theme);
    }
  };

  return (
    <>
      <SectionCard title="Appearance" hint="UI theme and density.">
        <Row
          label="Theme"
          hint="Switch between dark and light. Synced across all windows."
        >
          <div className="row gap-2">
            {(
              [
                ["dark", "Dark", <Icon.Moon size={13} />],
                ["light", "Light", <Icon.Sun size={13} />],
                ["system", "Match system", <Icon.Globe size={13} />],
              ] as [string, string, JSX.Element][]
            ).map(([k, l, icon]) => (
              <button
                key={k}
                className={`btn sm ${theme === k ? "primary" : ""}`}
                onClick={() => handleThemeClick(k)}
              >
                {icon}
                {l}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label="Accent color"
          hint="Used for highlights, links, and the AI-active state."
        >
          <div className="row gap-2" style={{ flexWrap: "wrap" }}>
            {ACCENT_PRESETS.map(({ color, label }) => (
              <button
                key={label}
                className="card"
                onClick={() => setSetting("accentColor", label)}
                style={{
                  padding: "4px 10px 4px 4px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  cursor: "pointer",
                  borderColor:
                    label === accentColor
                      ? "var(--color-accent)"
                      : "var(--color-border-1)",
                }}
              >
                <span
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 4,
                    background: color,
                    display: "block",
                  }}
                />
                <span style={{ fontSize: 11.5 }}>{label}</span>
              </button>
            ))}
          </div>
        </Row>
        <Row label="UI density">
          <div className="row gap-2">
            {["Compact", "Comfortable", "Spacious"].map((d) => (
              <button
                key={d}
                className={`btn sm ${d === uiDensity ? "primary" : ""}`}
                onClick={() => setSetting("uiDensity", d)}
              >
                {d}
              </button>
            ))}
          </div>
        </Row>
        <Row
          label="Show topic frequencies in mono"
          hint="Render Hz / latency / counters in JetBrains Mono."
        >
          <Toggle
            on={monoFreq}
            onChange={(val) => setSetting("monoFreq", val)}
            label="Mono frequencies"
          />
        </Row>
      </SectionCard>

      <SectionCard
        title="Telemetry"
        hint="DataPilot runs entirely on your machine. Nothing leaves unless you turn this on."
      >
        <Row label="Anonymous usage stats">
          <Toggle
            on={telemetryUsage}
            onChange={(val) => setSetting("telemetryUsage", val)}
            label="Anonymous usage stats"
          />
        </Row>
        <Row label="Crash reports">
          <Toggle
            on={telemetryCrash}
            onChange={(val) => setSetting("telemetryCrash", val)}
            label="Crash reports"
          />
        </Row>
      </SectionCard>
    </>
  );
}

function ModelsSection(): JSX.Element {
  const {
    defaultProvider,
    defaultModel,
    embeddingModel,
    apiKeys,
    setSetting,
    setApiKey,
  } = useSettingsStore();

  const [dynamicModels, setDynamicModels] = useState<Record<string, string[]>>(
    {},
  );

  const statusFor = (id: string): "connected" | "not_set" | "error" => {
    if (id === "ollama") return "not_set";
    if (!apiKeys[id]) return "not_set";
    return "connected";
  };

  const activeProvider =
    PROVIDERS.find((p) => p.id === defaultProvider) || PROVIDERS[0];
  const activeProviderModels =
    dynamicModels[activeProvider.id] || activeProvider.models;

  return (
    <>
      <ClaudeCodeCard />
      <SectionCard
        title="Default"
        hint="The model used when no agent overrides it."
      >
        <Row label="Default provider · model">
          <div className="row gap-2">
            <FieldSelect
              label=""
              options={PROVIDERS.map((p) => p.name)}
              value={activeProvider.name}
              onChange={(name) => {
                const prov = PROVIDERS.find((p) => p.name === name);
                if (prov) {
                  setSetting("defaultProvider", prov.id);
                  const provModels = dynamicModels[prov.id] || prov.models;
                  if (provModels.length > 0) {
                    setSetting("defaultModel", provModels[0]);
                  }
                }
              }}
            />
            {activeProviderModels.length > 0 && (
              <FieldSelect
                label=""
                options={activeProviderModels}
                value={defaultModel}
                onChange={(model) => setSetting("defaultModel", model)}
              />
            )}
          </div>
        </Row>
        <Row
          label="Embedding model"
          hint="Used for semantic search across bags."
        >
          <FieldSelect
            label=""
            options={[
              "text-embedding-3-large (OpenAI)",
              "voyage-3 (Anthropic)",
              "nomic-embed-text (local)",
            ]}
            value={embeddingModel}
            onChange={(m) => setSetting("embeddingModel", m)}
          />
        </Row>
      </SectionCard>

      <SectionCard
        title="API keys"
        hint="Stored encrypted in your OS keychain. Never sent to DataPilot servers."
      >
        {PROVIDERS.map((p) => {
          const currentModels = dynamicModels[p.id] || p.models;
          return (
            <KeyInput
              key={p.id}
              provider={{ ...p, models: currentModels }}
              value={apiKeys[p.id] ?? ""}
              isDefault={defaultProvider === p.id}
              onSetDefault={() => {
                setSetting("defaultProvider", p.id);
                if (currentModels.length > 0) {
                  setSetting("defaultModel", currentModels[0]);
                }
              }}
              onChange={(v) => setApiKey(p.id, v)}
              status={statusFor(p.id)}
              defaultModel={defaultModel}
              onModelChange={(m) => setSetting("defaultModel", m)}
              customEndpoint={p.id === "custom" ? defaultModel : undefined}
              onEndpointChange={(v) =>
                p.id === "custom" && setSetting("defaultModel", v)
              }
              onRefreshModels={(fetched) => {
                setDynamicModels((prev) => ({ ...prev, [p.id]: fetched }));
                if (fetched.length > 0 && !fetched.includes(defaultModel)) {
                  setSetting("defaultModel", fetched[0]);
                }
              }}
            />
          );
        })}
        <button
          className="btn ghost sm"
          style={{ marginTop: 4 }}
          onClick={() =>
            alert(
              "Custom providers can be added dynamically in a future update.",
            )
          }
        >
          <Icon.Plus size={11} />
          Add another provider
        </button>
      </SectionCard>
    </>
  );
}

function DockerSection(): JSX.Element {
  const {
    dockerSocket,
    tlsCertPath,
    defaultRosImage,
    gpuPassthrough,
    concurrentWorkers,
    autoTeardownAfter,
    setSetting,
  } = useSettingsStore();

  return (
    <>
      <SectionCard
        title="Docker engine"
        hint="Used to launch ROS containers, replay sims, and bag-conversion workers."
      >
        <Row label="Status" align="flex-start">
          <div className="row gap-2">
            <span className="pill ok">
              <span className="swatch" />
              Daemon reachable
            </span>
            <span className="pill ghost mono">v25.0.6 · local socket</span>
          </div>
        </Row>
        <Row
          label="Docker socket"
          hint="Read-only. The Docker socket is a privileged setting and is no longer editable here (#31); override it with the DATAPILOT_DOCKER_SOCKET environment variable."
        >
          <span className="pill ghost mono">
            <Icon.Plug size={11} />
            {dockerSocket || "platform default"}
          </span>
        </Row>
        <Row
          label="TLS certificate path"
          hint="Only needed for remote engines secured with mTLS."
        >
          <FieldInput
            mono
            placeholder="~/.docker/certs/"
            value={tlsCertPath}
            onChange={(v) => setSetting("tlsCertPath", v)}
          />
        </Row>
        <Row label="Default ROS image">
          <FieldSelect
            label=""
            options={[
              "osrf/ros:humble-desktop",
              "osrf/ros:iron-desktop",
              "osrf/ros:jazzy-desktop",
              "datapilot/ros2-replay:latest",
            ]}
            value={defaultRosImage}
            onChange={(v) => setSetting("defaultRosImage", v)}
          />
        </Row>
        <Row
          label="GPU passthrough"
          hint="Use --gpus all for replay/3D viz workloads when available."
        >
          <Toggle
            on={gpuPassthrough}
            onChange={(v) => setSetting("gpuPassthrough", v)}
            label="GPU passthrough"
          />
        </Row>
      </SectionCard>

      <SectionCard
        title="Worker pool"
        hint="Background containers DataPilot keeps warm."
      >
        <Row label="Concurrent workers">
          <div className="row gap-2" style={{ alignItems: "center" }}>
            <FieldInput
              type="number"
              value={String(concurrentWorkers)}
              onChange={(v) =>
                setSetting("concurrentWorkers", parseInt(v, 10) || 4)
              }
            />
            <span className="dim" style={{ fontSize: 11 }}>
              · limit parallel extraction tasks
            </span>
          </div>
        </Row>
        <Row label="Auto-tear-down idle workers after">
          <FieldSelect
            label=""
            options={["30 seconds", "2 minutes", "10 minutes", "never"]}
            value={autoTeardownAfter}
            onChange={(v) => setSetting("autoTeardownAfter", v)}
          />
        </Row>
      </SectionCard>
    </>
  );
}

function StorageSection(): JSX.Element {
  const { cacheDir, bagArchiveRoot, autoIndexBags, chunkWindow, setSetting } =
    useSettingsStore();

  const [clearing, setClearing] = useState(false);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [cacheUsage, setCacheUsage] = useState<StorageUsage | null>(null);
  const [archiveUsage, setArchiveUsage] = useState<StorageUsage | null>(null);

  const refreshUsage = async () => {
    if (!window.datapilot) return;
    setLoadingUsage(true);
    try {
      const [cache, archive] = await Promise.all([
        window.datapilot.storage.usage(cacheDir),
        window.datapilot.storage.usage(bagArchiveRoot),
      ]);
      setCacheUsage(cache);
      setArchiveUsage(archive);
    } catch (err) {
      console.error("Failed to read storage usage:", err);
    } finally {
      setLoadingUsage(false);
    }
  };

  useEffect(() => {
    void refreshUsage();
  }, [cacheDir, bagArchiveRoot]);

  const handleClearCache = async () => {
    setClearing(true);
    try {
      await api.clearAllSessions();
      await refreshUsage();
    } catch (err: any) {
      alert(`Failed to clear cache: ${err.message || err}`);
    } finally {
      setClearing(false);
    }
  };

  const handleDownloadLlmLogs = () => {
    const link = document.createElement("a");
    link.href = "http://localhost:8000/api/settings/llm-logs";
    link.setAttribute("download", "llm_prompts.jsonl");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <>
      <SectionCard
        title="Local storage"
        hint="DataPilot caches indexed bags here for instant re-load."
      >
        <Row label="Cache directory">
          <FieldInput
            mono
            value={cacheDir}
            onChange={(v) => setSetting("cacheDir", v)}
          />
        </Row>
        <Row
          label="Storage used"
          hint="Live usage from your local filesystem paths."
        >
          <div className="col gap-2" style={{ fontSize: 11.5 }}>
            <div className="row gap-2 mono">
              <span className="dim">Cache:</span>
              <span style={{ color: "var(--color-text-1)" }}>
                {loadingUsage
                  ? "Reading…"
                  : formatBytes(cacheUsage?.totalBytes ?? 0)}
              </span>
              <span className="dim">
                {loadingUsage ? "" : `(${cacheUsage?.fileCount ?? 0} files)`}
              </span>
            </div>
            <div className="row gap-2 mono">
              <span className="dim">Bag archive:</span>
              <span style={{ color: "var(--color-text-1)" }}>
                {loadingUsage
                  ? "Reading…"
                  : formatBytes(archiveUsage?.totalBytes ?? 0)}
              </span>
              <span className="dim">
                {loadingUsage ? "" : `(${archiveUsage?.fileCount ?? 0} files)`}
              </span>
            </div>
            <div className="row gap-2 mono">
              <span className="dim">Total:</span>
              <span style={{ color: "var(--color-text-1)" }}>
                {loadingUsage
                  ? "Reading…"
                  : formatBytes(
                      (cacheUsage?.totalBytes ?? 0) +
                        (archiveUsage?.totalBytes ?? 0),
                    )}
              </span>
            </div>
          </div>
          <div className="row gap-2" style={{ marginTop: 8 }}>
            <button
              className="btn ghost sm"
              onClick={() => void refreshUsage()}
              disabled={loadingUsage || clearing}
            >
              <Icon.Refresh size={11} className={loadingUsage ? "spin" : ""} />
              Refresh
            </button>
            <button
              className="btn ghost sm"
              onClick={handleDownloadLlmLogs}
            >
              <Icon.Download size={11} />
              Download LLM logs
            </button>
            <div className="flex1" />
            <button
              className="btn ghost sm"
              onClick={handleClearCache}
              disabled={clearing}
            >
              <Icon.Trash size={11} className={clearing ? "spin" : ""} />
              {clearing ? "Clearing..." : "Clear sessions"}
            </button>
          </div>
        </Row>
        <Row label="Bag archive root" hint="Where uploaded rosbags are stored.">
          <FieldInput
            mono
            value={bagArchiveRoot}
            onChange={(v) => setSetting("bagArchiveRoot", v)}
          />
        </Row>
      </SectionCard>

      <SectionCard
        title="Indexing"
        hint="Semantic indexing settings for /search."
      >
        <Row label="Auto-index new bags">
          <Toggle
            on={autoIndexBags}
            onChange={(v) => setSetting("autoIndexBags", v)}
            label="Auto-index new bags"
          />
        </Row>
        <Row label="Chunk window">
          <FieldSelect
            label=""
            options={["1 sec", "5 sec", "10 sec", "30 sec"]}
            value={chunkWindow}
            onChange={(v) => setSetting("chunkWindow", v)}
          />
        </Row>
      </SectionCard>
    </>
  );
}

const SHORTCUTS = [
  ["Open semantic search", "⌘ K"],
  ["New chat", "⌘ N"],
  ["Send message", "⌘ ↵"],
  ["Toggle Copilot panel", "⌘ \\"],
  ["Jump to timeline", "⌘ 1"],
  ["Jump to metrics", "⌘ 2"],
  ["Jump to map", "⌘ 3"],
  ["Jump to logs", "⌘ 4"],
  ["Jump to knowledge graph", "⌘ 5"],
  ["Toggle replay", "Space"],
  ["Step ±1 sec", "← →"],
] as const;

function ShortcutsSection(): JSX.Element {
  return (
    <SectionCard
      title="Keyboard shortcuts"
      hint="Coming soon — these shortcuts are not wired up yet."
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "4px 24px",
        }}
      >
        {SHORTCUTS.map(([label, key]) => (
          <div
            key={label}
            className="row"
            style={{
              padding: "8px 0",
              borderTop: "1px solid var(--color-border-1)",
            }}
          >
            <span style={{ fontSize: 12.5, color: "var(--color-text-1)" }}>
              {label}
            </span>
            <div className="flex1" />
            <span
              className="mono"
              style={{
                fontSize: 11,
                padding: "2px 8px",
                border: "1px solid var(--color-border-2)",
                borderRadius: 4,
                color: "var(--color-text-1)",
                background: "var(--color-bg-2)",
              }}
            >
              {key}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function AboutSection(): JSX.Element {
  const [version, setVersion] = useState("0.1.0");
  const { updateChannel, setSetting, resetSettings } = useSettingsStore();

  useEffect(() => {
    if (window.datapilot) {
      window.datapilot.app.version().then(setVersion);
    }
  }, []);

  const handleOpenLogDir = async () => {
    if (!window.datapilot) return;
    const userData = await window.datapilot.app.userDataPath();
    await window.datapilot.shell.openPath(userData);
  };

  const handleReset = async () => {
    if (
      confirm(
        "Are you sure you want to reset all configurations to defaults? This will clear all stored API keys.",
      )
    ) {
      await resetSettings();
      alert("All settings have been successfully reset.");
    }
  };

  return (
    <SectionCard
      title="DataPilot"
      hint="Local-first AI copilot for ROS/ROS2 engineers."
    >
      <Row label="Version">
        <span
          className="mono"
          style={{ fontSize: 12.5, color: "var(--color-text-1)" }}
        >
          {version} (build {__BUILD_DATE__.replace(/-/g, ".")})
        </span>
      </Row>
      <Row label="Update channel">
        <FieldSelect
          label=""
          options={["Stable", "Beta", "Nightly"]}
          value={updateChannel}
          onChange={(v) => setSetting("updateChannel", v)}
        />
      </Row>
      <Row label="License">
        <span className="mono dim" style={{ fontSize: 12 }}>
          Apache 2.0
        </span>
      </Row>
      <Row label="Logs">
        <button className="btn ghost sm" onClick={handleOpenLogDir}>
          <Icon.Terminal size={11} />
          Open log directory
        </button>
      </Row>
      <Row label="Reset">
        <button
          className="btn ghost sm"
          style={{ color: "var(--color-danger)" }}
          onClick={handleReset}
        >
          <Icon.Power size={11} />
          Reset all settings
        </button>
      </Row>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function Settings(): JSX.Element {
  const settingsSectionTarget = useUIStore((s) => s.settingsSectionTarget);
  const setSettingsSectionTarget = useUIStore(
    (s) => s.setSettingsSectionTarget,
  );
  const [section, setSection] = useState<SectionId>(
    settingsSectionTarget ?? "general",
  );
  const { theme, setTheme } = useTheme();
  const loading = useSettingsStore((s) => s.loading);

  useEffect(() => {
    if (!settingsSectionTarget) return;
    setSection(settingsSectionTarget);
    setSettingsSectionTarget(null);
  }, [settingsSectionTarget, setSettingsSectionTarget]);

  const activeLabel = SECTIONS.find((s) => s.id === section)?.label ?? "";

  return (
    <div
      className="flex1"
      style={{
        minHeight: 0,
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        background: "var(--color-bg-0)",
      }}
    >
      {/* Left sidebar */}
      <div
        className="col"
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: "1px solid var(--color-border-1)",
          background: "var(--color-bg-1)",
          padding: "18px 10px",
        }}
      >
        <div className="section-h" style={{ padding: "0 8px 10px" }}>
          Settings
        </div>
        <div className="col gap-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className="row gap-2"
              style={{
                padding: "8px 10px",
                fontSize: 12.5,
                fontWeight: 500,
                color:
                  section === s.id
                    ? "var(--color-text-0)"
                    : "var(--color-text-2)",
                background:
                  section === s.id ? "var(--color-bg-3)" : "transparent",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "inherit",
                position: "relative",
                width: "100%",
              }}
            >
              {/* Active accent bar */}
              {section === s.id && (
                <span
                  style={{
                    position: "absolute",
                    left: -10,
                    top: 8,
                    bottom: 8,
                    width: 2,
                    background: "var(--color-accent)",
                    borderRadius: "0 2px 2px 0",
                  }}
                />
              )}
              {s.icon}
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Right body */}
      <div className="flex1 col" style={{ minWidth: 0 }}>
        {/* Section header */}
        <div
          className="row gap-3"
          style={{
            padding: "14px 22px",
            borderBottom: "1px solid var(--color-border-1)",
            flexShrink: 0,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 600,
              color: "var(--color-text-0)",
            }}
          >
            {activeLabel}
          </h2>
          <div className="flex1" />
          {loading ? (
            <span className="pill sm ghost pulse">
              <Icon.Refresh
                size={11}
                style={{ animation: "spin 1.4s linear infinite" }}
              />
              loading preferences…
            </span>
          ) : (
            <span className="pill sm ok">
              <span className="swatch" />
              all changes saved locally
            </span>
          )}
        </div>

        {/* Scrollable content */}
        <div
          className="flex1"
          style={{ overflowY: "auto", padding: "18px 22px 22px" }}
        >
          {/* Keep all sections mounted so local state (API keys, toggles, etc.)
              survives navigation. Only the active section is visible. */}
          <div
            style={{
              maxWidth: 880,
              display: section === "general" ? "block" : "none",
            }}
          >
            <GeneralSection theme={theme} setTheme={setTheme} />
          </div>
          <div
            style={{
              maxWidth: 880,
              display: section === "models" ? "block" : "none",
            }}
          >
            <ModelsSection />
          </div>
          <div
            style={{
              maxWidth: 880,
              display: section === "docker" ? "block" : "none",
            }}
          >
            <DockerSection />
          </div>
          <div
            style={{
              maxWidth: 880,
              display: section === "storage" ? "block" : "none",
            }}
          >
            <StorageSection />
          </div>
          <div
            style={{
              maxWidth: 880,
              display: section === "shortcuts" ? "block" : "none",
            }}
          >
            <ShortcutsSection />
          </div>
          <div
            style={{
              maxWidth: 880,
              display: section === "about" ? "block" : "none",
            }}
          >
            <AboutSection />
          </div>
        </div>
      </div>
    </div>
  );
}
