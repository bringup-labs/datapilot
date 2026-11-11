import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// The settings store imports updateBackendKey / clearAllSessions from the api
// service at module load. Mock the whole module so no real fetch is attempted.
vi.mock("@renderer/services/api", () => ({
  updateBackendKey: vi.fn().mockResolvedValue({ status: "ok", message: "" }),
  clearAllSessions: vi.fn().mockResolvedValue({ status: "ok", message: "" }),
}));

import { useSettingsStore, ACCENT_PRESETS } from "./settings";
import { updateBackendKey, clearAllSessions } from "@renderer/services/api";

const mockedUpdateBackendKey = vi.mocked(updateBackendKey);
const mockedClearAllSessions = vi.mocked(clearAllSessions);

const initial = useSettingsStore.getState();

/** Build a fresh window.datapilot stub backed by an in-memory key/value map. */
function installDatapilotStub(overrides: Record<string, unknown> = {}) {
  const settingsMap = new Map<string, string>();
  const keychainMap = new Map<string, string>();

  const stub = {
    app: {
      platform: vi.fn().mockResolvedValue("darwin"),
      userDataPath: vi.fn().mockResolvedValue("/Users/test/Library/datapilot"),
      homePath: vi.fn().mockResolvedValue("/Users/test"),
    },
    settings: {
      get: vi.fn(async (key: string) => settingsMap.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        settingsMap.set(key, value);
      }),
    },
    keychain: {
      get: vi.fn(async (key: string) => keychainMap.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => {
        keychainMap.set(key, value);
        return { ok: true };
      }),
    },
    ...overrides,
  };

  (globalThis as unknown as { window: { datapilot: unknown } }).window =
    (globalThis as unknown as { window: Record<string, unknown> }).window ?? {};
  (window as unknown as { datapilot: unknown }).datapilot = stub;
  return { stub, settingsMap, keychainMap };
}

