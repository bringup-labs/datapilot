import { app, BrowserWindow, safeStorage } from "electron";
import Docker from "dockerode";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import http from "http";
import yaml from "yaml";
import type { DockerStatus, DockerErrorCode } from "@shared/ipc";
import { validateDockerSocket } from "./ipcValidation";
import {
  decodeSecretBlob,
  serializeSecretsFile,
  SECRET_PROVIDERS,
  type SecretCrypto,
} from "./secrets";
import { getMcpToken } from "./claudeCode/mcpToken";

const execAsync = promisify(exec);

/** How to build one service image from this checkout. */
interface ImageBuild {
  context: string;
  dockerfile?: string;
}

/** The `services` of a compose file, as far as building images goes. */
type ComposeServices = Record<
  string,
  { build?: string | { context?: string; dockerfile?: string } } | null | undefined
>;

/**
 * Says which image failed to download and why, in words the Setup screen
 * shows as they are. Docker, not DataPilot, talks to the registry, so the
 * reason comes from the daemon's status code and error text.
 */
export function describePullFailure(image: string, err: unknown): string {
  const e = err as
    | { statusCode?: number; message?: string; json?: { message?: string } | null }
    | undefined;
  const text = e?.json?.message ?? e?.message ?? String(err);
  const lower = text.toLowerCase();
  const prefix = `DataPilot couldn't download ${image}`;
  // A registry answers "denied" both for private images and for images that
  // were never published, and doesn't say which.
  if (e?.statusCode === 401 || e?.statusCode === 403 || /denied|unauthorized/.test(lower)) {
    return `${prefix}: the registry refused access, so the image is private or hasn't been published.`;
  }
  if (e?.statusCode === 404 || lower.includes("manifest unknown")) {
    return `${prefix}: the registry has no image with that tag.`;
  }
  if (
    /dial tcp|no such host|tls handshake|i\/o timeout|deadline exceeded|network is unreachable|connection reset/.test(
      lower,
    )
  ) {
    return `${prefix}: Docker couldn't reach the registry. Check your internet connection, then retry.`;
  }
  return `${prefix}: ${text}`;
}

class DockerOrchestrator {
  private docker: Docker;
  private socketPath: string;
  private status: DockerStatus = { state: "pending" };
  private activeContainers: string[] = [];
  private statusCallbacks: ((status: DockerStatus) => void)[] = [];

  constructor() {
    this.socketPath =
      process.platform === "win32"
        ? "\\\\.\\pipe\\docker_engine"
        : "/var/run/docker.sock";
    this.docker = new Docker({ socketPath: this.socketPath });
  }

  private getSettings(): Record<string, any> {
    const settingsPath = path.join(app.getPath("userData"), "settings.json");
    if (!fs.existsSync(settingsPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      return {};
    }
  }

  private getCrypto(): SecretCrypto {
    return {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plaintext: string) =>
        safeStorage.encryptString(plaintext),
      decryptString: (encrypted: Buffer) =>
        safeStorage.decryptString(encrypted),
    };
  }

  private getSecureKey(key: string): string | null {
    const settings = this.getSettings();
    const blob = settings[`secure_${key}`];
    if (typeof blob !== "string" || !blob) return null;
    try {
      return decodeSecretBlob(blob, this.getCrypto());
    } catch {
      // Never log the key or the underlying error (may echo the value).
      console.error(`Failed to decrypt stored key: ${key}`);
      return null;
    }
  }

  private initDocker() {
    const isWindows = process.platform === "win32";
    const platformDefault = isWindows
      ? "\\\\.\\pipe\\docker_engine"
      : "/var/run/docker.sock";

    // Issue #31: the Docker socket is a root-equivalent capability, so it is NOT
    // read from renderer-writable settings (that key is rejected by
    // `assertSettableKey`). The only override is a trusted env var, and even
    // that is validated so a bad value cannot repoint the daemon connection.
    const home = app.getPath("home");
    const allowedDirs = isWindows
      ? []
      : [
          "/var/run",
          "/run",
          path.join(home, ".docker"),
          path.join(home, ".docker", "run"),
          path.join(home, ".colima", "default"),
          path.join(home, ".rd"),
          path.join(home, ".lima", "default", "sock"),
        ];
    try {
      this.socketPath = validateDockerSocket(
        process.env.DATAPILOT_DOCKER_SOCKET,
        { platformDefault, isWindows, allowedDirs },
      );
    } catch (err) {
      console.error(
        "Ignoring invalid DATAPILOT_DOCKER_SOCKET; using platform default:",
        err instanceof Error ? err.message : err,
      );
      this.socketPath = platformDefault;
    }
    this.docker = new Docker({ socketPath: this.socketPath });
  }

