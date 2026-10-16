import { describe, expect, it } from "vitest";
import {
  blocksOf,
  classify,
  detectLeak,
  maskShape,
  PriceBook,
  resourceOf,
  SessionEngine,
  volatileSpan,
} from "../src/index.js";

type J = Record<string, any>;
const MIN = 60_000;
const strip = (v: unknown) => JSON.parse(JSON.stringify(v), (k, val) => (k === "cache_control" ? undefined : val));

describe("resourceOf", () => {
  it.each([
    ["Read", { file_path: "/repo/src/app.ts" }, "file:/repo/src/app.ts", false],
    [
      "Read",
      { file_path: "/repo/src/app.ts", offset: 100, limit: 50 },
      "file:/repo/src/app.ts#offset=100&limit=50",
      true,
    ],
    ["read_file", { path: "./src/app.ts" }, "file:src/app.ts", false],
    ["view", { path: "src/a.py", view_range: [1, 40] }, "file:src/a.py#view_range=[1,40]", true],
    ["shell", { command: ["bash", "-lc", "cat src/app.ts"] }, "file:src/app.ts", false],
    [
      "shell",
      { command: ["bash", "-lc", "sed -n '1,200p' src/app.ts"], workdir: "/repo" },
      "file:/repo/src/app.ts#1,200p",
      true,
    ],
    ["Bash", { command: "npm test" }, "cmd:|npm test", false],
    ["Bash", { command: "git status" }, "cmd:|git status", false],
    ["Grep", { pattern: "foo", path: "src" }, 'call:Grep:[["path","src"],["pattern","foo"]]', false],
  ])("%s %j → %s", (name, args, key, partial) => {
    const r = resourceOf(name, args);
    expect(r?.key).toBe(key);
    expect(r?.partial).toBe(partial);
  });

  it.each([
    ["Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }],
    ["Write", { file_path: "a.ts", content: "x" }],
    ["Bash", { command: "rm -rf build" }],
    ["Bash", { command: "npm install" }],
    ["Bash", { command: "cat a.ts | grep x" }],
    ["Bash", { command: "echo hi > a.txt" }],
    ["shell", { command: ["bash", "-lc", "git commit -m x"] }],
    ["apply_patch", "*** Begin Patch"],
    ["TodoWrite", { todos: [] }],
  ])("%s is an action, not an observation", (name, args) => {
    expect(resourceOf(name, args)).toBeUndefined();
  });
});

describe("cache leak detection", () => {
  it("finds the changing value inside an otherwise stable system prompt", () => {
    const a = "You are a coding agent.\nCurrent time: 2026-10-16T12:00:01Z\nFollow the rules.";
    const b = "You are a coding agent.\nCurrent time: 2026-10-16T12:07:45Z\nFollow the rules.";
    const span = volatileSpan(a, b);
    expect(span?.value).toBe("2026-10-16T12:07:45Z");
    expect(span?.prefix.endsWith("Current time: ")).toBe(true);
    expect(classify("2026-10-16T12:07:45Z")).toBe("timestamp");
    expect(classify("3f2a9c1e-77aa-4b1c-9d00-12ab34cd56ef")).toBe("id");
    expect(maskShape("2026-10-16T12:07:45Z")).toBe("9999-99-99A99:99:99A");
  });

  it("reports leaks only for changes in the stable head, never for normal appends", () => {
    const mk = (sys: string, msgs: J[], tools: J[] = []) =>
      blocksOf("anthropic", { system: sys, messages: msgs, tools });
    const sysA = `Agent rules.\n${"Long guidance. ".repeat(50)}\nRequest id: 7d1c2e9a4b`;
    const sysB = `Agent rules.\n${"Long guidance. ".repeat(50)}\nRequest id: 99ffaa0012`;
    const m1 = [{ role: "user", content: "task" }];
    const m2 = [...m1, { role: "assistant", content: "ok" }, { role: "user", content: "next" }];
    expect(detectLeak(mk(sysA, m1), mk(sysA, m2))).toBeUndefined();
    const leak = detectLeak(mk(sysA, m1), mk(sysB, m2));
    expect(leak?.kind).toBe("id");
    expect(leak?.location).toMatch(/^system\[0\]@/);
    expect(leak?.shape).toBe("99aaaa9999");
    const t1 = [
      { name: "a", input_schema: {} },
      { name: "b", input_schema: {} },
    ];
    expect(detectLeak(mk(sysA, m1, t1), mk(sysA, m2, [...t1].reverse()))?.kind).toBe("tool-order");
    expect(detectLeak(mk(sysA, m1, t1), mk(sysA, m2, [{ input_schema: {}, name: "a" }, t1[1] as J]))?.kind).toBe(
      "json-key-order",
    );
  });
});

// ---------------------------------------------------------------- an agent session, turn by turn

const FILE_V1 = Array.from({ length: 120 }, (_, i) => `export const a${i} = ${i};`).join("\n");
const FILE_V2 = FILE_V1.replace("export const a7 = 7;", "export const a7 = 70;");
const TESTS_FAIL = `${"PASS suite\n".repeat(80)}FAIL suite › a7 should be 70`;
const TESTS_PASS = `${"PASS suite\n".repeat(81)}All tests passed`;

/** Builds the Anthropic request an agent would send after `steps` steps. */
function agentRequest(steps: number, system = "You are a coding agent. Be careful."): J {
  const script: [string, J, string][] = [
    ["Read", { file_path: "/repo/src/a.ts" }, FILE_V1],
    ["Bash", { command: "npm test" }, TESTS_FAIL],
    ["Edit", { file_path: "/repo/src/a.ts", old_string: "a7 = 7", new_string: "a7 = 70" }, "ok"],
    ["Read", { file_path: "/repo/src/a.ts" }, FILE_V2],
    ["Bash", { command: "npm test" }, TESTS_PASS],
    ["Bash", { command: "git status" }, "M src/a.ts"],
  ];
  const messages: J[] = [{ role: "user", content: "Make the a7 test pass." }];
  for (let i = 0; i < steps && i < script.length; i++) {
    const [name, input, out] = script[i] as [string, J, string];
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name, input }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: out }] });
  }
  return {
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    system,
    tools: [
      { name: "Read", input_schema: { type: "object" } },
      { name: "Bash", input_schema: { type: "object" } },
    ],
    messages,
  };
}

