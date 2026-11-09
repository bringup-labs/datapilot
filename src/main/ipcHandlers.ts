import {
  ipcMain,
  dialog,
  safeStorage,
  shell,
  app,
  BrowserWindow,
} from "electron";
import fs from "fs";
import path from "path";
import { dockerOrchestrator } from "./dockerOrchestrator";
import type {
  DockerStatus,
  KeychainSetResult,
  StorageUsage,
} from "@shared/ipc";
import {
  IpcValidationError,
  assertKnownService,
  assertSafeKey,
  assertSettableKey,
  assertString,
  assertSubId,
  assertTheme,
  isPathWithinRoot,
  isUnsafeOpenTarget,
} from "./ipcValidation";
import {
  decodeSecretBlob,
  encodeSecretBlob,
  type SecretCrypto,
} from "./secrets";
import { getPathUsageBounded } from "./storageUsage";

/** safeStorage adapter for the pure secret helpers (`./secrets`). */
const safeStorageCrypto: SecretCrypto = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (plaintext: string) => safeStorage.encryptString(plaintext),
  decryptString: (encrypted: Buffer) => safeStorage.decryptString(encrypted),
};

// Bound the storage:usage walk so a hostile or pathological tree can neither
// freeze the main thread nor run unbounded (#37).
const STORAGE_USAGE_MAX_DEPTH = 16;
const STORAGE_USAGE_MAX_ENTRIES = 200_000;

// Active log-stream unsubscribe callbacks, keyed by per-renderer subscription id.
const activeLogStreams = new Map<string, () => void>();

// Resolved per call, not at import time: index.ts redirects `userData` to a
// separate dev profile after this module has already been evaluated.
function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

// Simple file-backed settings store.
//
// If the settings file is unreadable or malformed, we rotate it to `.bak`
// before returning empty. Otherwise the next writeSettings() would silently
// overwrite a partially-recoverable file (including encrypted API keys) with
// just the one key the caller is setting — irreversible data loss.
function readSettings(): Record<string, string> {
  const settingsPath = getSettingsPath();
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    console.error("Failed to read settings — rotating to .bak:", err);
    try {
      fs.renameSync(settingsPath, `${settingsPath}.bak.${Date.now()}`);
    } catch (renameErr) {
      console.error("Failed to rotate corrupted settings file:", renameErr);
    }
    return {};
  }
}

// Returns true on success. Callers that must surface write failures to the
// renderer (e.g. keychain:set, #51) check the result instead of assuming the
// write succeeded.
function writeSettings(settings: Record<string, string>): boolean {
  const settingsPath = getSettingsPath();
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    // This file holds the safeStorage-encrypted `secure_*` API-key blobs, so it
    // must be owner-only like the secret file derived from it. On Linux with no
    // OS keyring, safeStorage falls back to the `basic_text` backend (whose key
    // is a well-known constant) while still reporting encryption as available —
    // a world-readable file would then be recoverable plaintext.
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    // `mode` only applies when the file is created, so chmod an existing one to
    // tighten installs upgrading from the previous default (0644).
    fs.chmodSync(settingsPath, 0o600);
    return true;
  } catch (err) {
    console.error("Failed to write settings:", err);
    return false;
  }
}

/** True when `file` resolves to somewhere inside `folder`, following symlinks. */
function isInsideFolder(file: string, folder: string): boolean {
  try {
    return isPathWithinRoot(
      fs.realpathSync(file),
      fs.realpathSync(folder),
      path.sep,
    );
  } catch {
    return false;
  }
}

