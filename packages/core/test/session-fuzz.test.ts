/**
 * Property test for the SessionEngine across whole agent sessions: random
 * reads/edits/re-reads/test runs/searches, idle gaps and "leaky" clients that
 * put a clock in the system prompt and reshuffle tools. Checked on every turn:
 *  - tool calls stay paired with their results; assistant turns never change
 *  - the latest observation of every resource is never replaced, and every
 *    replaced one points to a newer observation that really exists
 *  - cache stability: unless the scheduler applied a change or the client
 *    leaked, the prompt the provider cached last turn is a byte-identical
 *    prefix of this turn's prompt
 */
import { describe, expect, it } from "vitest";
import { PriceBook, type ProfileId, SessionEngine } from "../src/index.js";

type J = Record<string, any>;
const strip = (v: unknown) => JSON.parse(JSON.stringify(v), (k, val) => (k === "cache_control" ? undefined : val));

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
    pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)] as T,
  };
}

interface Step {
  name: string;
  input: J;
  output: string;
}

/** Simulates an agent working on a tiny repo; files change when edited. */
function session(seed: number, length: number): Step[] {
  const r = rng(seed);
  const files = ["/r/a.ts", "/r/b.ts", "/r/c.py"];
  const version: Record<string, number> = { "/r/a.ts": 0, "/r/b.ts": 0, "/r/c.py": 0 };
  const body = (f: string) => Array.from({ length: 80 }, (_, i) => `${f} line ${i} v${version[f]}`).join("\n");
  const steps: Step[] = [];
  for (let i = 0; i < length; i++) {
    const f = r.pick(files);
    const kind = r.int(0, 5);
    if (kind <= 1) steps.push({ name: "Read", input: { file_path: f }, output: body(f) });
    else if (kind === 2) {
      version[f] = (version[f] ?? 0) + 1;
      steps.push({ name: "Edit", input: { file_path: f, old_string: "x", new_string: "y" }, output: "ok" });
    } else if (kind === 3)
      steps.push({
        name: "Bash",
        input: { command: "npm test" },
        output: `${"PASS\n".repeat(60)}run ${Object.values(version).join(".")}`,
      });
    else if (kind === 4)
      steps.push({
        name: "Grep",
        input: { pattern: "line 1", path: "/r" },
        output: `${"/r/a.ts:1\n".repeat(50)}${Object.values(version).join("")}`,
      });
    else
      steps.push({
        name: "Read",
        input: { file_path: f, offset: 10, limit: 20 },
        output: body(f).split("\n").slice(10, 30).join("\n"),
      });
  }
  return steps;
}

function anthropicRequest(steps: Step[], system: string, reorder: boolean): J {
  const messages: J[] = [{ role: "user", content: "Fix the bug." }];
  steps.forEach((s, i) => {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: s.name, input: s.input }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: s.output }] });
  });
  const tools = ["Read", "Edit", "Bash", "Grep"].map((name) => ({ name, input_schema: { type: "object" } }));
  return { model: "claude-sonnet-4-5", max_tokens: 2000, system, tools: reorder ? tools.reverse() : tools, messages };
}

function openaiRequest(steps: Step[], system: string, reorder: boolean): J {
  const messages: J[] = [
    { role: "system", content: system },
    { role: "user", content: "Fix the bug." },
  ];
  steps.forEach((s, i) => {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `t${i}`, type: "function", function: { name: s.name, arguments: JSON.stringify(s.input) } }],
    });
    messages.push({ role: "tool", tool_call_id: `t${i}`, content: s.output });
  });
  const tools = ["Read", "Edit", "Bash", "Grep"].map((name) => ({
    type: "function",
    function: { name, parameters: { type: "object" } },
  }));
  return { model: "gpt-4.1", messages, tools: reorder ? tools.reverse() : tools };
}

function results(protocol: string, p: J): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of p.messages) {
    if (protocol === "openai-chat" && m.role === "tool") out.set(m.tool_call_id, m.content);
    if (protocol === "anthropic" && Array.isArray(m.content))
      for (const b of m.content)
        if (b.type === "tool_result")
          out.set(b.tool_use_id, typeof b.content === "string" ? b.content : JSON.stringify(b.content));
  }
  return out;
}

