import { create } from "zustand";
import type {
  SessionStatus,
  SessionMeta,
  TimelineEvent,
  TopicInfo,
  LogItem,
  KGraphData,
  WorkspaceTab,
} from "@shared/types";

interface SessionState {
  pendingPath: string | null;
  pendingSessionId: string | null;
  sessionId: string | null;
  /** The bag path the current session was created from; null for one resumed from history. */
  loadedPath: string | null;
  status: SessionStatus;
  meta: SessionMeta | null;
  timeline: TimelineEvent[];
  topics: TopicInfo[];
  logs: LogItem[];
  kgraph: KGraphData | null;

  setPendingPath: (path: string | null) => void;
  setPendingSessionId: (id: string | null) => void;
  setSession: (id: string, meta: SessionMeta) => void;
  setStatus: (status: SessionStatus) => void;
  setTabData: (tab: WorkspaceTab, data: unknown) => void;
  clearSession: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  pendingPath: null,
  pendingSessionId: null,
  sessionId: null,
  loadedPath: null,
  status: "idle",
  meta: null,
  timeline: [],
  topics: [],
  logs: [],
  kgraph: null,

  setPendingPath: (pendingPath) => set({ pendingPath, pendingSessionId: null }),
  setPendingSessionId: (pendingSessionId) =>
    set({ pendingSessionId, pendingPath: null }),

  setSession: (id, meta) => set({ sessionId: id, meta, status: meta.status }),

  setStatus: (status) => set({ status }),

  setTabData: (tab, data) => {
    if (tab === "timeline") set({ timeline: data as TimelineEvent[] });
    else if (tab === "logs") set({ logs: data as LogItem[] });
    else if (tab === "kgraph") set({ kgraph: data as KGraphData });
    // 'metrics' and 'map' are static in Phase 6; topics stored separately
  },

  clearSession: () =>
    set({
      sessionId: null,
      loadedPath: null,
      status: "idle",
      meta: null,
      timeline: [],
      topics: [],
      logs: [],
      kgraph: null,
    }),
}));

export function setTopicsData(topics: TopicInfo[]): void {
  useSessionStore.setState({ topics });
}
