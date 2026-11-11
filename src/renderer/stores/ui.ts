import { create } from "zustand";
import type { ScreenName, WorkspaceTab } from "@shared/types";

interface UIState {
  screen: ScreenName;
  tab: WorkspaceTab;
  selectedEventT: number | null;
  settingsSectionTarget:
    | "general"
    | "models"
    | "docker"
    | "storage"
    | "shortcuts"
    | "about"
    | null;
  agentsSectionTarget: "agents" | "mcp" | null;

  setScreen: (screen: ScreenName) => void;
  setTab: (tab: WorkspaceTab) => void;
  setSelectedEventT: (t: number | null) => void;
  setSettingsSectionTarget: (section: UIState["settingsSectionTarget"]) => void;
  setAgentsSectionTarget: (section: UIState["agentsSectionTarget"]) => void;
}

export const useUIStore = create<UIState>((set) => ({
  screen: "copilot",
  tab: "timeline",
  selectedEventT: null,
  settingsSectionTarget: null,
  agentsSectionTarget: null,

  setScreen: (screen) => set({ screen }),
  setTab: (tab) => set({ tab }),
  setSelectedEventT: (selectedEventT) => set({ selectedEventT }),
  setSettingsSectionTarget: (settingsSectionTarget) =>
    set({ settingsSectionTarget }),
  setAgentsSectionTarget: (agentsSectionTarget) =>
    set({ agentsSectionTarget }),
}));
