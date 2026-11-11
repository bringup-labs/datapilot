// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DockerStatus } from "@shared/ipc";

interface CreatedContainer {
  name: string;
  Env?: string[];
  HostConfig: { ExtraHosts?: string[] };
}

const state = vi.hoisted(() => ({
  created: [] as unknown[],
  userData: "",
  packaged: false,
  presentImages: [] as string[],
  pulled: [] as string[],
  pullErrors: {} as Record<string, unknown>,
  builds: [] as { args: string[]; cwd: string }[],
  buildExitCodes: {} as Record<string, number>,
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => state.userData,
    getAppPath: () => process.cwd(),
    getVersion: () => "0.0.0",
    get isPackaged() {
      return state.packaged;
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
}));

// `docker build` runs through child_process. The fake records each build and
// exits with the code the test set for that image (0 by default).
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    spawn: (_cmd: string, args: string[], opts: { cwd: string }) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      });
      state.builds.push({ args, cwd: opts.cwd });
      const tag = args[args.indexOf("-t") + 1];
      setImmediate(() => child.emit("close", state.buildExitCodes[tag] ?? 0));
      return child;
    },
  };
});

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
    listImages = async () =>
      state.presentImages.map((tag) => ({ RepoTags: [tag] }));
    pull = (tag: string, _opts: unknown, cb: (e: unknown, s?: object) => void) => {
      state.pulled.push(tag);
      const err = state.pullErrors[tag];
      return err ? cb(err) : cb(null, {});
    };
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

beforeEach(() => {
  state.created.length = 0;
  state.userData = fs.mkdtempSync(path.join(os.tmpdir(), "dp-orch-"));
  state.packaged = false;
  state.presentImages = [];
  state.pulled = [];
  state.pullErrors = {};
  state.builds = [];
  state.buildExitCodes = {};
  delete process.env.DATAPILOT_IMAGE_TAG;
});

afterEach(() => {
  fs.rmSync(state.userData, { recursive: true, force: true });
  delete process.env.DATAPILOT_IMAGE_TAG;
});

