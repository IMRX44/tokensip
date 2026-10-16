/**
 * Cost simulator: replays realistic coding-agent sessions against an exact
 * model of Anthropic's prompt-cache billing and compares strategies.
 *
 * Cache model (per Anthropic's docs): a prefix is cached at each
 * `cache_control` breakpoint; later requests read the longest cached prefix at
 * 0.1× the input price; tokens written at breakpoints cost 1.25×; entries
 * live 5 minutes and are refreshed on every read; tokens after the last
 * breakpoint cost 1×; output costs 5×.
 */
import { createHash } from "node:crypto";
import { optimize } from "./pipeline.js";
import { PriceBook } from "./pricing.js";
import { SessionEngine } from "./session/engine.js";
import type { ProfileId } from "./types.js";

// biome-ignore lint/suspicious/noExplicitAny: the simulator builds and inspects raw, untyped API payloads
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
    pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)] as T,
  };
}

interface Step {
  name: string;
  input: J;
  output: string;
  gapMs: number;
}

const words = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}_${i % 97} = compute(${i});`).join("\n");

/** A coding-agent session on a small repo: reads, edits, re-reads, test runs and searches. */
export function generateSession(seed: number, turns: number, breaks: boolean): Step[] {
  const r = rng(seed);
  const files = Array.from({ length: 6 }, (_, i) => `/repo/src/module${i}.ts`);
  const version = new Map(files.map((f) => [f, 0]));
  const fileText = (f: string) => words(r.int(260, 520), `${f.split("/").pop()}_v${version.get(f)}`);
  const sizes = new Map(files.map((f) => [f, fileText(f).length]));
  void sizes;
  const steps: Step[] = [];
  for (let i = 0; i < turns; i++) {
    const gapMs = breaks && r.next() < 0.08 ? r.int(6, 25) * 60_000 : r.int(4, 40) * 1000;
    const f = r.pick(files);
    const roll = r.next();
    if (roll < 0.38) steps.push({ name: "Read", input: { file_path: f }, output: fileText(f), gapMs });
    else if (roll < 0.62) {
      version.set(f, (version.get(f) ?? 0) + 1);
      steps.push({
        name: "Edit",
        input: { file_path: f, old_string: "a", new_string: "b" },
        output: "The file has been updated.",
        gapMs,
      });
    } else if (roll < 0.82) {
      const failing = r.int(0, 3);
      steps.push({
        name: "Bash",
        input: { command: "npm test" },
        output: `${words(r.int(120, 240), "test")}\n${failing} failing`,
        gapMs,
      });
    } else
      steps.push({
        name: "Grep",
        input: { pattern: r.pick(["compute", "TODO", "export"]), path: "/repo/src" },
        output: words(r.int(40, 140), "match"),
        gapMs,
      });
  }
  return steps;
}

function request(steps: Step[], turn: number, leakyClock: boolean): J {
  const clock = leakyClock
    ? `\nCurrent time: 2026-10-16T${String(9 + Math.floor(turn / 60)).padStart(2, "0")}:${String(turn % 60).padStart(2, "0")}:00Z`
    : "";
  const system = `You are an expert software engineer working in a TypeScript repository.${clock}\n${words(700, "guideline")}`;
  const tools = ["Read", "Edit", "Bash", "Grep", "Glob", "Write"].map((name) => ({
    name,
    description: words(60, name),
    input_schema: { type: "object", properties: { arg: { type: "string" } } },
  }));
  const messages: J[] = [
    { role: "user", content: "The tests in src/ are failing. Find and fix the bugs, then run the tests." },
  ];
  steps.slice(0, turn).forEach((s, i) => {
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: "Next step." },
        { type: "tool_use", id: `toolu_${i}`, name: s.name, input: s.input },
      ],
    });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${i}`, content: s.output }] });
  });
  return { model: "claude-sonnet-4-5", max_tokens: 4096, system, tools, messages };
}

/** Exact-enough model of Anthropic prompt caching. */
class AnthropicCache {
  private readonly entries = new Map<string, number>(); // prefix hash → expiry
  cost = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

