import path from "node:path";

/**
 * Environment for running the user's `claude`. Copies `base` unchanged, puts the
 * folder the binary was found in first on PATH (an npm install needs its `node`
 * there), then applies `extra`. Never adds or removes credentials.
 */
export function buildClaudeEnv(
  base: NodeJS.ProcessEnv,
  binaryPath: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  const dir = path.dirname(binaryPath);
  const parts = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (!parts.includes(dir)) env.PATH = [dir, ...parts].join(path.delimiter);
  return { ...env, ...extra };
}