  // --- API key secret file (issues #39, #32) ------------------------------
  //
  // Decrypted keys are written to a mode-0600 host file that is bind-mounted
  // read-only into the backend container, instead of being injected via `Env`
  // (readable through `docker inspect`) or POSTed from the renderer over plain
  // HTTP. The backend reads this path at startup and on /settings/reload-secrets.

  private static readonly SECRETS_CONTAINER_PATH =
    "/run/datapilot/secrets/backend-keys.json";

  private getSecretsHostPath(): string {
    return path.join(app.getPath("userData"), "secrets", "backend-keys.json");
  }

  /**
   * Writes the current provider keys (from safeStorage) to the mode-0600 host
   * secret file and returns its path. Always writes a file (possibly `{}`) so
   * the read-only bind mount has a real file to target. Never logs key values.
   */
  private writeSecretsFile(): string {
    const keys: Record<string, string | null> = {};
    for (const provider of SECRET_PROVIDERS) {
      keys[provider] = this.getSecureKey(provider);
    }
    keys.mcp_token = getMcpToken();
    const hostPath = this.getSecretsHostPath();
    fs.mkdirSync(path.dirname(hostPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(hostPath, serializeSecretsFile(keys), { mode: 0o600 });
    try {
      // writeFileSync only applies `mode` on creation; enforce on rewrite too.
      fs.chmodSync(hostPath, 0o600);
    } catch {
      /* best-effort on filesystems without POSIX modes (e.g. Windows) */
    }
    return hostPath;
  }

  /**
   * Rewrites the secret file and asks a running backend to re-read it, so a key
   * the user changes mid-session takes effect without a restart — and without
   * the key ever crossing the renderer→HTTP boundary. Best-effort.
   */
  public async syncSecrets(): Promise<void> {
    try {
      this.writeSecretsFile();
    } catch (err) {
      console.error("Failed to write backend secret file:", err);
      return;
    }
    await this.pingReloadSecrets();
  }

  private pingReloadSecrets(): Promise<void> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: 8000,
          path: "/api/settings/reload-secrets",
          method: "POST",
          timeout: 3000,
        },
        (res) => {
          res.resume();
          res.on("end", resolve);
          res.on("error", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.on("timeout", () => {
        req.destroy();
        resolve();
      });
      req.end();
    });
  }

