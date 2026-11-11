// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

interface CreatedContainer {
  name: string;
  Env?: string[];
  HostConfig: { ExtraHosts?: string[] };
}

const state = vi.hoisted(() => ({
  created: [] as unknown[],
  userData: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => state.userData,
    getAppPath: () => process.cwd(),
    getVersion: () => "0.0.0",
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
}));

vi.mock("dockerode", () => ({
  default: class FakeDocker {
    modem = {
      followProgress: (_stream: unknown, done: (err: null) => void) => done(null),
    };
    ping = async () => "OK";
    listNetworks = async () => [{ Name: "datapilot-net" }];
    listVolumes = async () => ({
      Volumes: [{ Name: "neo4j-data" }, { Name: "neo4j-logs" }],
    });
    listImages = async () => [];
    pull = (_tag: string, _opts: unknown, cb: (e: null, s: object) => void) =>
      cb(null, {});
    getContainer = () => ({
      inspect: async () => {
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      },
    });
    createContainer = async (config: unknown) => {
      state.created.push(config);
      return { start: async () => undefined };
    };
  },
}));

vi.mock("http", () => {
  const healthy = (_url: unknown, onResponse: (r: object) => void) => {
    onResponse({ statusCode: 200, resume: () => undefined });
    return { on: () => undefined, end: () => undefined };
  };
  return { default: { get: healthy } };
});

describe("ensureStackUp", () => {
  beforeEach(() => {
    state.created.length = 0;
    state.userData = fs.mkdtempSync(path.join(os.tmpdir(), "dp-orch-"));
  });

  afterEach(() => {
    fs.rmSync(state.userData, { recursive: true, force: true });
  });

  // Docker Desktop provides host.docker.internal; Docker Engine on Linux only
  // does with this mapping, and without it the backend cannot reach Ollama.
  it("lets the backend reach Ollama on the host on every platform", async () => {
    const { dockerOrchestrator } = await import("./dockerOrchestrator");

    await dockerOrchestrator.ensureStackUp();

    const backend = (state.created as CreatedContainer[]).find(
      (c) => c.name === "datapilot-backend",
    );
    expect(dockerOrchestrator.getStatus()).toEqual({ state: "ready" });
    expect(backend?.HostConfig.ExtraHosts).toContain(
      "host.docker.internal:host-gateway",
    );
  });

  it("gives the backend this launch's tool-endpoint token", async () => {
    const { dockerOrchestrator } = await import("./dockerOrchestrator");
    const { getMcpToken } = await import("./claudeCode/mcpToken");

    await dockerOrchestrator.ensureStackUp();

    const file = JSON.parse(
      fs.readFileSync(path.join(state.userData, "secrets", "backend-keys.json"), "utf-8"),
    );
    expect(file.mcp_token).toBe(getMcpToken());
  });

  // Neo4j reports usage to Neo4j Inc. unless told not to. docker-compose.yml
  // already turns this off, and the desktop app must match it.
  it("starts Neo4j with usage reporting and driver telemetry off", async () => {
    const { dockerOrchestrator } = await import("./dockerOrchestrator");

    await dockerOrchestrator.ensureStackUp();

    const neo4j = (state.created as CreatedContainer[]).find(
      (c) => c.name === "datapilot-neo4j",
    );
    expect(neo4j?.Env).toEqual(
      expect.arrayContaining([
        "NEO4J_dbms_usage__report_enabled=false",
        "NEO4J_server_bolt_telemetry_enabled=false",
      ]),
    );
  });
});