const resultOf = (p: J, id: string) => {
  for (const m of p.messages)
    for (const b of Array.isArray(m.content) ? m.content : []) if (b.tool_use_id === id) return b.content;
  return undefined;
};

describe("SessionEngine", () => {
  it("defers removing outdated reads while the cache is warm and the payoff is small, then applies them for free when the cache goes cold", () => {
    const engine = new SessionEngine({ prices: () => new PriceBook() });
    const opts = { protocol: "anthropic" as const, profile: "balanced" as const, tenant: "t" };
    let now = 1_000_000;
    for (let steps = 1; steps <= 3; steps++) engine.run(agentRequest(steps), { ...opts, now: (now += MIN) });

    // Step 4 re-reads a.ts after the edit: the first read (t0) is now outdated.
    const warm = engine.run(agentRequest(4), { ...opts, now: (now += MIN) });
    expect(warm.session?.decision?.pending).toBe(1);
    expect(warm.session?.decision?.applied).toBe(false);
    expect(resultOf(warm.payload as J, "t0")).toBe(FILE_V1);

    // The user steps away for 10 minutes: the provider's cache has expired, so the change is free.
    const cold = engine.run(agentRequest(5), { ...opts, now: (now += 10 * MIN) });
    expect(cold.session?.warm).toBe(false);
    expect(cold.session?.decision?.applied).toBe(true);
    expect(cold.session?.decision?.reason).toMatch(/cold/);
    expect(resultOf(cold.payload as J, "t0")).toMatch(/superseded.*t3/);
    expect(resultOf(cold.payload as J, "t1")).toMatch(/superseded.*t4/); // npm test re-run
    expect(resultOf(cold.payload as J, "t3")).toBe(FILE_V2); // the latest read is untouched
    expect(resultOf(cold.payload as J, "t4")).toBe(TESTS_PASS);

    // Sticky: the next turn keeps the replacements, so the prefix the provider cached stays identical.
    const next = engine.run(agentRequest(6), { ...opts, now: (now += MIN) });
    const a = strip(cold.payload) as J;
    const b = strip(next.payload) as J;
    expect(JSON.stringify(b.messages.slice(0, a.messages.length))).toBe(JSON.stringify(a.messages));
  });

  it("applies immediately when the provider does not cache (learned from reported usage)", () => {
    const engine = new SessionEngine();
    const opts = { protocol: "anthropic" as const, profile: "balanced" as const, tenant: "t" };
    let now = 0;
    let last: ReturnType<SessionEngine["run"]> | undefined;
    for (let steps = 1; steps <= 4; steps++) {
      last = engine.run(agentRequest(steps), { ...opts, now: (now += MIN) });
      engine.observe(last.session?.id as string, {
        inputTokens: 3000,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimated: false,
      });
    }
    expect(last?.session?.decision?.applied).toBe(true);
    expect(resultOf(last?.payload as J, "t0")).toMatch(/superseded/);
  });

  it("repairs a clock in the system prompt so the prefix becomes cacheable", () => {
    const engine = new SessionEngine();
    const opts = { protocol: "anthropic" as const, profile: "balanced" as const, tenant: "t" };
    const sys = (t: string) =>
      `You are a coding agent.\n${"Project rules. ".repeat(80)}\nCurrent time: ${t}\nBe precise.`;
    const r1 = engine.run(agentRequest(1, sys("2026-10-16T10:00:00Z")), { ...opts, now: MIN });
    const r2 = engine.run(agentRequest(2, sys("2026-10-16T10:01:13Z")), { ...opts, now: 2 * MIN });
    expect(r1.session?.leak).toBeUndefined();
    expect(r2.session?.leak?.kind).toBe("timestamp");
    const r3 = engine.run(agentRequest(3, sys("2026-10-16T10:02:40Z")), { ...opts, now: 3 * MIN });
    const r4 = engine.run(agentRequest(4, sys("2026-10-16T10:03:59Z")), { ...opts, now: 4 * MIN });
    const p3 = strip(r3.payload) as J;
    const p4 = strip(r4.payload) as J;
    expect(JSON.stringify(p3.system)).not.toContain("10:02:40");
    expect(JSON.stringify(p3.system)).toBe(JSON.stringify(p4.system)); // stable prefix
    expect(r3.session?.repairs).toContain("volatile system value relocated");
  });

  it("canonicalizes tools once the client is seen reshuffling them", () => {
    const engine = new SessionEngine();
    const opts = { protocol: "anthropic" as const, profile: "safe" as const, tenant: "t" };
    const r1 = agentRequest(1);
    const r2 = agentRequest(2);
    r2.tools = [...r2.tools].reverse();
    engine.run(r1, { ...opts, now: MIN });
    const out2 = engine.run(r2, { ...opts, now: 2 * MIN });
    expect(out2.session?.leak?.kind).toBe("tool-order");
    const r3 = agentRequest(3);
    const out3 = engine.run(r3, { ...opts, now: 3 * MIN });
    const r4 = agentRequest(4);
    r4.tools = [...r4.tools].reverse();
    const out4 = engine.run(r4, { ...opts, now: 4 * MIN });
    expect(JSON.stringify((out3.payload as J).tools.map((t: J) => t.name))).toBe(JSON.stringify(["Bash", "Read"]));
    expect(JSON.stringify(strip((out3.payload as J).tools))).toBe(JSON.stringify(strip((out4.payload as J).tools)));
  });

  it("keeps conversations of different tenants apart and forgets idle ones", () => {
    const engine = new SessionEngine({ maxSessions: 2 });
    const a = engine.run(agentRequest(1), { protocol: "anthropic", tenant: "a", now: 0 });
    const b = engine.run(agentRequest(1), { protocol: "anthropic", tenant: "b", now: 0 });
    expect(a.session?.id).not.toBe(b.session?.id);
    engine.run(
      { ...agentRequest(1), messages: [{ role: "user", content: "other" }] },
      { protocol: "anthropic", tenant: "c", now: 0 },
    );
    expect(engine.size).toBe(2);
  });
});
