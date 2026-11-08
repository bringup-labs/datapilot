// @vitest-environment node
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// docker-publish.yml pushes to ghcr.io/${{ github.repository_owner }}/datapilot-*.
// The desktop app pulls by hard-coded name, so if the two drift apart a released
// app asks for images that were never published and cannot start.
const REPOSITORY_OWNER = "bringup-labs";

const FILES_WITH_IMAGE_REFS = [
  "docker-compose.yml",
  "docker-compose.override.yml",
  "src/main/dockerOrchestrator.ts",
];

function imageRefs(file: string): string[] {
  const source = fs.readFileSync(path.resolve(process.cwd(), file), "utf-8");
  return [...source.matchAll(/ghcr\.io\/[^\s"'`]+/g)].map((match) => match[0]);
}

describe("published image namespace", () => {
  it.each(FILES_WITH_IMAGE_REFS)(
    "%s pulls from the namespace CI publishes to",
    (file) => {
      const refs = imageRefs(file);

      expect(refs).toHaveLength(7);
      for (const ref of refs) {
        expect(ref.startsWith(`ghcr.io/${REPOSITORY_OWNER}/datapilot-`)).toBe(
          true,
        );
      }
    },
  );
});
