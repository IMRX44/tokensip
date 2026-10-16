import { createHash } from "node:crypto";
import { canonicalJson } from "../json.js";
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

const h = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 22);
const stripCache = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v ?? null), (k, val) => (k === "cache_control" ? undefined : val));

function block(region: Region, index: number, value: unknown, extra: Partial<Block> = {}): Block {
  const clean = stripCache(value);
  const raw = JSON.stringify(clean);
  return { region, index, hash: h(raw), canon: h(canonicalJson(clean)), tokens: Math.ceil(raw.length / 4), ...extra };
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

export function blocksOf(protocol: Protocol, payload: Json): Block[] {
  const out: Block[] = [];
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  for (const [i, t] of tools.entries()) out.push(block("tools", i, t, { name: toolName(t) }));

  if (protocol === "anthropic") {
    const sys = payload.system;
    if (typeof sys === "string") out.push(block("system", 0, sys, { text: sys }));
    else if (Array.isArray(sys))
      for (const [i, b] of sys.entries()) out.push(block("system", i, b, { text: systemText([b]) }));
    for (const [i, m] of (Array.isArray(payload.messages) ? payload.messages : []).entries())
      out.push(block("messages", i, m));
  } else if (protocol === "openai-chat") {
    let sysIndex = 0;
    let inLeadingSystem = true;
    (Array.isArray(payload.messages) ? payload.messages : []).forEach((m, i) => {
      const isSys = isObj(m) && (m.role === "system" || m.role === "developer");
      if (inLeadingSystem && isSys) out.push(block("system", sysIndex++, m, { text: systemText(m) }));
      else {
        inLeadingSystem = false;
        out.push(block("messages", i, m));
      }
    });
  } else if (protocol === "openai-responses") {
    if (typeof payload.instructions === "string")
      out.push(block("system", 0, payload.instructions, { text: payload.instructions }));
    const input = payload.input;
    if (typeof input === "string") out.push(block("messages", 0, input));
    else if (Array.isArray(input)) for (const [i, m] of input.entries()) out.push(block("messages", i, m));
  } else if (protocol === "gemini") {
    const sys = payload.systemInstruction ?? payload.system_instruction;
    if (sys) out.push(block("system", 0, sys, { text: systemText(sys) }));
    for (const [i, m] of (Array.isArray(payload.contents) ? payload.contents : []).entries())
      out.push(block("messages", i, m));
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