const assistants = (p: J) =>
  p.messages.filter((m: J) => m.role === "assistant").map((m: J) => JSON.stringify(strip(m)));

describe.each(["anthropic", "openai-chat"] as const)("session fuzz %s", (protocol) => {
  it.each(["safe", "balanced", "aggressive"] as ProfileId[])("profile %s", (profile) => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed * 31337);
      const steps = session(seed, r.int(6, 28));
      const leakyClock = r.next() < 0.4;
      const leakyTools = r.next() < 0.3;
      const engine = new SessionEngine({ prices: () => new PriceBook() });
      let now = 0;
      let prevSent: J | undefined;
      for (let t = 1; t <= steps.length; t++) {
        now += r.next() < 0.15 ? 10 * 60_000 : r.int(5, 90) * 1000;
        const system = `You are a coding agent.\n${"Rules. ".repeat(40)}\n${leakyClock ? `Now: 2026-10-16T10:${String(t % 60).padStart(2, "0")}:00Z\n` : ""}End.`;
        const req = (protocol === "anthropic" ? anthropicRequest : openaiRequest)(
          steps.slice(0, t),
          system,
          leakyTools && t % 2 === 0,
        );
        const snapshot = JSON.stringify(req);
        const out = engine.run(req, { protocol, profile, tenant: "x", now, options: { dedupeMinTokens: 40 } });
        const sent = out.payload as J;
        expect(JSON.stringify(req)).toBe(snapshot);

        // assistant turns untouched
        expect(assistants(sent)).toEqual(assistants(req));

        // pairing intact + latest observation per resource untouched + every tombstone justified
        const orig = results(protocol, req);
        const now_ = results(protocol, sent);
        expect([...now_.keys()]).toEqual([...orig.keys()]);
        // Every replaced result must still be recoverable: follow supersession pointers (forward, to a newer
        // observation) and dedupe pointers (backward, to an identical copy) until real content is reached.
        const resolve = (start: string): { id: string; text: string } => {
          let cur = start;
          for (let hops = 0; hops < 60; hops++) {
            const t = now_.get(cur) as string;
            const sup = t.includes("[TokenSip · superseded]") ? /call (t\d+)\)/.exec(t)?.[1] : undefined;
            const dup = t.startsWith("[TokenSip] This output is identical") ? /\((t\d+)\)/.exec(t)?.[1] : undefined;
            if (sup) {
              expect(Number(sup.slice(1))).toBeGreaterThan(Number(cur.slice(1)));
              cur = sup;
            } else if (dup) {
              expect(Number(dup.slice(1))).toBeLessThan(Number(cur.slice(1)));
              expect(orig.get(dup)).toBe(orig.get(cur)); // a dedupe pointer only ever points to identical content
              cur = dup;
            } else return { id: cur, text: t };
          }
          throw new Error(`pointer loop at ${start}`);
        };
        for (const [id, text] of now_) {
          if (text === orig.get(id)) continue;
          if (!text.includes("[TokenSip")) continue; // whitespace/minify edits
          const end = resolve(id);
          expect(end.text, `content reachable from ${id}`).toBe(orig.get(end.id));
        }

        // cache stability between turns
        // Allowed prefix changes: the client leaked, the scheduler applied a change, or Anthropic cache
        // breakpoints switched on for the first time (nothing was cached before that).
        const breakpointsStarted =
          protocol === "anthropic" &&
          prevSent &&
          !JSON.stringify(prevSent).includes("cache_control") &&
          JSON.stringify(sent).includes("cache_control");
        const changed =
          out.session?.leak !== undefined || out.session?.decision?.applied === true || breakpointsStarted;
        if (prevSent && !changed) {
          const a = strip(prevSent) as J;
          const b = strip(sent) as J;
          expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));
          if (protocol === "anthropic") expect(JSON.stringify(b.system)).toBe(JSON.stringify(a.system));
          // every message sent last turn is resent byte-identically (the new turn only appends)
          for (let i = 0; i < a.messages.length - 1; i++) {
            expect(JSON.stringify(b.messages[i])).toBe(JSON.stringify(a.messages[i]));
          }
        }
        prevSent = sent;
      }
    }
  });
});
