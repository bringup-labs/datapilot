import { create } from "zustand";
import { clearAllSessions, updateBackendKey } from "@renderer/services/api";
import type { ClaudeCodeModel, CopilotEngine } from "@shared/ipc";

export const ACCENT_PRESETS = [
  { color: "oklch(0.74 0.17 235)", label: "Electric" },
  { color: "oklch(0.78 0.17 150)", label: "Lime" },
  { color: "oklch(0.70 0.18 330)", label: "Magenta" },
  { color: "oklch(0.80 0.15 80)", label: "Amber" },
  { color: "oklch(0.70 0.20 25)", label: "Crimson" },
] as const;

interface SettingsState {
  accentColor: string;
  uiDensity: string;
  monoFreq: boolean;
  telemetryUsage: boolean;
  telemetryCrash: boolean;
  defaultProvider: string;
  defaultModel: string;
  embeddingModel: string;
  apiKeys: Record<string, string>;
  dockerSocket: string;
  tlsCertPath: string;
  defaultRosImage: string;
  gpuPassthrough: boolean;
  concurrentWorkers: number;
  autoTeardownAfter: string;
  cacheDir: string;
  bagArchiveRoot: string;
  autoIndexBags: boolean;
  chunkWindow: string;
  updateChannel: string;
  copilotEngine: CopilotEngine;
  claudeCodeModel: ClaudeCodeModel;
  loading: boolean;

  loadSettings: () => Promise<void>;
  syncKeysToBackend: () => Promise<void>;
  setSetting: (key: string, value: string | boolean | number) => Promise<void>;
  setApiKey: (provider: string, value: string) => Promise<void>;
  resetSettings: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  accentColor: "Electric",
  uiDensity: "Comfortable",
  monoFreq: true,
  telemetryUsage: false,
  telemetryCrash: true,
  defaultProvider: "google",
  defaultModel: "gemini-3.1-flash-lite",
  embeddingModel: "voyage-3 (Anthropic)",
  apiKeys: {
    anthropic: "",
    openai: "",
    google: "",
    ollama: "",
    nvidia: "",
    custom: "",
  },
  dockerSocket: "",
  tlsCertPath: "",
  defaultRosImage: "osrf/ros:humble-desktop",
  gpuPassthrough: true,
  concurrentWorkers: 4,
  autoTeardownAfter: "2 minutes",
  cacheDir: "",
  bagArchiveRoot: "~/datapilot/bags",
  autoIndexBags: true,
  chunkWindow: "5 sec",
  updateChannel: "Stable",
  copilotEngine: "datapilot",
  claudeCodeModel: "",
  loading: false,

