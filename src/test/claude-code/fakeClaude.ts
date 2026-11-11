import fs from "node:fs";
import path from "node:path";

export const FAKE_CLAUDE = path.join(
  process.cwd(),
  "src/test/claude-code/fake-claude.mjs",
);

export interface FakeRecord {
  argv: string[];
  cwd: string;
  cwdEntries: string[];
  path: string;
  autoMemory: string | null;
  mcpDiscoveryCache: string | null;
  mcpConfig: unknown;
  mcpConfigMode: string | null;
  stdin: string | null;
  pid: number;
}

export function readFakeRecords(file: string): FakeRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeRecord);
}
