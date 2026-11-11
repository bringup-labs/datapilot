import { create } from "zustand";
import type { ClaudeCodeStatus } from "@shared/ipc";

interface ClaudeCodeState {
  status: ClaudeCodeStatus | null;
  checking: boolean;
  signingIn: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  chooseBinary: () => Promise<void>;
  openInstallGuide: () => Promise<void>;
}

/**
 * A rejected ipcRenderer.invoke reads "Error invoking remote method
 * '<channel>': <Name>Error: <main's message>". Only main's message is shown.
 */
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

const message = (err: unknown): string =>
  err instanceof Error && err.message
    ? err.message.replace(IPC_ERROR_PREFIX, "")
    : "Claude Code couldn't be checked";

// Every action does nothing without the preload bridge (tests, plain browser).
export const useClaudeCodeStore = create<ClaudeCodeState>((set) => ({
  status: null,
  checking: false,
  signingIn: false,
  error: null,

  refresh: async () => {
    const bridge = window.datapilot?.claudeCode;
    if (!bridge) return;
    set({ checking: true, error: null });
    try {
      set({ status: await bridge.status(), checking: false });
    } catch (err) {
      set({ checking: false, error: message(err) });
    }
  },

  signIn: async () => {
    const bridge = window.datapilot?.claudeCode;
    if (!bridge) return;
    set({ signingIn: true, error: null });
    try {
      set({ status: await bridge.signIn(), signingIn: false });
    } catch (err) {
      set({ signingIn: false, error: message(err) });
    }
  },

  chooseBinary: async () => {
    const bridge = window.datapilot?.claudeCode;
    if (!bridge) return;
    set({ error: null });
    try {
      set({ status: await bridge.chooseBinary() });
    } catch (err) {
      set({ error: message(err) });
    }
  },

  openInstallGuide: async () => {
    const bridge = window.datapilot?.claudeCode;
    if (!bridge) return;
    try {
      await bridge.openInstallGuide();
    } catch (err) {
      set({ error: message(err) });
    }
  },
}));
