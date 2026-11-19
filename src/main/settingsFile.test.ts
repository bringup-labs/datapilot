// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseSettings } from "./settingsFile";

describe("parseSettings (#44)", () => {
  it("keeps string values as they are", () => {
    expect(parseSettings({ theme: "dark", secure_openai: "YWJj" })).toEqual({
      theme: "dark",
      secure_openai: "YWJj",
    });
  });

  it("keeps numbers and booleans as strings and drops everything else", () => {
    expect(
      parseSettings({ concurrent_workers: 4, gpu_passthrough: true, junk: { a: 1 }, gone: null, list: ["x"] }),
    ).toEqual({ concurrent_workers: "4", gpu_passthrough: "true" });
  });

  it.each([[["a"]], ["text"], [null], [7]])("rejects a file that is not an object: %j", (raw) => {
    expect(() => parseSettings(raw)).toThrow();
  });

  it("does not let a __proto__ key through", () => {
    const parsed = parseSettings(JSON.parse('{"__proto__": "x", "theme": "dark"}'));
    expect(Object.keys(parsed)).toEqual(["theme"]);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });
});
