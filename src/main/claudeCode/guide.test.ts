// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

const mocks = vi.hoisted(() => ({ isPackaged: false }));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged;
    },
    getAppPath: () => process.cwd(),
  },
}));

describe("resolveGuidePath", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("finds the guide in the source tree in development", async () => {
    mocks.isPackaged = false;
    const { resolveGuidePath } = await import("./guide");
    const p = resolveGuidePath();
    expect(p.endsWith("src/main/claudeCode/datapilot-guide.md")).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("finds the guide in resources when packaged", async () => {
    mocks.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", { value: "/res", configurable: true });
    const { resolveGuidePath } = await import("./guide");
    expect(resolveGuidePath()).toBe("/res/datapilot-guide.md");
  });
});

describe("datapilot-guide.md", () => {
  const guide = fs.readFileSync("src/main/claudeCode/datapilot-guide.md", "utf-8");

  it("starts with get_bag_overview, requires submit_findings and names no excluded tool", () => {
    expect(guide).toContain("get_bag_overview");
    expect(guide).toContain("submit_findings");
    for (const t of ["query_graph", "query_mcap", "find_rate_regressions", "compare_"]) {
      expect(guide).not.toContain(t);
    }
  });

  it("names the 17 tools and stays short", () => {
    for (const t of [
      "get_bag_overview", "retrieve_logs", "find_aborts", "query_causal_chain", "query_topic",
      "query_topic_rate", "find_dropouts", "find_statistical_outliers", "find_signature_matches",
      "compute_node_cpu", "query_commands", "query_recoveries", "query_safety_rules",
      "read_diagnostics", "read_tf_chain", "format_causal_chain", "submit_findings",
    ]) {
      expect(guide).toContain(t);
    }
    expect(guide.split(/\s+/).length).toBeLessThan(1500);
    expect(guide).not.toMatch(/anthropic/i);
  });

  it("gives enum arguments as the literal values the tool schema accepts", () => {
    expect(guide).toContain("zscore");
    expect(guide).toContain("iqr");
    expect(guide).not.toContain("z-score");
    for (const v of ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"]) expect(guide).toContain(v);
  });
});
