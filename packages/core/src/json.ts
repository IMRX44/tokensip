import { createHash } from "node:crypto";

/**
 * Remove insignificant whitespace from a JSON document *without* parsing
 * its values. JSON.parse/stringify would silently corrupt integers larger
 * than 2^53 and reorder nothing but still change float formatting — this
 * scanner only drops whitespace outside string literals, so the result is
 * byte-for-byte the same data.
 *
 * Returns `null` when the input is not a JSON object/array.
 */
export function minifyJsonText(text: string): string | null {
  const trimmed = text.trim();
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return null;
  try {
    JSON.parse(trimmed);
  } catch {
    return null;
  }
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i] as string;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t") {
      out += ch;
    }
  }
  return out;
}

/** Deterministic JSON serialization with sorted object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Stable hash of a request body, ignoring keys that don't affect the response. */
export function requestFingerprint(
  body: unknown,
  extra: Record<string, unknown> = {},
  ignore: string[] = ["user", "metadata", "store", "service_tier", "safety_identifier", "prompt_cache_key"],
): string {
  let target = body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const copy: Record<string, unknown> = {
      ...(body as Record<string, unknown>),
    };
    for (const key of ignore) delete copy[key];
    target = copy;
  }
  return sha256(canonicalJson({ body: target, ...extra }));
}
