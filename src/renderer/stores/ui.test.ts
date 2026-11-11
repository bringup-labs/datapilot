import { describe, it, expect, beforeEach } from "vitest";
import { useUIStore } from "./ui";

const initial = useUIStore.getState();

describe("useUIStore", () => {
  beforeEach(() => {
    // Reset to the store's initial state between tests. Actions live on the
    // initial snapshot, so spreading it back restores a clean store.
    useUIStore.setState(initial, true);
  });

  it("starts on the copilot screen with the timeline tab", () => {
    const s = useUIStore.getState();
    expect(s.screen).toBe("copilot");
    expect(s.tab).toBe("timeline");
    expect(s.selectedEventT).toBeNull();
    expect(s.settingsSectionTarget).toBeNull();
  });

  it("setScreen switches the active screen", () => {
    useUIStore.getState().setScreen("agents");
    expect(useUIStore.getState().screen).toBe("agents");

    useUIStore.getState().setScreen("settings");
    expect(useUIStore.getState().screen).toBe("settings");
  });

  it("setTab switches the active workspace tab", () => {
    useUIStore.getState().setTab("logs");
    expect(useUIStore.getState().tab).toBe("logs");

    useUIStore.getState().setTab("kgraph");
    expect(useUIStore.getState().tab).toBe("kgraph");
  });

  it("setSelectedEventT sets and clears the selected timeline event", () => {
    useUIStore.getState().setSelectedEventT(12.5);
    expect(useUIStore.getState().selectedEventT).toBe(12.5);

    useUIStore.getState().setSelectedEventT(null);
    expect(useUIStore.getState().selectedEventT).toBeNull();
  });

  it("setSelectedEventT accepts 0 as a valid (non-null) timestamp", () => {
    useUIStore.getState().setSelectedEventT(0);
    expect(useUIStore.getState().selectedEventT).toBe(0);
  });

  it("setSettingsSectionTarget targets a section and resets to null", () => {
    useUIStore.getState().setSettingsSectionTarget("docker");
    expect(useUIStore.getState().settingsSectionTarget).toBe("docker");

    useUIStore.getState().setSettingsSectionTarget(null);
    expect(useUIStore.getState().settingsSectionTarget).toBeNull();
  });

  it("updates each slice independently without disturbing the others", () => {
    useUIStore.getState().setScreen("settings");
    useUIStore.getState().setTab("metrics");
    const s = useUIStore.getState();
    expect(s.screen).toBe("settings");
    expect(s.tab).toBe("metrics");
    expect(s.selectedEventT).toBeNull();
  });

  it("setAgentsSectionTarget sets and clears the target", () => {
    expect(useUIStore.getState().agentsSectionTarget).toBeNull();
    useUIStore.getState().setAgentsSectionTarget("mcp");
    expect(useUIStore.getState().agentsSectionTarget).toBe("mcp");
    useUIStore.getState().setAgentsSectionTarget(null);
    expect(useUIStore.getState().agentsSectionTarget).toBeNull();
  });
});