describe("useSettingsStore", () => {
  let originalDatapilot: unknown;

  beforeEach(() => {
    originalDatapilot = (window as unknown as { datapilot?: unknown }).datapilot;
    useSettingsStore.setState(initial, true);
    mockedUpdateBackendKey.mockClear();
    mockedClearAllSessions.mockClear();
    installDatapilotStub();
  });

  afterEach(() => {
    (window as unknown as { datapilot?: unknown }).datapilot = originalDatapilot;
    vi.restoreAllMocks();
  });

  it("exposes the documented accent presets", () => {
    expect(ACCENT_PRESETS.map((p) => p.label)).toEqual([
      "Electric",
      "Lime",
      "Magenta",
      "Amber",
      "Crimson",
    ]);
  });

  it("has the documented default values", () => {
    const s = useSettingsStore.getState();
    expect(s.accentColor).toBe("Electric");
    expect(s.defaultProvider).toBe("google");
    expect(s.defaultModel).toBe("gemini-3.1-flash-lite");
    expect(s.concurrentWorkers).toBe(4);
    expect(s.loading).toBe(false);
    expect(s.apiKeys.anthropic).toBe("");
  });

  describe("loadSettings", () => {
    it("is a no-op when window.datapilot is absent", async () => {
      delete (window as unknown as { datapilot?: unknown }).datapilot;
      await useSettingsStore.getState().loadSettings();
      // loading flag never got flipped because we returned early.
      expect(useSettingsStore.getState().loading).toBe(false);
    });

    it("falls back to defaults when settings/keychain are empty", async () => {
      await useSettingsStore.getState().loadSettings();
      const s = useSettingsStore.getState();
      expect(s.loading).toBe(false);
      expect(s.accentColor).toBe("Electric");
      expect(s.concurrentWorkers).toBe(4);
      // Non-Windows default socket.
      expect(s.dockerSocket).toBe("/var/run/docker.sock");
      // Unix-style bag archive root from homePath.
      expect(s.bagArchiveRoot).toBe("/Users/test/datapilot/bags");
      expect(s.cacheDir).toBe("/Users/test/Library/datapilot");
    });

    it("uses Windows defaults when the platform is win32", async () => {
      installDatapilotStub({
        app: {
          platform: vi.fn().mockResolvedValue("win32"),
          userDataPath: vi.fn().mockResolvedValue("C:\\Users\\test\\AppData"),
          homePath: vi.fn().mockResolvedValue("C:\\Users\\test"),
        },
      });
      await useSettingsStore.getState().loadSettings();
      const s = useSettingsStore.getState();
      expect(s.dockerSocket).toBe("\\\\.\\pipe\\docker_engine");
      expect(s.bagArchiveRoot).toBe("C:\\Users\\test\\datapilot\\bags");
    });

    it("reads persisted string / bool / number settings and keychain keys", async () => {
      const { settingsMap, keychainMap } = installDatapilotStub();
      settingsMap.set("accent_color", "Lime");
      settingsMap.set("mono_freq", "false");
      settingsMap.set("concurrent_workers", "8");
      keychainMap.set("anthropic", "sk-ant-123");

      await useSettingsStore.getState().loadSettings();
      const s = useSettingsStore.getState();
      expect(s.accentColor).toBe("Lime");
      expect(s.monoFreq).toBe(false);
      expect(s.concurrentWorkers).toBe(8);
      expect(s.apiKeys.anthropic).toBe("sk-ant-123");
    });

    it("applies the matching accent preset to the document CSS variable", async () => {
      const { settingsMap } = installDatapilotStub();
      settingsMap.set("accent_color", "Crimson");
      const spy = vi.spyOn(document.documentElement.style, "setProperty");
      await useSettingsStore.getState().loadSettings();
      const crimson = ACCENT_PRESETS.find((p) => p.label === "Crimson")!;
      expect(spy).toHaveBeenCalledWith("--color-accent", crimson.color);
    });

    it("issues the independent settings/keychain reads in parallel, not serially", async () => {
      // Instrument settings.get + keychain.get to record peak concurrency:
      // each call holds a microtask-deferred resolution so genuinely parallel
      // reads overlap, while serial awaits would never exceed concurrency 1.
      let inFlight = 0;
      let peak = 0;
      const defer = () =>
        new Promise<null>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          // Resolve on a later microtask so other queued reads can start first.
          Promise.resolve()
            .then(() => Promise.resolve())
            .then(() => {
              inFlight -= 1;
              resolve(null);
            });
        });

      installDatapilotStub({
        settings: { get: vi.fn(defer), set: vi.fn(async () => {}) },
        keychain: { get: vi.fn(defer), set: vi.fn(async () => {}) },
      });

      await useSettingsStore.getState().loadSettings();

      // 20 settings reads + 6 keychain reads run concurrently; serial awaits
      // would cap peak at 1. Require substantial overlap.
      expect(peak).toBeGreaterThan(5);
    });

    it("recovers and clears the loading flag if a datapilot call throws", async () => {
      installDatapilotStub({
        app: {
          platform: vi.fn().mockRejectedValue(new Error("ipc down")),
          userDataPath: vi.fn().mockResolvedValue("/x"),
          homePath: vi.fn().mockResolvedValue("/x"),
        },
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await useSettingsStore.getState().loadSettings();
      expect(useSettingsStore.getState().loading).toBe(false);
      expect(errSpy).toHaveBeenCalled();
    });
  });

  describe("setSetting", () => {
    it("is a no-op without window.datapilot", async () => {
      delete (window as unknown as { datapilot?: unknown }).datapilot;
      await useSettingsStore.getState().setSetting("uiDensity", "Compact");
      // Optimistic update is gated behind the datapilot guard, so nothing changes.
      expect(useSettingsStore.getState().uiDensity).toBe("Comfortable");
    });

    it("optimistically updates state and persists under the snake_case key", async () => {
      const { settingsMap } = installDatapilotStub();
      await useSettingsStore.getState().setSetting("uiDensity", "Compact");
      expect(useSettingsStore.getState().uiDensity).toBe("Compact");
      expect(settingsMap.get("ui_density")).toBe("Compact");
    });

    it("stringifies numeric and boolean values when persisting", async () => {
      const { settingsMap } = installDatapilotStub();
      await useSettingsStore.getState().setSetting("concurrentWorkers", 6);
      await useSettingsStore.getState().setSetting("monoFreq", false);
      expect(settingsMap.get("concurrent_workers")).toBe("6");
      expect(settingsMap.get("mono_freq")).toBe("false");
    });

    it("applies the accent preset when accentColor changes", async () => {
      const spy = vi.spyOn(document.documentElement.style, "setProperty");
      await useSettingsStore.getState().setSetting("accentColor", "Amber");
      const amber = ACCENT_PRESETS.find((p) => p.label === "Amber")!;
      expect(spy).toHaveBeenCalledWith("--color-accent", amber.color);
    });

    it("syncs default_provider to the backend when defaultProvider changes", async () => {
      await useSettingsStore.getState().setSetting("defaultProvider", "openai");
      expect(mockedUpdateBackendKey).toHaveBeenCalledWith(
        "default_provider",
        "openai",
      );
    });

    it("syncs default_model to the backend when defaultModel changes", async () => {
      await useSettingsStore.getState().setSetting("defaultModel", "gpt-9o");
      expect(mockedUpdateBackendKey).toHaveBeenCalledWith(
        "default_model",
        "gpt-9o",
      );
    });
  });

  describe("setApiKey", () => {
    it("is a no-op without window.datapilot", async () => {
      delete (window as unknown as { datapilot?: unknown }).datapilot;
      await useSettingsStore.getState().setApiKey("openai", "sk-1");
      expect(useSettingsStore.getState().apiKeys.openai).toBe("");
    });

    it("updates the slice and keychain but never POSTs the key to the backend (#39)", async () => {
      const { keychainMap } = installDatapilotStub();
      await useSettingsStore.getState().setApiKey("openai", "sk-test");
      expect(useSettingsStore.getState().apiKeys.openai).toBe("sk-test");
      expect(keychainMap.get("openai")).toBe("sk-test");
      // #39: the secret must stay in safeStorage; the main process delivers it
      // to the backend out of band (secret file), so no renderer→HTTP POST.
      expect(mockedUpdateBackendKey).not.toHaveBeenCalledWith(
        "openai",
        "sk-test",
      );
    });

    it("logs a failure when the keychain refuses to persist (#40/#51)", async () => {
      installDatapilotStub({
        keychain: {
          get: vi.fn(async () => null),
          set: vi.fn(async () => ({
            ok: false,
            error: "Secure storage unavailable",
          })),
        },
      });
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await useSettingsStore.getState().setApiKey("openai", "sk-test");
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it("preserves other providers' keys when setting one", async () => {
      await useSettingsStore.getState().setApiKey("openai", "a");
      await useSettingsStore.getState().setApiKey("google", "b");
      const keys = useSettingsStore.getState().apiKeys;
      expect(keys.openai).toBe("a");
      expect(keys.google).toBe("b");
    });
  });

  describe("syncKeysToBackend", () => {
    it("syncs default provider/model but never the secret API keys (#39)", async () => {
      useSettingsStore.setState({
        apiKeys: {
          anthropic: "sk-ant",
          openai: "",
          google: "g-key",
          ollama: "",
          nvidia: "",
          custom: "",
        },
        defaultProvider: "google",
        defaultModel: "gemini-3.1-flash-lite",
      });
      await useSettingsStore.getState().syncKeysToBackend();

      // #39: provider keys are never POSTed; only the non-secret defaults are.
      expect(mockedUpdateBackendKey).not.toHaveBeenCalledWith(
        "anthropic",
        "sk-ant",
      );
      expect(mockedUpdateBackendKey).not.toHaveBeenCalledWith("google", "g-key");
      expect(mockedUpdateBackendKey).toHaveBeenCalledWith(
        "default_provider",
        "google",
      );
      expect(mockedUpdateBackendKey).toHaveBeenCalledWith(
        "default_model",
        "gemini-3.1-flash-lite",
      );
    });

    it("continues syncing even if one backend call rejects", async () => {
      mockedUpdateBackendKey.mockRejectedValueOnce(new Error("boom"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      useSettingsStore.setState({
        apiKeys: {
          anthropic: "sk-ant",
          openai: "",
          google: "",
          ollama: "",
          nvidia: "",
          custom: "",
        },
      });
      await useSettingsStore.getState().syncKeysToBackend();
      // The default_provider / default_model calls still fire after the failure.
      expect(mockedUpdateBackendKey).toHaveBeenCalledWith(
        "default_provider",
        expect.any(String),
      );
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe("Claude Code settings", () => {
    it("defaults the Copilot to DataPilot's agents and Claude Code's default model", () => {
      expect(useSettingsStore.getState()).toMatchObject({
        copilotEngine: "datapilot",
        claudeCodeModel: "",
      });
    });

    it("reads copilot_engine and claude_code_model, ignoring unknown values", async () => {
      const { settingsMap } = installDatapilotStub();
      settingsMap.set("copilot_engine", "claude_code");
      settingsMap.set("claude_code_model", "opus");
      await useSettingsStore.getState().loadSettings();
      expect(useSettingsStore.getState()).toMatchObject({
        copilotEngine: "claude_code",
        claudeCodeModel: "opus",
      });
      settingsMap.set("copilot_engine", "bogus");
      settingsMap.set("claude_code_model", "gpt-9");
      await useSettingsStore.getState().loadSettings();
      expect(useSettingsStore.getState()).toMatchObject({
        copilotEngine: "datapilot",
        claudeCodeModel: "",
      });
    });

    it("saves copilotEngine as copilot_engine and claudeCodeModel as claude_code_model", async () => {
      const { settingsMap } = installDatapilotStub();
      await useSettingsStore.getState().setSetting("copilotEngine", "claude_code");
      await useSettingsStore.getState().setSetting("claudeCodeModel", "haiku");
      expect(settingsMap.get("copilot_engine")).toBe("claude_code");
      expect(settingsMap.get("claude_code_model")).toBe("haiku");
    });

    it("reset clears copilot_engine and claude_code_model", async () => {
      const { settingsMap } = installDatapilotStub();
      settingsMap.set("copilot_engine", "claude_code");
      settingsMap.set("claude_code_model", "opus");
      await useSettingsStore.getState().resetSettings();
      expect(settingsMap.get("copilot_engine")).toBe("");
      expect(settingsMap.get("claude_code_model")).toBe("");
      expect(useSettingsStore.getState()).toMatchObject({
        copilotEngine: "datapilot",
        claudeCodeModel: "",
      });
    });
  });

  describe("resetSettings", () => {
    it("clears backend sessions, wipes settings + keychain, and reloads defaults", async () => {
      const { settingsMap, keychainMap } = installDatapilotStub();
      settingsMap.set("accent_color", "Lime");
      keychainMap.set("openai", "sk-old");

      await useSettingsStore.getState().resetSettings();

      expect(mockedClearAllSessions).toHaveBeenCalledTimes(1);
      // Every persisted setting key was overwritten with an empty string.
      expect(settingsMap.get("accent_color")).toBe("");
      // Every provider key was cleared from the secure store; the cleared keys
      // are NOT POSTed to the backend (#39) — the main process re-syncs the
      // secret file from safeStorage instead.
      expect(keychainMap.get("openai")).toBe("");
      expect(mockedUpdateBackendKey).not.toHaveBeenCalledWith("openai", "");
      // loadSettings ran at the end, restoring defaults and clearing loading.
      const s = useSettingsStore.getState();
      expect(s.loading).toBe(false);
      expect(s.accentColor).toBe("Electric");
    });

    it("is a no-op without window.datapilot", async () => {
      delete (window as unknown as { datapilot?: unknown }).datapilot;
      await useSettingsStore.getState().resetSettings();
      expect(mockedClearAllSessions).not.toHaveBeenCalled();
    });
  });
});
