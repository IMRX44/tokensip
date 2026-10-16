import type { Block } from "./blocks.js";

export type LeakKind =
  | "timestamp"
  | "id"
  | "counter"
  | "whitespace"
  | "tool-order"
  | "json-key-order"
  | "tools-changed"
  | "text";

/**
 * A cache leak: something early in the prompt changed between two turns of
 * the same conversation while the rest stayed the same, so the provider had to
 * re-process everything after it. Only the *shape* of the changed value is
 * kept (digits → 9, letters → a/A) — never prompt text.
 */
export interface CacheLeak {
  kind: LeakKind;
  /** Where it happened, e.g. `system[0]@1204`, `tools`, `message[0]@88`. */
  location: string;
  /** Masked shape of the new value, e.g. `9999-99-99a99:99:99`. */
  shape: string;
  /** Prompt tokens after the change that lost their cache. */
  tokensAffected: number;
}

const VALUE_CHAR = /[\w:.\-+/]/;

export function maskShape(value: string, max = 48): string {
  const masked = value.replace(/[0-9]/g, "9").replace(/[a-z]/g, "a").replace(/[A-Z]/g, "A").replace(/\s+/g, " ");
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

export function classify(value: string): LeakKind {
  const v = value.trim();
  if (!v) return "whitespace";
  if (
    /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}(:\d{2})?|\b1[5-9]\d{8}(\d{3})?\b|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(
      v,
    )
  )
    return "timestamp";
  if (
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(v) ||
    /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/i.test(v) ||
    /\b(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{12,}\b/i.test(v)
  )
    return "id";
  if (/^[\d.,\s%]+$/.test(v)) return "counter";
  return "text";
}

/**
 * Locate the single changed span between two versions of a text, expanded to
 * whole "value" runs (so `12:00:01` vs `12:00:07` yields the full time, not
 * just the last digit). Returns undefined when the texts differ too much to be
 * a volatile value inside an otherwise stable text.
 */
export function volatileSpan(
  before: string,
  after: string,
): { prefix: string; suffix: string; value: string } | undefined {
  if (before === after) return undefined;
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  // expand to value boundaries on both sides
  while (p > 0 && VALUE_CHAR.test(after[p - 1] ?? "")) p--;
  while (s > 0 && VALUE_CHAR.test(after[after.length - s] ?? "")) s--;
  const value = after.slice(p, after.length - s);
  const changedBefore = before.length - p - s;
  if (value.length > 200 || changedBefore > 200) return undefined;
  if (p + s < 0.6 * Math.min(before.length, after.length)) return undefined;
  if (p < 8) return undefined; // need a stable anchor before the value
  return { prefix: after.slice(0, p), suffix: after.slice(after.length - s), value };
}

/** Compare two consecutive requests (client originals) of one conversation. */
export function detectLeak(prev: Block[], cur: Block[]): CacheLeak | undefined {
  let d = 0;
  while (d < prev.length && d < cur.length && prev[d]?.hash === cur[d]?.hash) d++;
  if (d >= prev.length) return undefined; // pure append — the normal case
  if (d >= cur.length) return undefined; // conversation shrank: client-side compaction or a new branch
  const at = cur[d] as Block;
  const was = prev[d] as Block;

  // Only changes in the stable head (tools, system, first message) are leaks; edits deeper in the
  // history are usually deliberate (compaction, retries).
  const inHead = at.region === "tools" || at.region === "system" || (at.region === "messages" && at.index === 0);
  const resumesAfter = cur.slice(d + 1).some((b, i) => b.hash === prev[d + 1 + i]?.hash);
  if (!inHead && !resumesAfter) return undefined;

  let tokensAffected = 0;
  for (let i = d; i < Math.min(prev.length, cur.length); i++) tokensAffected += (cur[i] as Block).tokens;

  if (at.region === "tools") {
    const prevTools = prev.filter((b) => b.region === "tools");
    const curTools = cur.filter((b) => b.region === "tools");
    const sameCanon =
      [...prevTools.map((b) => b.canon)].sort().join() === [...curTools.map((b) => b.canon)].sort().join();
    const orderedCanon = prevTools.map((b) => b.canon).join() === curTools.map((b) => b.canon).join();
    const kind: LeakKind = sameCanon ? (orderedCanon ? "json-key-order" : "tool-order") : "tools-changed";
    return { kind, location: "tools", shape: "", tokensAffected };
  }
  if (was.canon === at.canon)
    return { kind: "json-key-order", location: `${at.region}[${at.index}]`, shape: "", tokensAffected };

  if (at.region === "system" && was.text !== undefined && at.text !== undefined) {
    const span = volatileSpan(was.text, at.text);
    if (span) {
      return {
        kind: classify(span.value),
        location: `system[${at.index}]@${span.prefix.length}`,
        shape: maskShape(span.value),
        tokensAffected,
      };
    }
  }
  return { kind: "text", location: `${at.region}[${at.index}]`, shape: "", tokensAffected };
}
