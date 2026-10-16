import { isObj, type Json } from "../protocols/types.js";
import type { Stage } from "./types.js";
import { NOOP } from "./types.js";

const MAX_BREAKPOINTS = 4;
const CACHEABLE_BLOCKS = new Set([
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "search_result",
  "server_tool_use",
  "web_search_tool_result",
]);

function hasCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCacheControl);
  if (isObj(value)) {
    if ("cache_control" in value) return true;
    return Object.values(value).some(hasCacheControl);
  }
  return false;
}

/** Mark the last cacheable block of a message. Converts string content into a single text block. */
function markMessage(msg: Json): boolean {
  if (typeof msg.content === "string") {
    if (!msg.content) return false;
    msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
    return true;
  }
  if (!Array.isArray(msg.content)) return false;
  for (let i = msg.content.length - 1; i >= 0; i--) {
    const block = msg.content[i];
    if (!isObj(block)) continue;
    if (block.type === "thinking" || block.type === "redacted_thinking") return false;
    if (typeof block.type === "string" && CACHEABLE_BLOCKS.has(block.type)) {
      if (block.type === "text" && !block.text) return false;
      block.cache_control = { type: "ephemeral" };
      return true;
    }
  }
  return false;
}

/**
 * Adds Anthropic prompt-cache breakpoints (tools → system → conversation)
 * when the client hasn't set any. Cached prefix reads are billed at ~10% of
 * the input price, which is where most of an agent's bill goes.
 * Requests that already use `cache_control` are left exactly as sent.
 */
export const anthropicCacheBreakpoints: Stage = {
  id: "anthropic-cache-breakpoints",
  safety: "lossless",
  protocols: ["anthropic"],
  description:
    "Adds prompt-cache breakpoints to tools, system and the rolling conversation so repeated context is billed at ~10%.",
  run(ctx) {
    const p = ctx.payload;
    if (hasCacheControl(p.tools) || hasCacheControl(p.system) || hasCacheControl(p.messages)) {
      return { ...NOOP, note: "client already manages cache_control" };
    }
    const approxTokens = Math.ceil(JSON.stringify([p.tools ?? null, p.system ?? null, p.messages ?? null]).length / 4);
    if (approxTokens < ctx.options.minCacheableTokens) {
      return { ...NOOP, note: "prompt below cacheable minimum" };
    }

    let placed = 0;
    // Keep the wire representation byte-stable across turns: a breakpoint needs block content,
    // and the breakpoint moves every turn, so every user message uses block form consistently.
    if (Array.isArray(p.messages)) {
      for (const m of p.messages) {
        if (isObj(m) && m.role === "user" && typeof m.content === "string" && m.content) {
          m.content = [{ type: "text", text: m.content }];
        }
      }
    }
    if (typeof p.system === "string" && p.system) p.system = [{ type: "text", text: p.system }];

    if (Array.isArray(p.tools) && p.tools.length > 0) {
      const last = p.tools[p.tools.length - 1];
      if (isObj(last)) {
        last.cache_control = { type: "ephemeral" };
        placed++;
      }
    }
    if (Array.isArray(p.system)) {
      for (let i = p.system.length - 1; i >= 0; i--) {
        const block = p.system[i];
        if (isObj(block) && block.type === "text" && block.text) {
          block.cache_control = { type: "ephemeral" };
          placed++;
          break;
        }
      }
    }

    const messages = Array.isArray(p.messages) ? (p.messages.filter(isObj) as Json[]) : [];
    const multiTurn = messages.length >= 3 || (Array.isArray(p.tools) && p.tools.length > 0);
    if (multiTurn) {
      const userIdx = messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
      const lastUser = userIdx[userIdx.length - 1];
      if (lastUser !== undefined && placed < MAX_BREAKPOINTS) {
        if (markMessage(messages[lastUser] as Json)) placed++;
      }
      // A second, older breakpoint keeps cache hits alive across long tool loops (20-block lookback).
      const prevUser = userIdx[userIdx.length - 2];
      if (prevUser !== undefined && messages.length >= 6 && placed < MAX_BREAKPOINTS) {
        if (markMessage(messages[prevUser] as Json)) placed++;
      }
    }

    return placed > 0
      ? {
          edits: placed,
          tokensSaved: 0,
          note: `added ${placed} cache breakpoint(s)`,
        }
      : NOOP;
  },
};
