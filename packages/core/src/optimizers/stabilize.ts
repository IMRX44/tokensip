import { createHash } from "node:crypto";
import { canonicalJson } from "../json.js";
import { isObj, type Json } from "../protocols/types.js";
import type { Protocol } from "../types.js";
import type { Stage } from "./types.js";
import { NOOP } from "./types.js";

const PLACEHOLDER = "⟨value moved to the latest user message by TokenSip⟩";

function toolName(t: unknown): string {
  if (!isObj(t)) return "";
  if (typeof t.name === "string") return t.name;
  if (isObj(t.function) && typeof t.function.name === "string") return t.function.name;
  return "";
}

/**
 * Cache Doctor repair #1 (lossless). Some clients serialize their tool list in
 * a different order or key order on every request, which silently defeats the
 * provider's prompt cache. Once that is observed for a conversation, tools are
 * sent in a canonical order and serialization from then on.
 */
export const stabilizeTools: Stage = {
  id: "stabilize-tools",
  safety: "lossless",
  description:
    "Sends tools in a canonical order/serialization once the client is seen reshuffling them (a common prompt-cache leak).",
  run(ctx) {
    const s = ctx.session;
    if (!s?.state.sortTools || !Array.isArray(ctx.payload.tools)) return NOOP;
    const before = JSON.stringify(ctx.payload.tools);
    const sorted = [...ctx.payload.tools]
      .map((t) => JSON.parse(canonicalJson(t)) as unknown)
      .sort((a, b) => toolName(a).localeCompare(toolName(b)));
    ctx.payload.tools = sorted;
    if (JSON.stringify(sorted) === before) return NOOP;
    s.repairs.push("tools canonicalized");
    return { edits: 1, tokensSaved: 0, note: "tool order/serialization canonicalized" };
  },
};

// ------------------------------------------------------------------ volatile system values

interface SystemRef {
  get(): string;
  set(v: string): void;
}

function systemRef(protocol: Protocol, p: Json, index: number): SystemRef | undefined {
  if (protocol === "anthropic") {
    if (typeof p.system === "string" && index === 0) {
      return { get: () => p.system as string, set: (v) => (p.system = v) };
    }
    if (Array.isArray(p.system)) {
      const b = p.system[index];
      if (isObj(b) && typeof b.text === "string") return { get: () => b.text as string, set: (v) => (b.text = v) };
    }
    return undefined;
  }
  if (protocol === "openai-chat" && Array.isArray(p.messages)) {
    const m = p.messages[index];
    if (isObj(m) && (m.role === "system" || m.role === "developer") && typeof m.content === "string") {
      return { get: () => m.content as string, set: (v) => (m.content = v) };
    }
    return undefined;
  }
  if (protocol === "openai-responses" && typeof p.instructions === "string" && index === 0) {
    return { get: () => p.instructions as string, set: (v) => (p.instructions = v) };
  }
  return undefined;
}

const msgHash = (m: unknown) => createHash("sha256").update(JSON.stringify(m)).digest("base64url").slice(0, 22);

function userMessages(protocol: Protocol, p: Json): Json[] {
  const list = protocol === "openai-responses" ? p.input : p.messages;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (m): m is Json =>
      isObj(m) &&
      m.role === "user" &&
      (protocol !== "openai-responses" || m.type === undefined || m.type === "message"),
  );
}

function appendText(protocol: Protocol, m: Json, text: string): void {
  const partType = protocol === "openai-responses" ? "input_text" : "text";
  if (typeof m.content === "string") {
    if (protocol === "anthropic")
      m.content = [
        { type: "text", text: m.content },
        { type: "text", text },
      ];
    else m.content = `${m.content}\n\n${text}`;
  } else if (Array.isArray(m.content)) {
    m.content.push({ type: partType, text });
  }
}

/**
 * Cache Doctor repair #2 (equivalent). A value that changes on every request
 * inside the system prompt (a clock, a request id, a counter) forces the
 * provider to re-process the entire prompt every turn. Once the volatile span
 * has been located, the system prompt carries a stable placeholder and the
 * current value is appended to the newest user message instead — the model
 * still sees it, but the expensive prefix becomes cacheable.
 */
export const relocateVolatile: Stage = {
  id: "relocate-volatile",
  safety: "equivalent",
  protocols: ["openai-chat", "anthropic", "openai-responses"],
  description:
    "Moves a value that changes every request (clock, request id) out of the system prompt so the prefix stays cacheable.",
  run(ctx) {
    const s = ctx.session;
    const v = s?.state.volatile;
    if (!s || !v) return NOOP;
    const ref = systemRef(ctx.protocol, ctx.payload, v.systemIndex);
    if (!ref) return NOOP;
    const text = ref.get();
    if (!text.startsWith(v.prefix) || !text.endsWith(v.suffix) || text.length < v.prefix.length + v.suffix.length) {
      return { ...NOOP, note: "system prompt no longer matches the learned template" };
    }
    const value = text.slice(v.prefix.length, text.length - v.suffix.length);
    ref.set(`${v.prefix}${PLACEHOLDER}${v.suffix}`);

    // Re-apply appendices to earlier user turns so the history stays byte-identical across turns,
    // then attach the current value to the newest user turn (if the conversation ends with one).
    const users = userMessages(ctx.protocol, ctx.payload);
    const hashes = users.map(msgHash);
    const list = (ctx.protocol === "openai-responses" ? ctx.payload.input : ctx.payload.messages) as unknown[];
    const last = list[list.length - 1];
    users.forEach((m, i) => {
      const known = s.state.appendices.get(hashes[i] as string);
      if (known !== undefined) appendText(ctx.protocol, m, known);
    });
    const newest = users[users.length - 1];
    if (newest && newest === last && !s.state.appendices.has(hashes[users.length - 1] as string)) {
      const label = v.prefix.slice(v.prefix.lastIndexOf("\n") + 1).slice(-60);
      const appendix = `[TokenSip moved this value out of the system prompt to keep the prompt cache stable] ${label}${value}`;
      s.state.appendices.set(hashes[users.length - 1] as string, appendix);
      appendText(ctx.protocol, newest, appendix);
    }
    s.repairs.push("volatile system value relocated");
    return { edits: 1, tokensSaved: 0, note: "volatile system value moved to the latest user message" };
  },
};
