import { contextBridge, ipcRenderer } from "electron";
import type {
  ClaudeCodeChatEvent,
  ClaudeCodeStatus,
  DatapilotApi,
  DockerStatus,
  KeychainSetResult,
} from "@shared/ipc";

/**
 * Narrow API surface exposed to the renderer.
 * The renderer cannot reach `ipcRenderer` directly — everything goes through this object.
 */
const api: DatapilotApi = {
  app: {
    version: () => ipcRenderer.invoke("app:version") as Promise<string>,
    platform: () =>
      ipcRenderer.invoke("app:platform") as Promise<NodeJS.Platform>,
    userDataPath: () =>
      ipcRenderer.invoke("app:userDataPath") as Promise<string>,
    homePath: () => ipcRenderer.invoke("app:homePath") as Promise<string>,
  },
  docker: {
    status: () => ipcRenderer.invoke("docker:status") as Promise<DockerStatus>,
    retry: () => ipcRenderer.invoke("docker:retry") as Promise<void>,
    onStatusChanged: (callback: (status: DockerStatus) => void) => {
      const handler = (_event: any, status: DockerStatus) => callback(status);
      ipcRenderer.on("docker:status-changed", handler);
      return () => {
        ipcRenderer.removeListener("docker:status-changed", handler);
      };
    },
    streamLogs: async (service: string, onChunk: (chunk: string) => void) => {
      const subId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `sub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const channel = `docker:logs:chunk:${subId}`;
      const handler = (_event: any, chunk: string) => onChunk(chunk);
      ipcRenderer.on(channel, handler);
      await ipcRenderer.invoke("docker:logs:start", subId, service);
      return async () => {
        ipcRenderer.removeListener(channel, handler);
        await ipcRenderer.invoke("docker:logs:stop", subId);
      };
    },
  },
  file: {
    pickBag: () => ipcRenderer.invoke("file:pickBag") as Promise<string | null>,
    onOpenBag: (callback: (bagPath: string) => void) => {
      const handler = (_event: any, bagPath: string) => callback(bagPath);
      ipcRenderer.on("file:open-bag", handler);
      return () => {
        ipcRenderer.removeListener("file:open-bag", handler);
      };
    },
  },
  theme: {
    get: () =>
      ipcRenderer.invoke("theme:get") as Promise<"dark" | "light" | "system">,
    set: (theme) => ipcRenderer.invoke("theme:set", theme) as Promise<void>,
  },
  settings: {
    get: (key) =>
      ipcRenderer.invoke("settings:get", key) as Promise<string | null>,
    set: (key, value) =>
      ipcRenderer.invoke("settings:set", key, value) as Promise<void>,
  },
  keychain: {
    get: (key) =>
      ipcRenderer.invoke("keychain:get", key) as Promise<string | null>,
    set: (key, value) =>
      ipcRenderer.invoke(
        "keychain:set",
        key,
        value,
      ) as Promise<KeychainSetResult>,
  },
  shell: {
    openPath: (path) =>
      ipcRenderer.invoke("shell:openPath", path) as Promise<void>,
  },
  storage: {
    usage: (path) => ipcRenderer.invoke("storage:usage", path),
  },
  claudeCode: {
    status: () =>
      ipcRenderer.invoke("claudeCode:status") as Promise<ClaudeCodeStatus>,
    signIn: () =>
      ipcRenderer.invoke("claudeCode:signIn") as Promise<ClaudeCodeStatus>,
    chooseBinary: () =>
      ipcRenderer.invoke("claudeCode:chooseBinary") as Promise<ClaudeCodeStatus>,
    openInstallGuide: () =>
      ipcRenderer.invoke("claudeCode:openInstallGuide") as Promise<void>,
    ask: async (request, onEvent) => {
      const subId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `sub_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const channel = `claudeCode:event:${subId}`;
      const handler = (_event: unknown, e: ClaudeCodeChatEvent) => onEvent(e);
      // Subscribe before invoking so no early event is missed.
      ipcRenderer.on(channel, handler);
      try {
        await ipcRenderer.invoke("claudeCode:ask", subId, request);
      } catch (err) {
        ipcRenderer.removeListener(channel, handler);
        throw err;
      }
      return async () => {
        ipcRenderer.removeListener(channel, handler);
        await ipcRenderer.invoke("claudeCode:stop", subId);
      };
    },
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("datapilot", api);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to expose preload API:", err);
  }
} else {
  // @ts-expect-error attaching to window when isolation is off
  window.datapilot = api;
}
