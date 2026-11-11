import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "@renderer/stores/settings";
import { useUIStore } from "@renderer/stores/ui";
import { ConnectBanner } from "./ConnectBanner";

const settingsInitial = useSettingsStore.getState();
const uiInitial = useUIStore.getState();

describe("ConnectBanner", () => {
  beforeEach(() => {
    useSettingsStore.setState(
      {
        ...settingsInitial,
        copilotEngine: "datapilot",
        defaultProvider: "google",
        apiKeys: {},
      },
      true,
    );
    useUIStore.setState(uiInitial, true);
  });

  it("offers Claude Code or an API key when no model works", () => {
    render(<ConnectBanner />);
    expect(screen.getByText("Connect an AI model")).toBeInTheDocument();
    expect(
      screen.getByText(/Answer with Claude Code on this computer, or add an API key for/),
    ).toHaveTextContent("Gemini (Google)");
    expect(screen.getByRole("button", { name: /Use Claude Code/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add an API key/ })).toBeInTheDocument();
  });

  it.each(["Use Claude Code", "Add an API key"])(
    "%s opens Models & API Keys",
    async (label) => {
      const user = userEvent.setup();
      render(<ConnectBanner />);
      await user.click(screen.getByRole("button", { name: new RegExp(label) }));
      expect(useUIStore.getState().screen).toBe("settings");
      expect(useUIStore.getState().settingsSectionTarget).toBe("models");
    },
  );

  it("stays hidden in Claude Code mode", () => {
    useSettingsStore.setState({ copilotEngine: "claude_code" });
    const { container } = render(<ConnectBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden when the provider has a key or is Ollama", () => {
    useSettingsStore.setState({ apiKeys: { google: "k" } });
    const { container, unmount } = render(<ConnectBanner />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    useSettingsStore.setState({ defaultProvider: "ollama", apiKeys: {} });
    const r = render(<ConnectBanner />);
    expect(r.container).toBeEmptyDOMElement();
  });
});
