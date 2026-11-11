import { describe, it, expect } from "vitest";
import {
  SECRET_PROVIDERS,
  serializeSecretsFile,
  encodeSecretBlob,
  decodeSecretBlob,
} from "./secrets";

describe("serializeSecretsFile (#39/#32)", () => {
  it("includes only providers with a non-empty key", () => {
    const json = serializeSecretsFile({
      anthropic: "sk-ant",
      openai: "",
      google: null,
      nvidia: undefined,
    });
    expect(JSON.parse(json)).toEqual({ anthropic: "sk-ant" });
  });

  it("trims surrounding whitespace and drops whitespace-only keys", () => {
    const json = serializeSecretsFile({
      anthropic: "  sk-ant  ",
      openai: "   ",
    });
    expect(JSON.parse(json)).toEqual({ anthropic: "sk-ant" });
  });

  it("emits stable, sorted key order so the file content is deterministic", () => {
    const a = serializeSecretsFile({ openai: "b", anthropic: "a" });
    const b = serializeSecretsFile({ anthropic: "a", openai: "b" });
    expect(a).toBe(b);
  });

  it("produces valid JSON for an empty input", () => {
    expect(JSON.parse(serializeSecretsFile({}))).toEqual({});
  });

  it("exposes the canonical provider list", () => {
    expect([...SECRET_PROVIDERS]).toEqual([
      "anthropic",
      "openai",
      "google",
      "nvidia",
    ]);
  });
});

// Fake safeStorage-style crypto for deterministic, dependency-free tests.
const fakeAvailable = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`CIPHER(${s})`, "utf-8"),
  decryptString: (buf: Buffer) => {
    const raw = buf.toString("utf-8");
    const m = raw.match(/^CIPHER\((.*)\)$/);
    if (!m) throw new Error("not a cipher blob");
    return m[1];
  },
};
const fakeUnavailable = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("encryption unavailable");
  },
  decryptString: () => {
    throw new Error("encryption unavailable");
  },
};

describe("encodeSecretBlob (#40)", () => {
  it("tags an encrypted blob with the v1:enc: marker", () => {
    const blob = encodeSecretBlob("my-secret", fakeAvailable);
    expect(blob.startsWith("v1:enc:")).toBe(true);
  });

  it("refuses to persist when encryption is unavailable (no silent base64)", () => {
    expect(() => encodeSecretBlob("my-secret", fakeUnavailable)).toThrow();
  });
});

describe("decodeSecretBlob (#40)", () => {
  it("round-trips an encoded blob", () => {
    const blob = encodeSecretBlob("round-trip", fakeAvailable);
    expect(decodeSecretBlob(blob, fakeAvailable)).toBe("round-trip");
  });

  it("throws when a tagged blob cannot be decrypted (encryption unavailable)", () => {
    const blob = encodeSecretBlob("x", fakeAvailable);
    expect(() => decodeSecretBlob(blob, fakeUnavailable)).toThrow();
  });

  it("reads a legacy untagged encrypted blob when encryption is available", () => {
    const legacy = fakeAvailable.encryptString("legacy-enc").toString("base64");
    expect(decodeSecretBlob(legacy, fakeAvailable)).toBe("legacy-enc");
  });

  it("reads a legacy untagged plain-base64 blob when encryption is unavailable", () => {
    const legacy = Buffer.from("legacy-plain", "utf-8").toString("base64");
    expect(decodeSecretBlob(legacy, fakeUnavailable)).toBe("legacy-plain");
  });

  it("keeps a non-provider key such as mcp_token", () => {
    expect(JSON.parse(serializeSecretsFile({ anthropic: "", mcp_token: "abc" }))).toEqual({ mcp_token: "abc" });
  });
});