function resolveUserPath(inputPath: string): string {
  if (!inputPath) return inputPath;
  if (inputPath === "~") return app.getPath("home");
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(app.getPath("home"), inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

/**
 * Validates a renderer-supplied path for `shell:openPath` (issue #27).
 *
 * The renderer only ever needs to reveal/open the user's own data: the
 * userData directory (logs/settings), the home directory, and the selected bag
 * or its containing folder (which live under home). We therefore:
 *   1. require a string,
 *   2. canonicalize it (resolve `~`, `..`, symlinks) via realpath,
 *   3. require it to exist,
 *   4. reject executable / app-bundle extensions,
 *   5. constrain it to the expected roots (userData, home).
 *
 * Returns the canonical path plus whether it is a directory; throws
 * `IpcValidationError` on any violation.
 */
function validateOpenPath(value: unknown): {
  canonicalPath: string;
  isDirectory: boolean;
} {
  const raw = assertString(value, "path");
  if (raw.length === 0) {
    throw new IpcValidationError("path must not be empty");
  }

  // Resolve `~` and relative segments first, then canonicalize through the
  // filesystem so symlinks cannot escape the allowed roots.
  const resolved = resolveUserPath(raw);

  let canonicalPath: string;
  let stats: fs.Stats;
  try {
    canonicalPath = fs.realpathSync(resolved);
    stats = fs.statSync(canonicalPath);
  } catch {
    // Non-existent path, broken symlink, or permission error — reject without
    // leaking filesystem details to the renderer.
    throw new IpcValidationError("path does not exist or is not accessible");
  }

  if (isUnsafeOpenTarget(canonicalPath)) {
    throw new IpcValidationError("refusing to open an executable path");
  }

  // Canonicalize the allowed roots too, so symlinked userData/home dirs match.
  const allowedRoots: string[] = [];
  for (const root of [app.getPath("userData"), app.getPath("home")]) {
    try {
      allowedRoots.push(fs.realpathSync(root));
    } catch {
      allowedRoots.push(path.resolve(root));
    }
  }

  const withinRoot = allowedRoots.some((root) =>
    isPathWithinRoot(canonicalPath, root, path.sep),
  );
  if (!withinRoot) {
    throw new IpcValidationError("path is outside the allowed directories");
  }

  return { canonicalPath, isDirectory: stats.isDirectory() };
}

/**
 * Computes the allow-list of roots `storage:usage` may report on (#37): the
 * app's userData dir, the default bag locations, and any user-configured cache /
 * bag-archive directories. A path outside all of these is rejected.
 */
function getStorageUsageRoots(): string[] {
  const home = app.getPath("home");
  const roots = [
    app.getPath("userData"),
    path.join(home, "datapilot", "bags"), // default bag archive root
    path.join(home, "datapilot_bags"), // default orchestrator bag dir
  ];
  const settings = readSettings();
  for (const key of ["cache_dir", "bag_archive_root"]) {
    const value = settings[key];
    if (typeof value === "string" && value.trim().length > 0) {
      roots.push(resolveUserPath(value.trim()));
    }
  }
  const envBagRoot = process.env.DATAPILOT_BAG_ROOT;
  if (envBagRoot && envBagRoot.trim().length > 0) {
    roots.push(resolveUserPath(envBagRoot.trim()));
  }
  return roots;
}

export function registerIpcHandlers(): void {
  // App version / platform (already registered in scaffold, here for completeness)
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:platform", () => process.platform);
  ipcMain.handle("app:userDataPath", () => app.getPath("userData"));
  ipcMain.handle("app:homePath", () => app.getPath("home"));

  // Docker orchestrator handlers
  ipcMain.handle("docker:status", async (): Promise<DockerStatus> => {
    return dockerOrchestrator.getStatus();
  });

  ipcMain.handle("docker:retry", async (): Promise<void> => {
    // Triggers boot in the background; updates will stream via status events
    void dockerOrchestrator.ensureStackUp();
  });

  // Stream container logs back to the requesting renderer. The renderer supplies
  // a unique `subId`; chunks arrive on `docker:logs:chunk:<subId>` and the
  // renderer calls `docker:logs:stop` with the same subId to close the stream.
  ipcMain.handle(
    "docker:logs:start",
    async (event, rawSubId: unknown, rawService: unknown): Promise<void> => {
      const subId = assertSubId(rawSubId);
      const service = assertKnownService(rawService);

      // If the renderer reuses a subId, close the prior stream first.
      activeLogStreams.get(subId)?.();
      activeLogStreams.delete(subId);

      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;

      try {
        const unsubscribe = await dockerOrchestrator.streamLogs(
          service,
          (chunk) => {
            if (!win.isDestroyed()) {
              win.webContents.send(`docker:logs:chunk:${subId}`, chunk);
            }
          },
        );

        // Close the stream automatically if the requesting window is closed.
        const cleanup = () => {
          unsubscribe();
          activeLogStreams.delete(subId);
        };
        win.once("closed", cleanup);
        activeLogStreams.set(subId, cleanup);
      } catch (err) {
        console.error(`docker:logs:start failed for ${service}:`, err);
        win.webContents.send(
          `docker:logs:chunk:${subId}`,
          `\n[stream error: ${(err as Error).message}]\n`,
        );
      }
    },
  );

  ipcMain.handle(
    "docker:logs:stop",
    async (_event, rawSubId: unknown): Promise<void> => {
      const subId = assertSubId(rawSubId);
      activeLogStreams.get(subId)?.();
      activeLogStreams.delete(subId);
    },
  );

  // File Picker.
  // Use `fromWebContents(event.sender)` rather than `getFocusedWindow()` — the
  // user can lose focus between clicking the button and the IPC arriving here,
  // which would otherwise return null or the wrong window.
  ipcMain.handle("file:pickBag", async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;

    const bagRoot = dockerOrchestrator.getBagRoot();
    const result = await dialog.showOpenDialog(win, {
      title: "Select ROS Bag File",
      defaultPath: bagRoot,
      properties: ["openFile"],
      filters: [
        {
          name: "ROS 2 Bags (*.mcap, *.db3)",
          extensions: ["mcap", "db3"],
        },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const selected = result.filePaths[0];
    if (isInsideFolder(selected, bagRoot)) {
      return selected;
    }

    // Containers can only read the bag folder (#33). Loading anything else would
    // produce an empty session that still reports itself as parsed.
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      message: "This bag is outside DataPilot's bag folder",
      detail:
        `DataPilot only reads bags from ${bagRoot}, which keeps the rest of ` +
        `your files out of reach of its containers. Move or copy ` +
        `${path.basename(selected)} there, then load it again.`,
      buttons: ["Open bag folder", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      await shell.openPath(bagRoot);
    }
    return null;
  });

  // Theme support
  ipcMain.handle(
    "theme:get",
    async (): Promise<"dark" | "light" | "system"> => {
      const settings = readSettings();
      return (settings["theme"] as "dark" | "light" | "system") || "system";
    },
  );

  ipcMain.handle(
    "theme:set",
    async (_event, rawTheme: unknown): Promise<void> => {
      const theme = assertTheme(rawTheme);
      const settings = readSettings();
      settings["theme"] = theme;
      writeSettings(settings);

      // Sync OS-level title-bar styling on macOS.
      if (process.platform === "darwin") {
        for (const win of BrowserWindow.getAllWindows()) {
          win.setWindowButtonVisibility(true);
        }
      }
    },
  );

  // Settings support
  ipcMain.handle(
    "settings:get",
    async (_event, rawKey: unknown): Promise<string | null> => {
      const key = assertSafeKey(rawKey);
      const settings = readSettings();
      return settings[key] || null;
    },
  );

  ipcMain.handle(
    "settings:set",
    async (_event, rawKey: unknown, rawValue: unknown): Promise<void> => {
      // assertSettableKey additionally rejects privileged keys (e.g.
      // docker_socket, #31) that the renderer must not be able to write.
      const key = assertSettableKey(rawKey);
      const value = assertString(rawValue, "value");
      const settings = readSettings();
      settings[key] = value;
      writeSettings(settings);
    },
  );

  // Secure keychain storage via safeStorage
  ipcMain.handle(
    "keychain:get",
    async (_event, rawKey: unknown): Promise<string | null> => {
      const key = assertSafeKey(rawKey);
      const settings = readSettings();
      const blob = settings[`secure_${key}`];
      if (!blob) return null;
      try {
        return decodeSecretBlob(blob, safeStorageCrypto);
      } catch {
        // Never log the key or the underlying error (may echo the value).
        console.error(`Failed to decrypt stored key: ${key}`);
        return null;
      }
    },
  );

  ipcMain.handle(
    "keychain:set",
    async (
      _event,
      rawKey: unknown,
      rawValue: unknown,
    ): Promise<KeychainSetResult> => {
      const key = assertSafeKey(rawKey);
      const value = assertString(rawValue, "value");
      const settings = readSettings();

      try {
        if (value === "") {
          // Clearing a key removes the stored blob entirely.
          delete settings[`secure_${key}`];
        } else {
          // encodeSecretBlob throws when encryption is unavailable rather than
          // silently persisting recoverable base64 (#40).
          settings[`secure_${key}`] = encodeSecretBlob(value, safeStorageCrypto);
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "Failed to store key",
        };
      }

      // #51: surface a write failure instead of swallowing it.
      if (!writeSettings(settings)) {
        return { ok: false, error: "Failed to write the settings file" };
      }

      // #39/#32: re-deliver keys to the backend out of band (secret file), never
      // via the renderer. Fire-and-forget; failures are logged, not fatal.
      void dockerOrchestrator.syncSecrets();
      return { ok: true };
    },
  );

  // Shell support.
  //
  // Issue #27: `shell.openPath` hands a path straight to the OS "open" handler,
  // which will happily execute scripts/apps. We canonicalize and constrain the
  // path to the user's own data roots and reject executable targets. For a file
  // we *reveal* it in its folder (showItemInFolder) rather than opening it,
  // which is the legitimate intent; directories are opened directly.
  ipcMain.handle(
    "shell:openPath",
    async (_event, rawPath: unknown): Promise<void> => {
      const { canonicalPath, isDirectory } = validateOpenPath(rawPath);
      if (isDirectory) {
        const errMessage = await shell.openPath(canonicalPath);
        if (errMessage) {
          throw new IpcValidationError(`failed to open path: ${errMessage}`);
        }
      } else {
        // Reveal the file in its containing folder instead of launching it.
        shell.showItemInFolder(canonicalPath);
      }
    },
  );

  ipcMain.handle(
    "storage:usage",
    async (_event, rawTargetPath: unknown): Promise<StorageUsage> => {
      const targetPath = assertString(rawTargetPath, "path");
      const resolvedPath = resolveUserPath(targetPath);

      // A blank path is "no directory configured", not an error — report empty
      // so the renderer's storage panel renders cleanly.
      if (!resolvedPath) {
        return {
          path: targetPath,
          resolvedPath,
          exists: false,
          totalBytes: 0,
          fileCount: 0,
        };
      }

      // #37: constrain to an allow-list of roots and walk asynchronously with
      // depth/entry caps. getPathUsageBounded throws IpcValidationError for a
      // path outside the allowed roots (rejecting renderer path-probing).
      const usage = await getPathUsageBounded(resolvedPath, {
        allowedRoots: getStorageUsageRoots(),
        maxDepth: STORAGE_USAGE_MAX_DEPTH,
        maxEntries: STORAGE_USAGE_MAX_ENTRIES,
      });

      return {
        path: targetPath,
        resolvedPath,
        exists: usage.exists,
        totalBytes: usage.totalBytes,
        fileCount: usage.fileCount,
        truncated: usage.truncated,
      };
    },
  );
}
