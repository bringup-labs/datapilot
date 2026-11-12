import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Setup } from "./Setup";

describe("Setup", () => {
  // The card used to name neo4j:5-community and blame the internet connection
  // for every image failure, whichever image failed and why.
  it("shows which image failed and why", () => {
    const message =
      "DataPilot couldn't download ghcr.io/bringup-labs/datapilot-mcp-rosbag-reader:0.2.4: the registry refused access, so the image is private or hasn't been published.";

    render(
      <Setup
        status={{ state: "error", code: "image_pull_failed", message }}
        onRetry={() => undefined}
      />,
    );

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.queryByText("neo4j:5-community")).not.toBeInTheDocument();
    expect(screen.queryByText(/stable internet connection/)).not.toBeInTheDocument();
  });
});
