import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TokenSipApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  base32Decode,
  base32Encode,
  generateVirtualKey,
  hashPassword,
  totpCode,
  Vault,
  verifyPassword,
  verifyTotp,
} from "../src/crypto.js";

describe("Vault", () => {
  it("round-trips and uses a fresh IV every time", () => {
    const v = Vault.fromSecret("a".repeat(64));
    const a = v.encryptString("sk-secret");
    const b = v.encryptString("sk-secret");
    expect(a).not.toBe(b);
    expect(v.decryptString(a)).toBe("sk-secret");
  });

  it("rejects tampered ciphertext and wrong keys", () => {
    const v = Vault.fromSecret("correct horse battery staple");
    const blob = v.encrypt("hello");
    blob[blob.length - 1] = (blob[blob.length - 1] as number) ^ 1;
    expect(() => v.decrypt(blob)).toThrow();
    expect(() => Vault.fromSecret("other passphrase").decryptString(v.encryptString("x"))).toThrow();
  });

  it("creates master.key with owner-only permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsip-"));
    try {
      const { source } = Vault.load(dir);
      expect(source).toBe("generated");
      if (process.platform !== "win32") expect(statSync(join(dir, "master.key")).mode & 0o777).toBe(0o600);
      expect(Vault.load(dir).source).toBe("file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to open a data directory with a different master key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tsip-"));
    try {
      const app = await TokenSipApp.create(loadConfig({ dataDir: dir, secret: "first secret value" }, {}), {});
      app.close();
      await expect(
        TokenSipApp.create(loadConfig({ dataDir: dir, secret: "second secret value" }, {}), {}),
      ).rejects.toThrow(/master key does not match/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("passwords", () => {
  it("hashes with scrypt and verifies in constant time", () => {
    const h = hashPassword("correct horse battery staple");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery staple", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    // RFC 6238 Appendix B: T = 59s → 94287082 (8 digits); we use the last 6.
    expect(totpCode(secret, 59_000)).toBe("287082");
    expect(verifyTotp(secret, "287082", 1, 59_000)).toBe(true);
    expect(verifyTotp(secret, "000000", 1, 59_000)).toBe(false);
    expect(verifyTotp(secret, "abc", 1, 59_000)).toBe(false);
  });
});

describe("virtual keys", () => {
  it("are high-entropy and hinted without leaking the secret", () => {
    const { key, hash, hint } = generateVirtualKey();
    expect(key).toMatch(/^tsk_[A-Za-z0-9_-]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hint.length).toBeLessThan(16);
    expect(key).not.toContain(hint.replace("…", ""));
  });
});
