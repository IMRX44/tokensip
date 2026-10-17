import { hash } from "node:crypto";
import { isObj, type Json } from "../protocols/types.js";
import type { Protocol } from "../types.js";

export type Region = "tools" | "system" | "messages";

/**
 * One cacheable unit of a request, in the order providers hash prompts
 * (tools → system → messages). Hash chains of these blocks are what the
 * shadow cache compares between turns.
 */
export interface Block {
  region: Region;
  /** Index within the region (tool #, system block #, message #). */
  index: number;
  /** Hash of the bytes as sent (key order matters to the provider). */
  hash: string;
  /** Hash of the canonical form (sorted keys) — equal when only key order changed. */
  canon: string;
  /** Approximate tokens (chars / 4). */
  tokens: number;
  /** Plain text for system blocks (kept in memory only, for locating volatile values). */
  text?: string;
  /** Tool name, for tool blocks. */
  name?: string;
}

const h = (s: string) => hash("sha256", s, "base64url").slice(0, 22);
const dropCacheMarkers = (key: string, value: unknown) => (key === "cache_control" ? undefined : value);

/** Serialized bytes without `cache_control` markers (they change as breakpoints move, not the content). */
function serialize(value: unknown): string {
  const raw = JSON.stringify(value ?? null);
  // Most blocks carry no markers: only pay for the replacer when one may be present.
  return raw.includes('"cache_control"') ? JSON.stringify(value ?? null, dropCacheMarkers) : raw;
}

/** Sorted keys, no cache markers — equal for two blocks that differ only in key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (key !== "cache_control" && v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/**
 * `known` maps raw hashes to canonical hashes from the previous turn: in a
 * growing conversation almost every block is unchanged, so only new blocks pay
 * for canonicalization.
 */
function block(
  region: Region,
  index: number,
  value: unknown,
  extra: Partial<Block>,
  known: ReadonlyMap<string, string> | undefined,
): Block {
  const raw = serialize(value);
  const id = h(raw);
  const canon = known?.get(id) ?? h(JSON.stringify(canonical(value ?? null)));
  return { region, index, hash: id, canon, tokens: Math.ceil(raw.length / 4), ...extra };
}

function toolName(t: unknown): string | undefined {
  if (!isObj(t)) return undefined;
  if (typeof t.name === "string") return t.name;
  if (isObj(t.function) && typeof t.function.name === "string") return t.function.name;
  return undefined;
}

function systemText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((b) => (isObj(b) && typeof b.text === "string" ? b.text : "")).join("\n");
  if (isObj(v) && Array.isArray(v.parts)) return systemText(v.parts);
  if (isObj(v) && typeof v.content === "string") return v.content;
  if (isObj(v) && Array.isArray(v.content)) return systemText(v.content);
  return "";
}

export function blocksOf(protocol: Protocol, payload: Json, known?: ReadonlyMap<string, string>): Block[] {
  const out: Block[] = [];
  const make = (region: Region, index: number, value: unknown, extra: Partial<Block> = {}) =>
    block(region, index, value, extra, known);
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  for (const [i, t] of tools.entries()) out.push(make("tools", i, t, { name: toolName(t) }));

  if (protocol === "anthropic") {
    const sys = payload.system;
    if (typeof sys === "string") out.push(make("system", 0, sys, { text: sys }));
    else if (Array.isArray(sys))
      for (const [i, b] of sys.entries()) out.push(make("system", i, b, { text: systemText([b]) }));
    for (const [i, m] of (Array.isArray(payload.messages) ? payload.messages : []).entries())
      out.push(make("messages", i, m));
  } else if (protocol === "openai-chat") {
    let sysIndex = 0;
    let inLeadingSystem = true;
    (Array.isArray(payload.messages) ? payload.messages : []).forEach((m, i) => {
      const isSys = isObj(m) && (m.role === "system" || m.role === "developer");
      if (inLeadingSystem && isSys) out.push(make("system", sysIndex++, m, { text: systemText(m) }));
      else {
        inLeadingSystem = false;
        out.push(make("messages", i, m));
      }
    });
  } else if (protocol === "openai-responses") {
    if (typeof payload.instructions === "string")
      out.push(make("system", 0, payload.instructions, { text: payload.instructions }));
    const input = payload.input;
    if (typeof input === "string") out.push(make("messages", 0, input));
    else if (Array.isArray(input)) for (const [i, m] of input.entries()) out.push(make("messages", i, m));
  } else if (protocol === "gemini") {
    const sys = payload.systemInstruction ?? payload.system_instruction;
    if (sys) out.push(make("system", 0, sys, { text: systemText(sys) }));
    for (const [i, m] of (Array.isArray(payload.contents) ? payload.contents : []).entries())
      out.push(make("messages", i, m));
  }
  return out;
}

/** Number of leading blocks that are byte-identical, and the tokens they cover. */
export function commonPrefix(a: Block[], b: Block[]): { blocks: number; tokens: number } {
  let n = 0;
  let tokens = 0;
  while (n < a.length && n < b.length && a[n]?.hash === b[n]?.hash) {
    tokens += (b[n] as Block).tokens;
    n++;
  }
  return { blocks: n, tokens };
}

/** Token offset at which a given message starts. */
export function messageOffset(blocks: Block[], messageIndex: number): number {
  let tokens = 0;
  for (const b of blocks) {
    if (b.region === "messages" && b.index >= messageIndex) return tokens;
    tokens += b.tokens;
  }
  return tokens;
}

export const totalTokens = (blocks: Block[]) => blocks.reduce((s, b) => s + b.tokens, 0);
