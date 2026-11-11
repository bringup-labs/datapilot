import { describe, it, expect } from "vitest";
import {
  IpcValidationError,
  assertSettableKey,
  assertClaudeCodeAskRequest,
  validateDockerSocket,
  extractBagPathFromArgv,
} from "./ipcValidation";

describe("assertSettableKey (#31)", () => {
  it("accepts an ordinary settings key", () => {
    expect(assertSettableKey("accent_color")).toBe("accent_color");
  });

  it("rejects the privileged docker_socket key", () => {
    expect(() => assertSettableKey("docker_socket")).toThrow(
      IpcValidationError,
    );
  });

  it("still rejects prototype-pollution keys", () => {
    expect(() => assertSettableKey("__proto__")).toThrow(IpcValidationError);
  });

  it("still rejects invalid charsets", () => {
    expect(() => assertSettableKey("bad key!")).toThrow(IpcValidationError);
  });
});

describe("validateDockerSocket (#31)", () => {
  const platformDefault = "/var/run/docker.sock";
  const allowedDirs = ["/var/run", "/run", "/Users/me/.colima/default"];

  it("returns the platform default when no override is given", () => {
    expect(
      validateDockerSocket(undefined, {
        platformDefault,
        isWindows: false,
        allowedDirs,
      }),
    ).toBe(platformDefault);
    expect(
      validateDockerSocket("", {
        platformDefault,
        isWindows: false,
        allowedDirs,
      }),
    ).toBe(platformDefault);
  });

  it("accepts an override whose directory is on the allow-list", () => {
    const override = "/Users/me/.colima/default/docker.sock";
    expect(
      validateDockerSocket(override, {
        platformDefault,
        isWindows: false,
        allowedDirs,
      }),
    ).toBe(override);
  });

  it("rejects an override outside the allow-list", () => {
    expect(() =>
      validateDockerSocket("/tmp/evil.sock", {
        platformDefault,
        isWindows: false,
        allowedDirs,
      }),
    ).toThrow(IpcValidationError);
  });

  it("rejects a non-absolute path and path traversal", () => {
    expect(() =>
      validateDockerSocket("docker.sock", {
        platformDefault,
        isWindows: false,
        allowedDirs,
      }),
    ).toThrow(IpcValidationError);
    expect(() =>
      validateDockerSocket("/var/run/../../tmp/evil.sock", {
        platformDefault,
        isWindows: false,
        allowedDirs,
      }),
    ).toThrow(IpcValidationError);
  });

  it("rejects a URL-shaped socket value", () => {
    expect(() =>
      validateDockerSocket("tcp://attacker:2375", {
        platformDefault,
        isWindows: false,
        allowedDirs,
      }),
    ).toThrow(IpcValidationError);
  });

  it("accepts the Windows named-pipe form and rejects others on Windows", () => {
    const winDefault = "\\\\.\\pipe\\docker_engine";
    expect(
      validateDockerSocket("\\\\.\\pipe\\docker_engine", {
        platformDefault: winDefault,
        isWindows: true,
        allowedDirs: [],
      }),
    ).toBe("\\\\.\\pipe\\docker_engine");
    expect(() =>
      validateDockerSocket("/var/run/docker.sock", {
        platformDefault: winDefault,
        isWindows: true,
        allowedDirs: [],
      }),
    ).toThrow(IpcValidationError);
  });
});

describe("extractBagPathFromArgv (#51)", () => {
  it("returns the first .mcap/.db3/.bag argument", () => {
    expect(
      extractBagPathFromArgv([
        "/Applications/DataPilot.app/Contents/MacOS/DataPilot",
        "/Users/me/logs/run1.mcap",
      ]),
    ).toBe("/Users/me/logs/run1.mcap");
  });

  it("recognizes .db3 and .bag case-insensitively", () => {
    expect(extractBagPathFromArgv(["app", "/x/Y.DB3"])).toBe("/x/Y.DB3");
    expect(extractBagPathFromArgv(["app", "/x/z.BAG"])).toBe("/x/z.BAG");
  });

  it("ignores flag arguments", () => {
    expect(
      extractBagPathFromArgv(["app", "--inspect", "--foo=bar.mcap"]),
    ).toBeNull();
  });

  it("returns null when no bag-like argument is present", () => {
    expect(extractBagPathFromArgv(["app", "--no-sandbox"])).toBeNull();
    expect(extractBagPathFromArgv([])).toBeNull();
  });

  it("ignores non-string entries defensively", () => {
    expect(
      extractBagPathFromArgv(["app", undefined as unknown as string, "a.bag"]),
    ).toBe("a.bag");
  });
});

describe("claude_code_path", () => {
  it("is refused from the renderer", () => {
    expect(() => assertSettableKey("claude_code_path")).toThrow(IpcValidationError);
  });
});

describe("assertClaudeCodeAskRequest", () => {
  it("accepts a valid Claude Code question", () => {
    expect(
      assertClaudeCodeAskRequest({ sessionId: "3f1c-9a_b", question: "why?", model: "sonnet", extra: 1 }),
    ).toEqual({ sessionId: "3f1c-9a_b", question: "why?", model: "sonnet" });
  });

  it.each([
    [{ sessionId: "../x", question: "q", model: "" }],
    [{ sessionId: "s".repeat(129), question: "q", model: "" }],
    [{ sessionId: "s", question: "   ", model: "" }],
    [{ sessionId: "s", question: "x".repeat(32_001), model: "" }],
    [{ sessionId: "s", question: "q", model: "claude-3" }],
    [null],
    ["s"],
  ])("rejects %j", (bad) => {
    expect(() => assertClaudeCodeAskRequest(bad)).toThrow(IpcValidationError);
  });
});
