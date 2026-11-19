/**
 * The shape of `settings.json`, shared by everything in the main process that
 * reads it (issue #44).
 *
 * Every writer stores string values, so the store is a flat string map. The
 * file is still parsed JSON from disk — hand-edited, or written by an older
 * build — so readers go through `parseSettings` instead of trusting the type.
 */
export type AppSettings = Record<string, string>;

/**
 * Narrows parsed JSON to `AppSettings`. Throws if the top level is not an
 * object, so the caller can treat the file as corrupt. Numbers and booleans are
 * kept as their string form; any other value is dropped.
 */
export function parseSettings(raw: unknown): AppSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("settings file is not a JSON object");
  }
  const settings: AppSettings = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "__proto__") continue;
    if (typeof value === "string") {
      settings[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      settings[key] = String(value);
    }
  }
  return settings;
}
