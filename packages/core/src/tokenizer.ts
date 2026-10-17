import { encode } from "gpt-tokenizer/encoding/o200k_base";

/**
 * Token counting is used only to *report* how much an optimizer saved.
 * Billing numbers always come from the provider's own usage fields.
 * o200k_base is within a few percent of most modern tokenizers for English
 * and code, which is accurate enough for savings estimates.
 */
export type CountMode = "exact" | "sampled" | "approx";

const EXACT_LIMIT = 2_000_000; // characters; beyond this we fall back to approximation
const SAMPLE_THRESHOLD = 2048; // strings shorter than this are always counted exactly
const SAMPLE_WINDOW = 512;

function exact(text: string): number {
  try {
    return encode(text, { allowedSpecial: "all" }).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/**
 * Token count of a string.
 * - `exact`: full BPE encoding.
 * - `sampled`: exact for short strings; long strings are estimated from three
 *   evenly spaced windows (typically within a few percent, ~50× faster on large tool outputs).
 * - `approx`: characters / 4.
 */
export function countTokens(text: string, mode: CountMode = "exact"): number {
  if (!text) return 0;
  if (mode === "approx" || text.length > EXACT_LIMIT) return Math.ceil(text.length / 4);
  const sampled = mode === "sampled" && text.length > SAMPLE_THRESHOLD;
  const cache = text.length >= MEMO_MIN_CHARS ? (sampled ? memoSampled : memoExact) : undefined;
  const hit = cache?.get(text);
  if (hit !== undefined) return hit;
  let n: number;
  if (sampled) {
    const step = Math.floor((text.length - SAMPLE_WINDOW) / 2);
    let tokens = 0;
    for (let i = 0; i < 3; i++) tokens += exact(text.slice(i * step, i * step + SAMPLE_WINDOW));
    n = Math.round((tokens / (3 * SAMPLE_WINDOW)) * text.length);
  } else n = exact(text);
  cache?.set(text, n);
  return n;
}

/**
 * Agents re-send the same tool results and instructions on every turn, so
 * counts are memoized (in memory, bounded by total characters, least recently
 * used first out). Only numbers are returned; nothing is persisted.
 */
class CountMemo {
  private readonly map = new Map<string, number>();
  private chars = 0;

  constructor(private readonly maxChars: number) {}

  get(text: string): number | undefined {
    const n = this.map.get(text);
    if (n !== undefined) {
      this.map.delete(text);
      this.map.set(text, n);
    }
    return n;
  }

  set(text: string, n: number): void {
    if (text.length > this.maxChars / 4) return;
    this.map.set(text, n);
    this.chars += text.length;
    for (const key of this.map.keys()) {
      if (this.chars <= this.maxChars) break;
      this.map.delete(key);
      this.chars -= key.length;
    }
  }
}

const MEMO_MIN_CHARS = 256;
const memoExact = new CountMemo(4_000_000);
const memoSampled = new CountMemo(4_000_000);

/** Estimate tokens for any JSON-ish value by walking string leaves. */
export function countValueTokens(value: unknown, mode: CountMode = "exact"): number {
  let total = 0;
  const walk = (v: unknown): void => {
    if (typeof v === "string") total += countTokens(v, mode);
    else if (Array.isArray(v)) for (const item of v) walk(item);
    else if (v && typeof v === "object") for (const item of Object.values(v)) walk(item);
  };
  walk(value);
  return total;
}
