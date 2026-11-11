import path from "node:path";
import { app } from "electron";

/**
 * Where datapilot-guide.md lives: process.resourcesPath when packaged (the
 * external `claude` cannot read inside app.asar, so electron-builder ships it
 * through extraResources), the source tree in development. Same pattern as
 * DockerOrchestrator.resolveComposePath().
 */
export function resolveGuidePath(): string {
  const name = "datapilot-guide.md";
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(app.getAppPath(), "src/main/claudeCode", name);
}