  bill(payload: J, now: number, outputTokens: number): void {
    // Flatten to cacheable units in Anthropic's order: tools → system → message blocks.
    const units: { tokens: number; breakpoint: boolean; hash: string }[] = [];
    let chain = "";
    const push = (v: unknown, bp: boolean) => {
      const s = JSON.stringify(v, (k, val) => (k === "cache_control" ? undefined : val));
      chain = createHash("sha1")
        .update(chain + s)
        .digest("hex");
      units.push({ tokens: Math.ceil(s.length / 4), breakpoint: bp, hash: chain });
    };
    for (const t of payload.tools ?? []) push(t, Boolean(t.cache_control));
    const sys = typeof payload.system === "string" ? [{ type: "text", text: payload.system }] : (payload.system ?? []);
    for (const b of sys) push(b, Boolean(b.cache_control));
    for (const m of payload.messages ?? []) {
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      for (const b of blocks) push({ role: m.role, b }, Boolean(b.cache_control));
    }
    // Longest cached prefix still alive.
    let readTo = -1;
    for (let i = units.length - 1; i >= 0; i--) {
      const exp = this.entries.get((units[i] as { hash: string }).hash);
      if (exp !== undefined && exp > now) {
        readTo = i;
        break;
      }
    }
    const lastBp = units.reduce((last, u, i) => (u.breakpoint ? i : last), -1);
    units.forEach((u, i) => {
      if (i <= readTo) this.cost.cacheRead += u.tokens;
      else if (i <= lastBp) this.cost.cacheWrite += u.tokens;
      else this.cost.input += u.tokens;
    });
    // Refresh what was read; create entries at every breakpoint.
    units.forEach((u, i) => {
      if ((i <= readTo && this.entries.has(u.hash)) || u.breakpoint) this.entries.set(u.hash, now + 5 * 60_000);
    });
    this.cost.output += outputTokens;
  }

  dollars(price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }): number {
    const c = this.cost;
    return (
      (c.input * price.input +
        c.cacheRead * price.cacheRead +
        c.cacheWrite * price.cacheWrite +
        c.output * price.output) /
      1e6
    );
  }
}

export interface Strategy {
  name: string;
  profile: ProfileId;
  engine?: "economic" | "eager";
}

export const STRATEGIES: Strategy[] = [
  { name: "No prompt caching", profile: "off" },
  { name: "Prompt caching (TokenSip v1 safe)", profile: "safe" },
  { name: "Caching + naive pruning every turn", profile: "balanced", engine: "eager" },
  { name: "TokenSip v2 (cache-economic)", profile: "balanced", engine: "economic" },
];

export interface SimulationResult {
  strategy: string;
  dollars: number;
  cacheReadShare: number;
  promptTokens: number;
}

export function simulate(
  opts: { sessions?: number; turns?: number; leakyClock?: boolean; breaks?: boolean; seed?: number } = {},
): SimulationResult[] {
  const sessions = opts.sessions ?? 20;
  const turns = opts.turns ?? 60;
  return STRATEGIES.map((strategy) => {
    let dollars = 0;
    let read = 0;
    let prompt = 0;
    for (let s = 0; s < sessions; s++) {
      const steps = generateSession((opts.seed ?? 7) * 1000 + s, turns, opts.breaks ?? true);
      const cache = new AnthropicCache();
      const engine = strategy.engine
        ? new SessionEngine({ prices: () => new PriceBook(), schedule: strategy.engine })
        : undefined;
      let now = 0;
      for (let t = 1; t <= steps.length; t++) {
        now += (steps[t - 1] as Step).gapMs;
        const req = request(steps, t, opts.leakyClock ?? false);
        const sent = engine
          ? (engine.run(req, {
              protocol: "anthropic",
              profile: strategy.profile,
              tenant: "sim",
              now,
              tokenCounting: "approx",
            }).payload as J)
          : (optimize(req, { protocol: "anthropic", profile: strategy.profile, tokenCounting: "approx" }).payload as J);
        cache.bill(sent, now, 350);
      }
      dollars += cache.dollars();
      read += cache.cost.cacheRead;
      prompt += cache.cost.cacheRead + cache.cost.cacheWrite + cache.cost.input;
    }
    return { strategy: strategy.name, dollars, cacheReadShare: prompt ? read / prompt : 0, promptTokens: prompt };
  });
}
