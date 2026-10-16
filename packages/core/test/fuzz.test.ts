/**
 * Property-based tests: random conversations in every wire format, run
 * through every profile. Invariants that must hold for *any* input:
 *  - never throws, never mutates the input
 *  - assistant turns are never edited (signed thinking stays valid)
 *  - safe/balanced are prefix-stable across turns (prompt caches keep hitting)
 *  - safe never touches tool output
 *  - lossy profiles keep tool calls paired with their results
 */
import { describe, expect, it } from "vitest";
import { optimize, type ProfileId, type Protocol } from "../src/index.js";

type J = Record<string, any>;

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (a: number, b: number) => a + Math.floor(next() * (b - a + 1)),
    pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
  };
}
type R = ReturnType<typeof rng>;

const WORDS = [
  "agent",
  "file",
  "token",
  "cache",
  "خطا",
  "ошибка",
  "错误",
  "😀",
  "deploy",
  "test",
  "  ",
  "\t",
  "\n\n\n\n",
  "```js\nconst a = 1;   \n\n\n\n```",
];
function text(r: R, n = r.int(1, 40)) {
  return Array.from({ length: n }, () => r.pick(WORDS)).join(r.pick([" ", "  ", "\n", " \n"]));
}
function toolOutput(r: R, pool: string[]): string {
  if (pool.length && r.chance(0.35)) return r.pick(pool); // duplicate of an earlier output
  const kind = r.int(0, 3);
  const out =
    kind === 0
      ? JSON.stringify(
          {
            items: Array.from({ length: r.int(1, 60) }, (_, i) => ({
              i,
              big: 12345678901234567890n.toString(),
              s: text(r, 3),
            })),
          },
          null,
          r.pick([2, 4]),
        )
      : kind === 1
        ? Array.from({ length: r.int(5, 300) }, (_, i) => `line ${i}: ${text(r, 4)}   `).join("\n")
        : kind === 2
          ? "{not json"
          : text(r, r.int(1, 200));
  pool.push(out);
  return out;
}

function openaiConversation(r: R, turns: number): J {
  const msgs: J[] = [
    { role: r.pick(["system", "developer"]), content: text(r, 60) },
    { role: "user", content: text(r) },
  ];
  const pool: string[] = [];
  let id = 0;
  for (let t = 0; t < turns; t++) {
    if (r.chance(0.7)) {
      const calls = Array.from({ length: r.int(1, 2) }, () => ({
        id: `c${id++}`,
        type: "function",
        function: { name: "f", arguments: "{}" },
      }));
      msgs.push({ role: "assistant", content: r.chance(0.3) ? text(r) : null, tool_calls: calls });
      for (const c of calls)
        msgs.push({
          role: "tool",
          tool_call_id: c.id,
          content: r.chance(0.2) ? [{ type: "text", text: toolOutput(r, pool) }] : toolOutput(r, pool),
        });
    } else {
      msgs.push({ role: "assistant", content: text(r) });
      msgs.push({
        role: "user",
        content: r.chance(0.3)
          ? [
              { type: "text", text: text(r) },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ]
          : text(r),
      });
    }
  }
  return {
    model: "gpt-4.1",
    messages: msgs,
    max_completion_tokens: r.int(100, 20000),
    reasoning_effort: r.pick(["low", "high"]),
  };
}