describe("ensureStackUp", () => {
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

describe("service images", () => {
  const BACKEND = "ghcr.io/bringup-labs/datapilot-backend";
  const PARSER = "ghcr.io/bringup-labs/datapilot-mcap-parser";
  const ROSBAG_READER = "ghcr.io/bringup-labs/datapilot-mcp-rosbag-reader";

  // :latest is never published, so a fresh checkout has nothing to download.
  // Development builds each missing image from docker-compose.override.yml,
  // the same settings `docker compose build` uses.
  it("builds missing service images from this checkout in development", async () => {
    const { dockerOrchestrator } = await import("./dockerOrchestrator");

    await dockerOrchestrator.ensureStackUp();

    expect(dockerOrchestrator.getStatus()).toEqual({ state: "ready" });
    expect(state.builds).toContainEqual({
      args: ["build", "-t", `${BACKEND}:latest`, "-f", "Dockerfile", "."],
      cwd: path.join(process.cwd(), "backend"),
    });
    expect(state.builds).toContainEqual({
      args: ["build", "-t", `${PARSER}:latest`, "-f", "mcap_parser/Dockerfile", "."],
      cwd: process.cwd(),
    });
    expect(state.builds).toHaveLength(7);
    expect(state.pulled).toEqual(["neo4j:5-community"]);
  });

  it("tells the setup screen it is building, since that takes minutes", async () => {
    const { dockerOrchestrator } = await import("./dockerOrchestrator");
    const steps: string[] = [];
    const stop = dockerOrchestrator.onStatusChange((s: DockerStatus) => {
      if (s.state === "pending" && s.step) steps.push(s.step);
    });

    await dockerOrchestrator.ensureStackUp();
    stop();

    expect(steps).toContain(
      "Building service images from this checkout. The first build takes several minutes…",
    );
  });

  it("neither builds nor downloads an image that is already present", async () => {
    state.presentImages = [`${BACKEND}:latest`, "neo4j:5-community"];
    const { dockerOrchestrator } = await import("./dockerOrchestrator");

    await dockerOrchestrator.ensureStackUp();

    expect(state.builds.map((b) => b.args[2])).not.toContain(`${BACKEND}:latest`);
    expect(state.builds).toHaveLength(6);
    expect(state.pulled).toEqual([]);
  });

  // An installed app has no source to build from, and its folder holds only
  // docker-compose.yml. It downloads the images published for its version.
  it("downloads the images for its version when packaged, and never builds", async () => {
    state.packaged = true;
    Object.defineProperty(process, "resourcesPath", {
      value: process.cwd(),
      configurable: true,
    });
    try {
      const { dockerOrchestrator } = await import("./dockerOrchestrator");

      await dockerOrchestrator.ensureStackUp();

      expect(state.builds).toEqual([]);
      expect(state.pulled).toContain(`${BACKEND}:0.0.0`);
      expect(state.pulled).toContain(`${PARSER}:0.0.0`);
    } finally {
      delete (process as { resourcesPath?: string }).resourcesPath;
    }
  });

  it("downloads the pinned tag instead of building when DATAPILOT_IMAGE_TAG is set", async () => {
    process.env.DATAPILOT_IMAGE_TAG = "0.2.4";
    const { dockerOrchestrator } = await import("./dockerOrchestrator");

    await dockerOrchestrator.ensureStackUp();

    expect(state.builds).toEqual([]);
    expect(state.pulled).toContain(`${BACKEND}:0.2.4`);
  });

  // The registry answers "denied" both for private images and for images that
  // were never published. The old card always named neo4j:5-community and
  // blamed the internet connection.
  it("names the image the registry refused", async () => {
    process.env.DATAPILOT_IMAGE_TAG = "0.2.4";
    state.pullErrors[`${ROSBAG_READER}:0.2.4`] = Object.assign(
      new Error(
        `(HTTP code 403) unexpected - Head "https://ghcr.io/v2/bringup-labs/datapilot-mcp-rosbag-reader/manifests/0.2.4": denied`,
      ),
      { statusCode: 403 },
    );
    const { dockerOrchestrator } = await import("./dockerOrchestrator");

    await dockerOrchestrator.ensureStackUp();

    expect(dockerOrchestrator.getStatus()).toEqual({
      state: "error",
      code: "image_pull_failed",
      message: `DataPilot couldn't download ${ROSBAG_READER}:0.2.4: the registry refused access, so the image is private or hasn't been published.`,
    });
  });

  it("names the image whose build failed and points at the build output", async () => {
    state.buildExitCodes[`${BACKEND}:latest`] = 1;
    const { dockerOrchestrator } = await import("./dockerOrchestrator");

    await dockerOrchestrator.ensureStackUp();

    expect(dockerOrchestrator.getStatus()).toEqual({
      state: "error",
      code: "image_pull_failed",
      message: `DataPilot couldn't build ${BACKEND}:latest from this checkout: docker build exited with code 1. The build output is in the terminal running pnpm dev.`,
    });
  });
});

describe("describePullFailure", () => {
  it("says the registry has no image with that tag", async () => {
    const { describePullFailure } = await import("./dockerOrchestrator");
    const err = Object.assign(new Error("manifest unknown"), { statusCode: 404 });

    expect(describePullFailure("img:1", err)).toBe(
      "DataPilot couldn't download img:1: the registry has no image with that tag.",
    );
  });

  // Docker, not DataPilot, talks to the registry, so a network failure comes
  // back as the daemon's error text.
  it("points at the connection when Docker can't reach the registry", async () => {
    const { describePullFailure } = await import("./dockerOrchestrator");
    const err = Object.assign(
      new Error(`Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host`),
      { statusCode: 500 },
    );

    expect(describePullFailure("img:1", err)).toBe(
      "DataPilot couldn't download img:1: Docker couldn't reach the registry. Check your internet connection, then retry.",
    );
  });

  it("keeps Docker's own words for anything else", async () => {
    const { describePullFailure } = await import("./dockerOrchestrator");

    expect(describePullFailure("img:1", new Error("disk full"))).toBe(
      "DataPilot couldn't download img:1: disk full",
    );
  });
});
