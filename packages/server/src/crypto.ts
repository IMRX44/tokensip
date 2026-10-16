import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = 1;

/**
 * AES-256-GCM envelope for secrets at rest (provider API keys, TOTP seeds,
 * cached responses). Layout: version(1) | iv(12) | tag(16) | ciphertext.
 */
export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("Vault key must be 32 bytes");
  }

  static fromSecret(secret: string): Vault {
    const trimmed = secret.trim();
    if (/^[0-9a-f]{64}$/i.test(trimmed)) return new Vault(Buffer.from(trimmed, "hex"));
    // Passphrase: stretch it. The salt is fixed so the same secret always yields the same key.
    return new Vault(
      scryptSync(trimmed, "tokensip/master-key/v1", 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }),
    );
  }

  /** Load the key from `secret`, or from `<dataDir>/master.key` (created with 0600 permissions). */
  static load(dataDir: string, secret?: string): { vault: Vault; source: "env" | "file" | "generated" } {
    if (secret) return { vault: Vault.fromSecret(secret), source: "env" };
    const file = join(dataDir, "master.key");
    if (existsSync(file)) {
      return { vault: new Vault(Buffer.from(readFileSync(file, "utf8").trim(), "hex")), source: "file" };
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    writeFileSync(file, `${key.toString("hex")}\n`, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort on platforms without POSIX permissions */
    }
    return { vault: new Vault(key), source: "generated" };
  }

  encrypt(plaintext: string | Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), data]);
  }

  decrypt(blob: Uint8Array): Buffer {
    const buf = Buffer.from(blob);
    if (buf[0] !== VERSION) throw new Error("Unsupported vault blob version");
    const iv = buf.subarray(1, 13);
    const tag = buf.subarray(13, 29);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]);
  }

  encryptString(value: string): string {
    return this.encrypt(value).toString("base64");
  }

  decryptString(value: string): string {
    return this.decrypt(Buffer.from(value, "base64")).toString("utf8");
  }
}

// ---------------------------------------------------------------- passwords

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize("NFKC"), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- tokens

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const VIRTUAL_KEY_PREFIX = "tsk_";

/** Virtual API keys: high-entropy, so a fast SHA-256 is the right hash for lookup. */
export function generateVirtualKey(): { key: string; hash: string; hint: string } {
  const key = `${VIRTUAL_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { key, hash: sha256Hex(key), hint: `${key.slice(0, 8)}…${key.slice(-4)}` };
}

// ---------------------------------------------------------------- TOTP (RFC 6238)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secret: string, time = Date.now(), step = 30, digits = 6): string {
  const counter = Math.floor(time / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = (hmac[hmac.length - 1] as number) & 0xf;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return bin.toString().padStart(digits, "0");
}

export function verifyTotp(secret: string, code: string, window = 1, time = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (let w = -window; w <= window; w++) {
    if (safeEqual(totpCode(secret, time + w * 30_000), code)) return true;
  }
  return false;
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}
