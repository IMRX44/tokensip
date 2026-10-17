/**
 * Live validation of the v2 engine against a real provider.
 *   TOKENSIP_LIVE_BASE_URL / TOKENSIP_LIVE_API_KEY (+ TOKENSIP_LIVE_MODEL, TOKENSIP_LIVE_CACHE_MODEL)
 */
import { createTokenSipFetch, SessionEngine } from "@tokensip/core";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenSipServer, type TokenSipServer } from "../../src/index.js";

const BASE = process.env.TOKENSIP_LIVE_BASE_URL;
const KEY = process.env.TOKENSIP_LIVE_API_KEY;
const MODEL = process.env.TOKENSIP_LIVE_MODEL ?? "deepseek-v4-flash-0731";
const CACHE_MODEL = process.env.TOKENSIP_LIVE_CACHE_MODEL ?? MODEL;

const guidelines = Array.from(
  { length: 220 },
  (_, i) => `Guideline ${i}: keep functions small, typed and tested (rule ${i * 7}).`,
).join("\n");
const system = (clock: string) =>
  `You are a precise assistant.\nCurrent time: ${clock}\n${guidelines}\nAnswer briefly.`;

let ts: TokenSipServer;
let gateway: string;
let vkey: string;

describe.skipIf(!BASE || !KEY)("v2 live", () => {
  beforeAll(async () => {
    ts = await createTokenSipServer({
      config: { dataDir: ":memory:", port: 0, logLevel: "warn", dashboard: false },
      env: {},
    });
    gateway = await ts.listen();
    ts.app.providers.create({ preset: "custom", name: "live", apiKey: KEY, baseUrl: BASE, streamUsage: true });
    vkey = ts.app.keys.create({ name: "v2" }).key;
  });
  afterAll(async () => {
    await ts?.close();
  });

  /** Runs a 5-turn conversation whose system prompt carries a clock; returns cached tokens per turn. */
  async function leakySession(
    profile: string,
    tag: string,
  ): Promise<{ cached: number[]; prompt: number[]; leaks: (string | null)[] }> {
    const client = new OpenAI({
      baseURL: `${gateway}/v1`,
      apiKey: vkey,
      maxRetries: 0,
      defaultHeaders: { "x-tokensip-profile": profile },
    });
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "user", content: `Session ${tag}: say "ok".` }];
    const cached: number[] = [];
    const prompt: number[] = [];
    const leaks: (string | null)[] = [];
    for (let turn = 0; turn < 5; turn++) {
      const clock = new Date(Date.UTC(2026, 9, 16, 10, turn, turn * 7)).toISOString();
      const { data, response } = await client.chat.completions
        .create({
          model: CACHE_MODEL,
          max_tokens: 800,
          messages: [{ role: "system", content: system(clock) }, ...messages],
        })
        .withResponse();
      cached.push(data.usage?.prompt_tokens_details?.cached_tokens ?? 0);
      prompt.push(data.usage?.prompt_tokens ?? 0);
      leaks.push(response.headers.get("x-tokensip-cache-leak"));
      messages.push(
        { role: "assistant", content: data.choices[0]?.message.content ?? "ok" },
        { role: "user", content: `Turn ${turn + 2}: say "ok".` },
      );
    }
    return { cached, prompt, leaks };
  }

  it("Cache Doctor turns a leaking system prompt into real provider cache hits", async () => {
    const tag = Date.now().toString(36);
    const without = await leakySession("safe", `${tag}-a`);
    const withDoctor = await leakySession("balanced", `${tag}-b`);
    const share = (r: { cached: number[]; prompt: number[] }) =>
      r.cached.slice(2).reduce((a, b) => a + b, 0) /
      Math.max(
        1,
        r.prompt.slice(2).reduce((a, b) => a + b, 0),
      );
    process.stderr.write(
      `\n[v2 live] cached tokens per turn — safe: ${without.cached.join(", ")} (prompt ${without.prompt.join(", ")})` +
        `\n[v2 live] cached tokens per turn — balanced: ${withDoctor.cached.join(", ")} (prompt ${withDoctor.prompt.join(", ")})` +
        `\n[v2 live] cache-read share turns 3-5: safe ${(share(without) * 100).toFixed(0)}% → balanced ${(share(withDoctor) * 100).toFixed(0)}%\n`,
    );
    expect(withDoctor.leaks[1]).toMatch(/^timestamp/);
    expect(share(withDoctor)).toBeGreaterThan(share(without) + 0.3);
  });

  it("a real model answers from the newest observation after the outdated one is removed", async () => {
    const engine = new SessionEngine({ schedule: "eager" });
    let lastReport: unknown;
    const client = new OpenAI({
      baseURL: BASE,
      apiKey: KEY,
      maxRetries: 0,
      fetch: createTokenSipFetch({ profile: "balanced", sessions: engine, onReport: (r) => (lastReport = r) }),
    });
    const v1 = Array.from({ length: 60 }, (_, i) => `export const LIMIT_${i} = ${i === 7 ? 100 : i};`).join("\n");
    const v2 = v1.replace("LIMIT_7 = 100", "LIMIT_7 = 250");
    const tools: OpenAI.Chat.ChatCompletionTool[] = [
      {
        type: "function",
        function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } },
      },
      {
        type: "function",
        function: {
          name: "edit_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
          },
        },
      },
    ];
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: "You are a coding agent. Use the tool results as ground truth." },
      { role: "user", content: "Raise LIMIT_7 in src/limits.ts to 250." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"src/limits.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: v1 },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c2",
            type: "function",
            function: {
              name: "edit_file",
              arguments: '{"path":"src/limits.ts","old":"LIMIT_7 = 100","new":"LIMIT_7 = 250"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "c2", content: "Edited src/limits.ts" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c3", type: "function", function: { name: "read_file", arguments: '{"path":"src/limits.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c3", content: v2 },
      {
        role: "user",
        content:
          "What is the value of LIMIT_7 in the file now, and what was it before your edit? Answer as: now=<n> before=<n>.",
      },
    ];
    const r = await client.chat.completions.create({ model: MODEL, max_tokens: 1500, messages, tools });
    const answer = r.choices[0]?.message.content ?? "";
    process.stderr.write(`\n[v2 live] model answer with superseded read removed: ${JSON.stringify(answer)}\n`);
    expect((lastReport as { tokensSaved: number }).tokensSaved).toBeGreaterThan(200);
    expect(answer).toMatch(/now\s*=\s*250/);
    expect(answer).toMatch(/before\s*=\s*100/); // recoverable from its own edit call
  });
});