function anthropicConversation(r: R, turns: number): J {
  const msgs: J[] = [{ role: "user", content: text(r) }];
  const pool: string[] = [];
  let id = 0;
  for (let t = 0; t < turns; t++) {
    if (r.chance(0.7)) {
      const uses = Array.from({ length: r.int(1, 2) }, () => ({
        type: "tool_use",
        id: `tu${id++}`,
        name: "f",
        input: {},
      }));
      const content: J[] = [];
      if (r.chance(0.5)) content.push({ type: "thinking", thinking: text(r), signature: `sig-${id}` });
      if (r.chance(0.3)) content.push({ type: "text", text: text(r) });
      msgs.push({ role: "assistant", content: [...content, ...uses] });
      msgs.push({
        role: "user",
        content: uses.map((u) => ({
          type: "tool_result",
          tool_use_id: u.id,
          content: r.chance(0.3) ? [{ type: "text", text: toolOutput(r, pool) }] : toolOutput(r, pool),
        })),
      });
    } else {
      msgs.push({ role: "assistant", content: r.chance(0.5) ? text(r) : [{ type: "text", text: text(r) }] });
      msgs.push({ role: "user", content: text(r) });
    }
  }
  const body: J = { model: "claude-sonnet-4-5", max_tokens: 16000, messages: msgs };
  if (r.chance(0.7)) body.system = r.chance(0.5) ? text(r, 400) : [{ type: "text", text: text(r, 400) }];
  if (r.chance(0.6)) body.tools = [{ name: "f", description: "d", input_schema: { type: "object" } }];
  if (r.chance(0.3)) body.thinking = { type: "enabled", budget_tokens: 8000 };
  return body;
}

function geminiConversation(r: R, turns: number): J {
  const contents: J[] = [{ role: "user", parts: [{ text: text(r) }] }];
  for (let t = 0; t < turns; t++) {
    if (r.chance(0.6)) {
      contents.push({ role: "model", parts: [{ functionCall: { name: "f", args: {} } }] });
      contents.push({ role: "user", parts: [{ functionResponse: { name: "f", response: { result: text(r) } } }] });
    } else {
      contents.push({ role: "model", parts: [{ text: text(r), thoughtSignature: r.chance(0.3) ? "sig" : undefined }] });
      contents.push({ role: "user", parts: [{ text: text(r) }] });
    }
  }
  return {
    systemInstruction: { parts: [{ text: text(r, 80) }] },
    contents,
    generationConfig: { maxOutputTokens: 9000 },
  };
}

function responsesConversation(r: R, turns: number): J {
  const input: J[] = [{ role: "user", content: text(r) }];
  const pool: string[] = [];
  for (let t = 0; t < turns; t++) {
    if (r.chance(0.7)) {
      if (r.chance(0.4)) input.push({ type: "reasoning", id: `rs${t}`, summary: [] });
      input.push({ type: "function_call", call_id: `fc${t}`, name: "f", arguments: "{}" });
      input.push({ type: "function_call_output", call_id: `fc${t}`, output: toolOutput(r, pool) });
    } else {
      input.push({ role: "assistant", content: [{ type: "output_text", text: text(r) }] });
      input.push({ role: "user", content: [{ type: "input_text", text: text(r) }] });
    }
  }
  return { model: "gpt-5", instructions: text(r, 50), input, reasoning: { effort: "high" } };
}

const GEN: Record<Protocol, (r: R, turns: number) => J> = {
  "openai-chat": openaiConversation,
  anthropic: anthropicConversation,
  gemini: geminiConversation,
  "openai-responses": responsesConversation,
};
const LIST_KEY: Record<Protocol, string> = {
  "openai-chat": "messages",
  anthropic: "messages",
  gemini: "contents",
  "openai-responses": "input",
};
const PROFILES: ProfileId[] = ["off", "safe", "balanced", "aggressive", "extreme"];

const isAssistant = (p: Protocol, m: J) =>
  p === "gemini"
    ? m.role === "model"
    : p === "openai-responses"
      ? m.role === "assistant" || ["function_call", "reasoning"].includes(m.type)
      : m.role === "assistant";

/** Remove cache markers that are *supposed* to move as the conversation grows. */
const stripCacheMarkers = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v), (k, val) => (k === "cache_control" || k === "prompt_cache_key" ? undefined : val));

/**
 * Once a conversation crosses Anthropic's cacheable minimum, user messages switch to block form
 * (a one-time transition). Normalize that so the property compares content, not representation.
 */
function normalizeAnthropic(m: J): J {
  if (
    Array.isArray(m.content) &&
    m.content.length === 1 &&
    m.content[0].type === "text" &&
    Object.keys(m.content[0]).length === 2
  ) {
    return { ...m, content: m.content[0].text };
  }
  return m;
}