  loadSettings: async () => {
    if (!window.datapilot) return;
    set({ loading: true });

    try {
      const platform = await window.datapilot.app.platform();
      const isWin = platform === "win32";
      const defaultSocket = isWin
        ? "\\\\.\\pipe\\docker_engine"
        : "/var/run/docker.sock";
      const [userDataPath, homePath] = await Promise.all([
        window.datapilot.app.userDataPath(),
        window.datapilot.app.homePath(),
      ]);
      const defaultCache = userDataPath;
      const defaultBagArchiveRoot = isWin
        ? `${homePath}\\datapilot\\bags`
        : `${homePath}/datapilot/bags`;

      const getStr = async (key: string, def: string) => {
        const val = await window.datapilot.settings.get(key);
        return val === null || val === "" ? def : val;
      };
      const getBool = async (key: string, def: boolean) => {
        const val = await window.datapilot.settings.get(key);
        return val !== null && val !== "" ? val === "true" : def;
      };
      const getNum = async (key: string, def: number) => {
        const val = await window.datapilot.settings.get(key);
        return val !== null && val !== "" ? parseInt(val, 10) : def;
      };

      // All settings reads and keychain lookups below are independent of one
      // another, so run them concurrently instead of awaiting serially. This
      // turns ~24 sequential IPC round-trips into a single parallel batch so
      // first paint isn't blocked behind them.
      const providerIds = [
        "anthropic",
        "openai",
        "google",
        "ollama",
        "nvidia",
        "custom",
      ];

      const [
        accentColor,
        uiDensity,
        monoFreq,
        telemetryUsage,
        telemetryCrash,
        defaultProvider,
        defaultModel,
        embeddingModel,
        dockerSocket,
        tlsCertPath,
        defaultRosImage,
        gpuPassthrough,
        concurrentWorkers,
        autoTeardownAfter,
        cacheDir,
        bagArchiveRoot,
        autoIndexBags,
        chunkWindow,
        updateChannel,
        copilotEngineRaw,
        claudeCodeModelRaw,
        keychainValues,
      ] = await Promise.all([
        getStr("accent_color", "Electric"),
        getStr("ui_density", "Comfortable"),
        getBool("mono_freq", true),
        getBool("telemetry_usage", false),
        getBool("telemetry_crash", true),
        getStr("default_provider", "google"),
        getStr("default_model", "gemini-3.1-flash-lite"),
        getStr("embedding_model", "voyage-3 (Anthropic)"),
        getStr("docker_socket", defaultSocket),
        getStr("tls_cert_path", ""),
        getStr("default_ros_image", "osrf/ros:humble-desktop"),
        getBool("gpu_passthrough", true),
        getNum("concurrent_workers", 4),
        getStr("auto_teardown_after", "2 minutes"),
        getStr("cache_dir", defaultCache),
        getStr("bag_archive_root", defaultBagArchiveRoot),
        getBool("auto_index_bags", true),
        getStr("chunk_window", "5 sec"),
        getStr("update_channel", "Stable"),
        getStr("copilot_engine", "datapilot"),
        getStr("claude_code_model", ""),
        Promise.all(
          providerIds.map(async (p) => window.datapilot.keychain.get(p)),
        ),
      ]);

      const copilotEngine: CopilotEngine =
        copilotEngineRaw === "claude_code" ? "claude_code" : "datapilot";
      const claudeCodeModel: ClaudeCodeModel =
        claudeCodeModelRaw === "sonnet" ||
        claudeCodeModelRaw === "opus" ||
        claudeCodeModelRaw === "haiku"
          ? claudeCodeModelRaw
          : "";

      const apiKeys: Record<string, string> = {};
      providerIds.forEach((p, i) => {
        apiKeys[p] = keychainValues[i] ?? "";
      });

      set({
        accentColor,
        uiDensity,
        monoFreq,
        telemetryUsage,
        telemetryCrash,
        defaultProvider,
        defaultModel,
        embeddingModel,
        dockerSocket,
        tlsCertPath,
        defaultRosImage,
        gpuPassthrough,
        concurrentWorkers,
        autoTeardownAfter,
        cacheDir,
        bagArchiveRoot,
        autoIndexBags,
        chunkWindow,
        updateChannel,
        copilotEngine,
        claudeCodeModel,
        apiKeys,
        loading: false,
      });

      // Apply accent color
      const preset = ACCENT_PRESETS.find((p) => p.label === accentColor);
      if (preset) {
        document.documentElement.style.setProperty(
          "--color-accent",
          preset.color,
        );
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
      set({ loading: false });
    }
  },

  // Called by App.tsx once dockerStatus.state === 'ready' so the backend is
  // guaranteed to be listening before we attempt the POST.
  syncKeysToBackend: async () => {
    const { defaultProvider, defaultModel } = get();
    // #39: provider API keys are NEVER POSTed to the backend. They live in
    // safeStorage and are delivered out of band via the main-process secret
    // file. Only the non-secret default provider/model are synced over HTTP.
    try {
      await updateBackendKey("default_provider", defaultProvider);
    } catch (err) {
      console.warn("Failed to sync default_provider to backend:", err);
    }
    try {
      await updateBackendKey("default_model", defaultModel);
    } catch (err) {
      console.warn("Failed to sync default_model to backend:", err);
    }
  },

  setSetting: async (key: string, value: string | boolean | number) => {
    if (!window.datapilot) return;

    // Map store key camelCase to setting key snake_case
    const dbKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();

    // Optimistic update
    set({ [key]: value } as any);

    try {
      await window.datapilot.settings.set(dbKey, String(value));

      // Special case: apply accent color change immediately
      if (key === "accentColor") {
        const preset = ACCENT_PRESETS.find((p) => p.label === value);
        if (preset) {
          document.documentElement.style.setProperty(
            "--color-accent",
            preset.color,
          );
        }
      }

      // Keep backend in sync when the default provider or model changes
      if (key === "defaultProvider") {
        try {
          await updateBackendKey("default_provider", String(value));
        } catch (err) {
          console.warn("Failed to sync default_provider to backend:", err);
        }
      }
      if (key === "defaultModel") {
        try {
          await updateBackendKey("default_model", String(value));
        } catch (err) {
          console.warn("Failed to sync default_model to backend:", err);
        }
      }
    } catch (err) {
      console.error(`Failed to save setting ${key}:`, err);
    }
  },

  setApiKey: async (provider: string, value: string) => {
    if (!window.datapilot) return;

    set((state) => ({
      apiKeys: {
        ...state.apiKeys,
        [provider]: value,
      },
    }));

    try {
      // #39: persist to safeStorage only. The main process delivers the key to
      // the backend out of band (secret file), so it never crosses renderer→HTTP.
      const result = await window.datapilot.keychain.set(provider, value);
      // #40/#51: surface a refused/failed persist instead of silently dropping it.
      if (result && result.ok === false) {
        console.error(
          `Failed to save API key for ${provider}: ${result.error ?? "unknown error"}`,
        );
      }
    } catch (err) {
      console.error(`Failed to save API key for ${provider}:`, err);
    }
  },

  resetSettings: async () => {
    if (!window.datapilot) return;
    set({ loading: true });

    try {
      // Clear backend sessions
      try {
        await clearAllSessions();
      } catch (err) {
        console.error("Failed to clear backend sessions during reset:", err);
      }

      // Clear all keys from settings.json by saving empty strings or resetting defaults
      const keysToReset = [
        "accent_color",
        "ui_density",
        "mono_freq",
        "telemetry_usage",
        "telemetry_crash",
        "default_provider",
        "default_model",
        "embedding_model",
        // docker_socket is privileged and no longer renderer-settable (#31).
        "tls_cert_path",
        "default_ros_image",
        "gpu_passthrough",
        "concurrent_workers",
        "auto_teardown_after",
        "cache_dir",
        "bag_archive_root",
        "auto_index_bags",
        "chunk_window",
        "update_channel",
        "copilot_engine",
        "claude_code_model",
      ];

      for (const k of keysToReset) {
        await window.datapilot.settings.set(k, "");
      }

      // Clear each provider key from the secure store. We do NOT POST the
      // cleared keys to the backend (#39); the main process re-syncs the secret
      // file from safeStorage after the keychain changes.
      for (const p of [
        "anthropic",
        "openai",
        "google",
        "ollama",
        "nvidia",
        "custom",
      ]) {
        await window.datapilot.keychain.set(p, "");
      }

      // Reload defaults
      await get().loadSettings();
    } catch (err) {
      console.error("Failed to reset settings:", err);
      set({ loading: false });
    }
  },
}));