  private resolveHostPath(inputPath: string): string {
    if (inputPath === "~") return app.getPath("home");
    if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
      return path.join(app.getPath("home"), inputPath.slice(2));
    }
    if (path.isAbsolute(inputPath)) return inputPath;
    return path.resolve(app.getPath("home"), inputPath);
  }

  private getBackendDataMountDir(): string {
    const settings = this.getSettings();
    const configured = settings["cache_dir"];
    if (typeof configured === "string" && configured.trim().length > 0) {
      return this.resolveHostPath(configured.trim());
    }
    return app.getPath("userData");
  }

  /**
   * Default name of the dedicated, in-home directory that holds rosbags when the
   * user has not configured `DATAPILOT_BAG_ROOT`. Living under `$HOME` (rather
   * than being `$HOME` itself) is what lets us mount a single narrow directory
   * while keeping the backend's host→container path translation intact.
   */
  private static readonly DEFAULT_BAG_DIR = "datapilot_bags";

  /**
   * Computes the single host directory that containers may read bags from, plus
   * the path it must appear at *inside* the container.
   *
   * Security (#33): we deliberately do NOT bind-mount all of `$HOME`. A whole-home
   * mount exposes SSH keys, `.aws`, browser profiles and unrelated projects to
   * every backend/worker container — a least-privilege violation. Instead we mount
   * one bags directory, read-only.
   *
   * Trade-off / why a root (not the selected bag's parent): `ensureStackUp()` boots
   * the stack at app launch, before any bag is picked (the renderer sends the bag
   * path to the backend over HTTP at ingestion time, not through this orchestrator,
   * and the IPC contract is out of scope to change here). So the directory to mount
   * is not yet known when the stack first starts, and we mount a configurable bags
   * root instead of the whole home.
   *
   * Container-path contract: `backend/app/services/parser.py:_resolve_path` (which
   * is out of scope to edit) translates a host path `/Users|home/<user>/<rel...>`
   * to `${DATAPILOT_HOST_MOUNT}/<rel...>` by stripping the first three path
   * segments and re-rooting the remainder under the mount point. For that to keep
   * resolving, a bags root that lives under `$HOME` must be mounted at
   * `${HOST_MOUNT}/<root-relative-to-home>` (e.g. `$HOME/datapilot_bags` →
   * `/host/datapilot_bags`), NOT flatly at `/host`. We therefore return a target
   * that preserves the home-relative suffix whenever the root is inside `$HOME`.
   *
   * If `DATAPILOT_BAG_ROOT` points *outside* `$HOME`, the current backend
   * translation cannot map it (it only rewrites home-rooted paths); we still mount
   * it (read-only) at `${HOST_MOUNT}` as a best effort and log a warning, but the
   * supported, translation-safe configuration is a directory under `$HOME`.
   */
  private getBagMount(): { hostDir: string; containerDir: string } {
    const home = app.getPath("home");
    const hostMount = "/host";

    const configured = process.env.DATAPILOT_BAG_ROOT?.trim();
    const hostDir =
      configured && configured.length > 0
        ? this.resolveHostPath(configured)
        : path.join(home, DockerOrchestrator.DEFAULT_BAG_DIR);

    // Where the bags root sits relative to $HOME decides the in-container target,
    // so that parser.py's `${HOST_MOUNT}/<home-relative-suffix>` translation lands
    // on this mount.
    const relativeToHome = path.relative(home, hostDir);
    const isInsideHome =
      relativeToHome.length > 0 &&
      !relativeToHome.startsWith("..") &&
      !path.isAbsolute(relativeToHome);

    if (!isInsideHome) {
      console.warn(
        `DATAPILOT_BAG_ROOT (${hostDir}) is not inside the home directory; ` +
          `the backend path translation only rewrites home-rooted paths, so ` +
          `bag resolution may fail. Prefer a directory under ${home}.`,
      );
      return { hostDir, containerDir: hostMount };
    }

    // Normalize to POSIX separators for the in-container path (containers are Linux
    // even when the host is Windows).
    const containerDir = path.posix.join(
      hostMount,
      relativeToHome.split(path.sep).join(path.posix.sep),
    );
    return { hostDir, containerDir };
  }

  /** The one host folder containers can read bags from (see getBagMount). */
  public getBagRoot(): string {
    return this.getBagMount().hostDir;
  }

  public getStatus(): DockerStatus {
    return this.status;
  }

  public onStatusChange(callback: (status: DockerStatus) => void) {
    this.statusCallbacks.push(callback);
    return () => {
      this.statusCallbacks = this.statusCallbacks.filter((cb) => cb !== callback);
    };
  }

  private setStatus(status: DockerStatus) {
    this.status = status;
    // Emit status change to all renderer windows
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("docker:status-changed", status);
    }
    // Notify local main process listeners (copy array to guard against mid-iteration unsubscribes)
    for (const cb of [...this.statusCallbacks]) {
      try {
        cb(status);
      } catch (err) {
        console.error("Error in Docker status change callback:", err);
      }
    }
  }

  /**
   * Verifies connection to the Docker daemon.
   */
  public async verifySocket(): Promise<boolean> {
    this.initDocker();
    try {
      await this.docker.ping();
      return true;
    } catch (err: any) {
      console.error("Docker ping failed:", err);
      let code: DockerErrorCode = "unknown";
      let message = err.message || "Unknown Docker error";

      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        code = "daemon_off";
        message =
          "Docker Desktop is not running. Please open Docker Desktop and try again.";
      } else if (err.code === "EACCES") {
        code = "permission_denied";
        message =
          "Permission denied accessing Docker socket. Ensure user has appropriate permissions.";
      }
      this.setStatus({ state: "error", code, message });
      return false;
    }
  }

  /**
   * Resolves docker-compose.yml for both dev (repo root via app.getAppPath())
   * and packaged builds (process.resourcesPath via electron-builder extraResources).
   */
  private resolveComposePath(): string {
    const candidates = app.isPackaged
      ? [
          path.join(process.resourcesPath, "docker-compose.yml"),
          path.join(app.getAppPath(), "docker-compose.yml"),
        ]
      : [path.join(app.getAppPath(), "docker-compose.yml")];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(
      `docker-compose.yml not found. Searched: ${candidates.join(", ")}`,
    );
  }

  /**
   * Resolves a build context path from a docker-compose service definition,
   * accounting for asar-packaged builds where source dirs live next to the asar
   * inside extraResources rather than inside app.getAppPath().
   */
  private resolveBuildContext(buildRef: string): string {
    if (path.isAbsolute(buildRef)) return buildRef;
    const composeDir = path.dirname(this.resolveComposePath());
    return path.resolve(composeDir, buildRef);
  }

  private getComposeData(): any {
    const composePath = this.resolveComposePath();
    const fileContent = fs.readFileSync(composePath, "utf-8");
    return yaml.parse(fileContent);
  }

  /**
   * Ensures the DataPilot network exists.
   */
  public async ensureNetwork(): Promise<void> {
    const networks = await this.docker.listNetworks();
    const exists = networks.some((n) => n.Name === "datapilot-net");
    if (!exists) {
      await this.docker.createNetwork({
        Name: "datapilot-net",
        Driver: "bridge",
      });
    }
  }

  /**
   * Ensures all DataPilot volumes exist.
   */
  public async ensureVolumes(): Promise<void> {
    const result = await this.docker.listVolumes();
    const volumes = result.Volumes || [];
    const requiredVolumes = ["neo4j-data", "neo4j-logs"];
    for (const vol of requiredVolumes) {
      if (!volumes.some((v) => v.Name === vol)) {
        await this.docker.createVolume({ Name: vol });
      }
    }
  }

  /**
   * Resolves the correct image tag for a DataPilot service image.
   * If `DATAPILOT_IMAGE_TAG` is set, it overrides the tag in dev and packaged mode.
   * If packaged and no override is set, tags with the app version (e.g. "1.2.3").
   * If unpackaged and no override is set, defaults to keeping the tag as defined.
   */
  private resolveImageTag(imageName: string): string {
    if (imageName.includes("datapilot")) {
      const lastColon = imageName.lastIndexOf(":");
      const baseImage = lastColon !== -1 ? imageName.slice(0, lastColon) : imageName;
      const overrideTag = process.env.DATAPILOT_IMAGE_TAG?.trim();
      if (overrideTag && overrideTag.length > 0) {
        return `${baseImage}:${overrideTag}`;
      }
      if (app.isPackaged) {
        return `${baseImage}:${app.getVersion()}`;
      }
    }
    return imageName;
  }

  /**
   * In development, how to build each service image from this checkout. The
   * settings come from docker-compose.override.yml, the file `docker compose
   * build` also reads, and from any `build` in docker-compose.yml. A packaged
   * app has no source to build from, and a run pinned to published images
   * with DATAPILOT_IMAGE_TAG downloads them, so neither builds.
   */
  private getDevBuilds(composeData: {
    services?: ComposeServices;
  }): Record<string, ImageBuild> {
    if (app.isPackaged || process.env.DATAPILOT_IMAGE_TAG?.trim()) return {};
    const builds: Record<string, ImageBuild> = {};
    const add = (services: ComposeServices | undefined) => {
      for (const [name, service] of Object.entries(services ?? {})) {
        const build = service?.build;
        if (typeof build === "string") {
          builds[name] = { context: build };
        } else if (build) {
          builds[name] = { context: build.context ?? ".", dockerfile: build.dockerfile };
        }
      }
    };
    add(composeData.services);
    const overridePath = path.join(
      path.dirname(this.resolveComposePath()),
      "docker-compose.override.yml",
    );
    if (fs.existsSync(overridePath)) {
      add(yaml.parse(fs.readFileSync(overridePath, "utf-8"))?.services);
    }
    return builds;
  }

  /**
   * Ensures every service image exists, in parallel. In development a missing
   * image is built from this checkout, since `:latest` is never published;
   * otherwise it is downloaded.
   */
  public async ensureImages(): Promise<void> {
    const composeData = this.getComposeData();
    const devBuilds = this.getDevBuilds(composeData);
    const images = await this.docker.listImages();
    const existingTags = images.flatMap((img) => img.RepoTags || []);
    const jobs: Promise<void>[] = [];
    let building = false;

    for (const [serviceName, service] of Object.entries<any>(
      composeData.services,
    )) {
      const rawImageTag = service.image;
      if (!rawImageTag) continue;
      const imageTag = this.resolveImageTag(rawImageTag);

      if (existingTags.includes(imageTag)) {
        console.log(`Image ${imageTag} is already present.`);
        continue;
      }

      const build = devBuilds[serviceName];
      if (build) {
        building = true;
        jobs.push(this.buildImage(serviceName, imageTag, build));
      } else {
        jobs.push(this.pullImage(serviceName, imageTag));
      }
    }

    if (building) {
      this.setStatus({
        state: "pending",
        progress: 30,
        step: "Building service images from this checkout. The first build takes several minutes…",
      });
    }
    await Promise.all(jobs);
  }

  /** Builds one image with `docker build`, streaming its output to the terminal. */
  private buildImage(
    serviceName: string,
    imageTag: string,
    build: ImageBuild,
  ): Promise<void> {
    const failure = (reason: string) =>
      Object.assign(
        new Error(`DataPilot couldn't build ${imageTag} from this checkout: ${reason}`),
        { dpCode: "image_pull_failed" as DockerErrorCode },
      );
    const context = this.resolveBuildContext(build.context);
    if (!fs.existsSync(context)) {
      return Promise.reject(failure(`its build folder ${context} doesn't exist.`));
    }

    console.log(`Building image for service: ${serviceName} (${imageTag})...`);
    const args = [
      "build",
      "-t",
      imageTag,
      ...(build.dockerfile ? ["-f", build.dockerfile] : []),
      ".",
    ];
    return new Promise<void>((resolve, reject) => {
      const child = spawn("docker", args, { cwd: context });

      child.stdout?.on("data", (data: Buffer) => {
        process.stdout.write(`[build:${serviceName}] ${data.toString()}`);
      });
      child.stderr?.on("data", (data: Buffer) => {
        process.stderr.write(`[build:${serviceName}] ${data.toString()}`);
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            failure(
              `docker build exited with code ${code}. The build output is in the terminal running pnpm dev.`,
            ),
          );
        }
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        reject(
          failure(err.code === "ENOENT" ? "the docker command isn't on PATH." : err.message),
        );
      });
    });
  }

  /** Downloads one image, logging Docker's progress to the terminal. */
  private pullImage(serviceName: string, imageTag: string): Promise<void> {
    console.log(`Pulling remote image: ${imageTag}...`);
    const failure = (err: unknown) =>
      Object.assign(new Error(describePullFailure(imageTag, err)), {
        cause: err,
        dpCode: "image_pull_failed" as DockerErrorCode,
      });
    return new Promise<void>((resolve, reject) => {
      this.docker.pull(imageTag, {}, (err: any, stream: any) => {
        if (err) return reject(failure(err));
        this.docker.modem.followProgress(
          stream,
          (err2: any) => (err2 ? reject(failure(err2)) : resolve()),
          (event: any) => {
            if (event.status) {
              process.stdout.write(
                `[pull:${serviceName}] ${event.status} ${event.progress || ""}\n`,
              );
            }
          },
        );
      });
    });
  }

  /**
   * Maps a dockerode/spawn error to a DockerErrorCode.
   * Errors annotated with `.dpCode` (by ensureImages, startContainer etc.) win;
   * otherwise we inspect the message + statusCode heuristically.
   */
  private classifyError(err: any): { code: DockerErrorCode; message: string } {
    if (err?.dpCode) {
      return { code: err.dpCode, message: err.message || String(err) };
    }
    const raw: string = (
      err?.message ||
      err?.json?.message ||
      String(err) ||
      ""
    ).toLowerCase();
    if (
      raw.includes("port is already allocated") ||
      raw.includes("address already in use")
    ) {
      return {
        code: "port_conflict",
        message:
          "A required port (7474, 7687, or 8000) is already in use by another process. " +
          "Stop the conflicting service and retry.",
      };
    }
    if (
      raw.includes("manifest unknown") ||
      raw.includes("pull access denied") ||
      raw.includes("no such image") ||
      raw.includes("error response from daemon: failed to pull")
    ) {
      return {
        code: "image_pull_failed",
        message:
          err?.message ||
          "Docker was unable to pull or build one of the required images.",
      };
    }
    if (err?.code === "EACCES") {
      return {
        code: "permission_denied",
        message: "Permission denied accessing the Docker socket.",
      };
    }
    if (err?.code === "ENOENT" || err?.code === "ECONNREFUSED") {
      return {
        code: "daemon_off",
        message:
          "Docker Desktop is not running. Open Docker Desktop and retry.",
      };
    }
    return { code: "unknown", message: err?.message || String(err) };
  }

  /**
   * Polls a URL until it responds with a 200 status code.
   * Calls `response.resume()` so the socket is released back to the agent
   * pool — otherwise the unconsumed response body keeps it open and we
   * eventually exhaust the agent's connection limit.
   */
  private async pollLiveness(url: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await new Promise<number>((resolve, reject) => {
          const req = http.get(url, (response) => {
            response.resume(); // drain & free the socket
            resolve(response.statusCode || 0);
          });
          req.on("error", reject);
          req.end();
        });
        if (res === 200) {
          return true;
        }
      } catch {
        // Ignore and retry
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  /**
   * Boots the full Docker stack.
   */
  public async ensureStackUp(): Promise<void> {
    this.initDocker();
    const wasDaemonOff =
      this.status.state === "error" && this.status.code === "daemon_off";
    this.setStatus({
      state: "pending",
      progress: 5,
      step: "Verifying Docker socket…",
    });

    if (wasDaemonOff && process.platform === "darwin") {
      console.log("Attempting to open Docker Desktop on macOS...");
      this.setStatus({
        state: "pending",
        progress: 10,
        step: "Launching Docker Desktop…",
      });
      try {
        await execAsync("open -a Docker");
        // Wait 4s for daemon boot sequence
        await new Promise((r) => setTimeout(r, 4000));
      } catch (err) {
        console.error("Failed to open Docker Desktop:", err);
      }
    }

    const isDockerReady = await this.verifySocket();
    if (!isDockerReady) {
      return;
    }

    try {
      console.log("Ensuring Docker network...");
      this.setStatus({
        state: "pending",
        progress: 15,
        step: "Ensuring Docker network…",
      });
      await this.ensureNetwork();

      console.log("Ensuring Docker volumes...");
      this.setStatus({
        state: "pending",
        progress: 20,
        step: "Ensuring Docker volumes…",
      });
      await this.ensureVolumes();

      console.log("Ensuring Docker images (build/pull)...");
      this.setStatus({
        state: "pending",
        progress: 30,
        step: "Pulling and building images…",
      });
      await this.ensureImages();

      const dataMountDir = this.getBackendDataMountDir();
      fs.mkdirSync(dataMountDir, { recursive: true });

      // Scope container access to a single bags directory instead of all of $HOME
      // (#33). `bagBind` is the read-only host→container bind every bag-reading
      // container shares. We create the host dir so the mount target exists even
      // before the user drops bags into it.
      const bagMount = this.getBagMount();
      try {
        fs.mkdirSync(bagMount.hostDir, { recursive: true });
      } catch (err) {
        console.warn(
          `Could not create bag mount directory ${bagMount.hostDir}:`,
          err,
        );
      }
      const bagBind = `${bagMount.hostDir}:${bagMount.containerDir}:ro`;

      // Start services in order: Neo4j -> FastAPI Backend -> 5 workers
      console.log("Starting Neo4j...");
      this.setStatus({
        state: "pending",
        progress: 50,
        step: "Starting Neo4j container…",
      });
      await this.startContainer("neo4j", {
        Image: "neo4j:5-community",
        Env: [
          "NEO4J_AUTH=neo4j/datapilot-local",
          'NEO4J_PLUGINS=["apoc"]',
          "NEO4J_dbms_security_procedures_unrestricted=apoc.*",
          // Same as docker-compose.yml: send nothing to Neo4j Inc.
          "NEO4J_dbms_usage__report_enabled=false",
          "NEO4J_server_bolt_telemetry_enabled=false",
        ],
        HostConfig: {
          PortBindings: {
            "7474/tcp": [{ HostPort: "7474" }],
            "7687/tcp": [{ HostPort: "7687" }],
          },
          Binds: ["neo4j-data:/data", "neo4j-logs:/logs"],
          NetworkMode: "datapilot-net",
        },
      });

      // Wait for Neo4j liveness check
      console.log("Waiting for Neo4j to become healthy...");
      this.setStatus({
        state: "pending",
        progress: 60,
        step: "Waiting for Neo4j database to start…",
      });
      const neo4jHealthy = await this.pollLiveness(
        "http://localhost:7474",
        30000,
      );
      if (!neo4jHealthy) {
        throw new Error(
          "Neo4j database failed to become healthy within 30 seconds.",
        );
      }

      // Start MCAP parser service before the backend (backend calls it during ingestion).
      console.log("Starting MCAP Parser...");
      this.setStatus({
        state: "pending",
        progress: 70,
        step: "Starting MCAP Parser service…",
      });
      await this.startContainer("mcap-parser", {
        Image: this.resolveImageTag("ghcr.io/bringup-labs/datapilot-mcap-parser:latest"),
        Env: ["DATAPILOT_HOST_MOUNT=/host"],
        HostConfig: {
          Binds: [bagBind],
          NetworkMode: "datapilot-net",
        },
      });
      // No health poll — backend falls back to inline parser if still initializing.

      console.log("Starting FastAPI Backend...");
      this.setStatus({
        state: "pending",
        progress: 75,
        step: "Starting FastAPI Backend container…",
      });

      // Issues #39 / #32: deliver API keys via a bind-mounted, mode-0600 secret
      // file the backend reads at startup — NOT via `Env` (readable through
      // `docker inspect` / /proc/<pid>/environ) and NOT via a renderer→HTTP POST.
      const secretsHostPath = this.writeSecretsFile();

      const backendEnv = [
        "NEO4J_URI=bolt://datapilot-neo4j:7687",
        "NEO4J_USER=neo4j",
        "NEO4J_PASSWORD=datapilot-local",
        "DATAPILOT_HOST_MOUNT=/host",
        "DATAPILOT_DATA_DIR=/data",
        "MCAP_PARSER_URL=http://datapilot-mcap-parser:8100",
        // in_process: tools are called directly in the backend process — no
        // subprocess overhead. Workers still run to serve their /health endpoints.
        "DATAPILOT_MCP_TRANSPORT=in_process",
        // Path (not a secret) the backend reads keys from.
        `DATAPILOT_SECRETS_FILE=${DockerOrchestrator.SECRETS_CONTAINER_PATH}`,
      ];

      await this.startContainer("backend", {
        Image: this.resolveImageTag("ghcr.io/bringup-labs/datapilot-backend:latest"),
        Env: backendEnv,
        HostConfig: {
          PortBindings: {
            "8000/tcp": [{ HostPort: "8000" }],
          },
          Binds: [
            `${dataMountDir}:/data`,
            bagBind, // Read-only mount of the scoped bags directory (#33)
            // Read-only secret file (#39/#32).
            `${secretsHostPath}:${DockerOrchestrator.SECRETS_CONTAINER_PATH}:ro`,
          ],
          // Docker Engine on Linux has no host.docker.internal by default, and
          // the backend reaches Ollama on the host through that name.
          ExtraHosts: ["host.docker.internal:host-gateway"],
          NetworkMode: "datapilot-net",
        },
      });

      // Wait for FastAPI backend liveness check
      console.log("Waiting for Backend to become healthy...");
      this.setStatus({
        state: "pending",
        progress: 85,
        step: "Waiting for Backend API to start…",
      });
      const backendHealthy = await this.pollLiveness(
        "http://localhost:8000/health",
        60000,
      );
      if (!backendHealthy) {
        throw new Error(
          "FastAPI backend failed to become healthy within 60 seconds.",
        );
      }

      // Start the 5 MCP Workers in parallel
      console.log("Starting MCP workers...");
      this.setStatus({
        state: "pending",
        progress: 90,
        step: "Starting MCP worker nodes…",
      });
      const neo4jEnv = [
        "NEO4J_URI=bolt://datapilot-neo4j:7687",
        "NEO4J_USER=neo4j",
        "NEO4J_PASSWORD=datapilot-local",
      ];
      const workers = [
        {
          name: "rosbag-reader",
          image: this.resolveImageTag("ghcr.io/bringup-labs/datapilot-mcp-rosbag-reader:latest"),
          binds: [bagBind],
          env: ["DATAPILOT_HOST_MOUNT=/host", ...neo4jEnv],
        },
        {
          name: "trajectory-analyzer",
          image: this.resolveImageTag("ghcr.io/bringup-labs/datapilot-mcp-trajectory-analyzer:latest"),
          binds: [bagBind],
          env: ["DATAPILOT_HOST_MOUNT=/host", ...neo4jEnv],
        },
        {
          name: "planner-failure-inspector",
          image: this.resolveImageTag("ghcr.io/bringup-labs/datapilot-mcp-planner-failure-inspector:latest"),
          binds: [],
          env: [...neo4jEnv],
        },
        {
          name: "anomaly-detector",
          image: this.resolveImageTag("ghcr.io/bringup-labs/datapilot-mcp-anomaly-detector:latest"),
          binds: [bagBind],
          env: ["DATAPILOT_HOST_MOUNT=/host", ...neo4jEnv],
        },
        {
          name: "report-composer",
          image: this.resolveImageTag("ghcr.io/bringup-labs/datapilot-mcp-report-composer:latest"),
          binds: [],
          env: [...neo4jEnv],
        },
      ];

      await Promise.all(
        workers.map(async (worker) => {
          await this.startContainer(worker.name, {
            Image: worker.image,
            Env: worker.env,
            HostConfig: {
              Binds: worker.binds,
              NetworkMode: "datapilot-net",
            },
          });
        }),
      );

      console.log("All stack components started successfully.");
      this.setStatus({ state: "ready" });
    } catch (err: any) {
      console.error("Stack boot failed:", err);
      const { code, message } = this.classifyError(err);
      this.setStatus({
        state: "error",
        code,
        // Image failures are written for the Setup screen, which shows them as they are.
        message: code === "image_pull_failed" ? message : `Stack boot failed: ${message}`,
      });
    }
  }

  /**
   * Helper to create and start a container, managing existing ones if needed.
   */
  private async startContainer(serviceName: string, config: any): Promise<any> {
    const containerName = `datapilot-${serviceName}`;
    const container = this.docker.getContainer(containerName);

    try {
      const info = await container.inspect();
      if (info.State.Running) {
        console.log(`Container ${containerName} is already running.`);
        if (!this.activeContainers.includes(containerName)) {
          this.activeContainers.push(containerName);
        }
        return container;
      }
      console.log(
        `Container ${containerName} exists but is not running. Starting...`,
      );
      await container.start();
      if (!this.activeContainers.includes(containerName)) {
        this.activeContainers.push(containerName);
      }
      return container;
    } catch (err: any) {
      if (err.statusCode !== 404) {
        throw err;
      }
    }

    // Configure network alias to match service name (e.g. 'neo4j', 'backend')
    const finalConfig = {
      ...config,
      name: containerName,
      NetworkingConfig: {
        EndpointsConfig: {
          "datapilot-net": {
            Aliases: [serviceName],
          },
        },
      },
    };

    console.log(`Creating container ${containerName}...`);
    try {
      const newContainer = await this.docker.createContainer(finalConfig);
      await newContainer.start();
      if (!this.activeContainers.includes(containerName)) {
        this.activeContainers.push(containerName);
      }
      return newContainer;
    } catch (err: any) {
      // Tag port-bind / create errors so classifyError can route them to the
      // right Setup pane. Docker daemon reports port conflicts via 500-status
      // responses with messages like "port is already allocated".
      const msg = (err?.message || err?.json?.message || "").toLowerCase();
      if (
        msg.includes("port is already allocated") ||
        msg.includes("address already in use")
      ) {
        throw Object.assign(err, {
          dpCode: "port_conflict" as DockerErrorCode,
        });
      }
      throw err;
    }
  }

  /**
   * Streams logs from a running container. Returns an unsubscribe function
   * that aborts the stream. `onChunk` is called per (newline-terminated)
   * batch of stdout/stderr output. Used by Settings → Docker (Phase 11) and
   * during development for debugging the stack.
   */
  public async streamLogs(
    serviceOrContainer: string,
    onChunk: (chunk: string) => void,
  ): Promise<() => void> {
    // Accept either a bare service name ("backend") or the prefixed container
    // name ("datapilot-backend"). Normalize.
    const containerName = serviceOrContainer.startsWith("datapilot-")
      ? serviceOrContainer
      : `datapilot-${serviceOrContainer}`;
    const container = this.docker.getContainer(containerName);

    const stream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 200,
      timestamps: false,
    });

    let cancelled = false;
    // Docker multiplexes stdout+stderr with an 8-byte header per frame when
    // TTY isn't allocated. TCP does NOT preserve message boundaries — any given
    // `data` event may carry a partial header or a partial payload, so we have
    // to accumulate across events and only emit complete frames.
    let logBuffer = Buffer.alloc(0);
    const onData = (buf: Buffer) => {
      if (cancelled) return;
      logBuffer = Buffer.concat([logBuffer, buf]);
      while (logBuffer.length >= 8) {
        // bytes 4..8 = big-endian payload length
        const len = logBuffer.readUInt32BE(4);
        if (logBuffer.length < 8 + len) break; // wait for the rest of the payload
        const payload = logBuffer.subarray(8, 8 + len);
        if (payload.length > 0) onChunk(payload.toString("utf-8"));
        logBuffer = logBuffer.subarray(8 + len);
      }
    };

    (stream as NodeJS.ReadableStream).on("data", onData);

    return () => {
      cancelled = true;
      try {
        (
          stream as NodeJS.ReadableStream & { destroy?: () => void }
        ).destroy?.();
      } catch {
        // already torn down
      }
    };
  }

  /**
   * Tears down the full Docker stack.
   */
  public async ensureStackDown(): Promise<void> {
    console.log("Tearing down DataPilot Docker stack...");
    const composeData = this.getComposeData();
    const containerNames = Object.keys(composeData.services).map(
      (name) => `datapilot-${name}`,
    );

    await Promise.all(
      containerNames.map(async (name) => {
        const container = this.docker.getContainer(name);
        try {
          console.log(`Stopping container ${name}...`);
          await container.stop({ t: 2 }); // Fast SIGTERM with 2s grace
        } catch (err: any) {
          // Ignore if already stopped (304) or not found (404)
          if (err.statusCode !== 304 && err.statusCode !== 404) {
            console.warn(`Failed to stop container ${name}:`, err.message);
          }
        }

        try {
          console.log(`Removing container ${name}...`);
          await container.remove({ force: true });
        } catch (err: any) {
          if (err.statusCode !== 404) {
            console.warn(`Failed to remove container ${name}:`, err.message);
          }
        }
      }),
    );

    this.activeContainers = [];
    this.setStatus({ state: "pending" });
  }
}

export const dockerOrchestrator = new DockerOrchestrator();