function checkToolPairing(p: Protocol, list: J[]) {
  if (p === "openai-chat") {
    const known = new Set<string>();
    for (const m of list) {
      for (const c of m.tool_calls ?? []) known.add(c.id);
      if (m.role === "tool") expect(known.has(m.tool_call_id)).toBe(true);
    }
  } else if (p === "anthropic") {
    expect(list[0]?.role).toBe("user");
    for (let i = 0; i < list.length; i++) {
      const m = list[i] as J;
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type !== "tool_result") continue;
        const prev = list[i - 1];
        const ids = (prev?.content ?? []).filter((x: J) => x.type === "tool_use").map((x: J) => x.id);
        expect(ids).toContain(b.tool_use_id);
      }
    }
  } else if (p === "openai-responses") {
    const known = new Set<string>();
    for (const m of list) {
      if (m.type === "function_call") known.add(m.call_id);
      if (m.type === "function_call_output") expect(known.has(m.call_id)).toBe(true);
    }
  }
}

describe.each(Object.keys(GEN) as Protocol[])("fuzz %s", (protocol) => {
  it.each(PROFILES)("profile %s holds every invariant", (profile) => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed * 7919 + protocol.length);
      const turns = r.int(0, 30);
      const input = GEN[protocol](r, turns);
      const snapshot = JSON.stringify(input);
      const { payload, report } = optimize(input, {
        protocol,
        profile,
        provider: "openai",
        options: { maxMessages: 12, minBudgetTokens: 64 },
      });

      expect(JSON.stringify(input)).toBe(snapshot); // never mutates
      expect(() => JSON.stringify(payload)).not.toThrow();
      if (profile === "off") expect(payload).toBe(input);
      if (profile === "safe" || profile === "balanced") expect(report.lossy).toBe(false);
      expect(report.tokensAfter).toBeLessThanOrEqual(report.tokensBefore);

      const before = input[LIST_KEY[protocol]] as J[];
      const after = (payload as J)[LIST_KEY[protocol]] as J[];
      expect(after.length).toBeLessThanOrEqual(before.length);

      // Assistant turns that survive are byte-identical to the originals, in order.
      const origAssistant = before
        .filter((m) => isAssistant(protocol, m))
        .map((m) => JSON.stringify(stripCacheMarkers(m)));
      const keptAssistant = after
        .filter((m) => isAssistant(protocol, m))
        .map((m) => JSON.stringify(stripCacheMarkers(m)));
      let cursor = 0;
      for (const m of keptAssistant) {
        cursor = origAssistant.indexOf(m, cursor);
        expect(cursor).toBeGreaterThanOrEqual(0);
        cursor++;
      }

      if (profile === "safe" && protocol === "openai-chat") {
        before.forEach((m, i) => {
          if (m.role === "tool") expect(after[i]).toEqual(m);
        });
      }
      checkToolPairing(protocol, after);
    }
  });

  it("safe and balanced are prefix-stable as the conversation grows", () => {
    for (const profile of ["safe", "balanced"] as ProfileId[]) {
      for (let seed = 1; seed <= 40; seed++) {
        const full = GEN[protocol](rng(seed * 104729), 24);
        const key = LIST_KEY[protocol];
        const list = full[key] as J[];
        const cut = Math.max(2, Math.floor(list.length / 2));
        const early = { ...full, [key]: list.slice(0, cut) };
        const a = optimize(early, { protocol, profile, provider: "openai" }).payload as J;
        const b = optimize(full, { protocol, profile, provider: "openai" }).payload as J;
        const norm = (xs: J[]) =>
          (stripCacheMarkers(xs) as J[]).map((m) => (protocol === "anthropic" ? normalizeAnthropic(m) : m));
        expect(norm((b[key] as J[]).slice(0, cut))).toEqual(norm(a[key] as J[]));
        // System prompt / instructions are identical too.
        for (const k of ["system", "instructions", "systemInstruction"]) {
          if (a[k] !== undefined) expect(stripCacheMarkers(b[k])).toEqual(stripCacheMarkers(a[k]));
        }
      }
    }
  });
});
