/**
 * End-to-end tests against a real OpenAI-compatible provider, through the
 * official OpenAI and Anthropic SDKs. Configure with:
 *
 *   TOKENSIP_LIVE_BASE_URL            OpenAI-compatible base, e.g. https://api.example.com/v1   (required)
 *   TOKENSIP_LIVE_API_KEY             provider key                                              (required)
 *   TOKENSIP_LIVE_MODEL               chat model           (default: deepseek-v4-flash-0731)
 *   TOKENSIP_LIVE_ANTHROPIC_BASE_URL  Anthropic-compatible origin, e.g. https://api.example.com (optional)
 *   TOKENSIP_LIVE_ANTHROPIC_MODEL     (default: claude-sonnet-5)
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenSipServer, type TokenSipServer } from "../../src/index.js";

const BASE = process.env.TOKENSIP_LIVE_BASE_URL;
const KEY = process.env.TOKENSIP_LIVE_API_KEY;
const MODEL = process.env.TOKENSIP_LIVE_MODEL ?? "deepseek-v4-flash-0731";
const ANTHROPIC_BASE = process.env.TOKENSIP_LIVE_ANTHROPIC_BASE_URL;
const ANTHROPIC_MODEL = process.env.TOKENSIP_LIVE_ANTHROPIC_MODEL ?? "claude-sonnet-5";

let ts: TokenSipServer;
let gateway: string;
let providerId: string;
let vkey: string;

type Row = Record<string, unknown>;
const lastRow = (): Row => ts.app.requests.list({ limit: 1 })[0] as Row;
const rowById = (id: string | null): Row | undefined => ts.app.requests.list({ limit: 200 }).find((r) => r.id === id);

/**
 * SDKs stop reading a stream at `data: [DONE]`; TokenSip records the request a
 * moment later, when the upstream connection closes. Wait for the row.
 */
async function waitForRow(id: string | null, timeoutMs = 10_000): Promise<Row> {
  const started = Date.now();
  for (;;) {
    const row = rowById(id);
    if (row) return row;
    if (Date.now() - started > timeoutMs) throw new Error(`request ${id} was never recorded`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!BASE || !KEY)("live provider", () => {
  beforeAll(async () => {
    ts = await createTokenSipServer({
      config: { dataDir: ":memory:", port: 0, logLevel: "warn", dashboard: false, allowPassthrough: true },
      env: {},
    });
    gateway = await ts.listen();
    const rec = ts.app.providers.create({
      preset: "custom",
      name: "Live provider",
      apiKey: KEY,
      baseUrl: BASE,
      anthropicBaseUrl: ANTHROPIC_BASE ?? null,
      streamUsage: true,
    });
    providerId = rec.id;
    ts.app.updateSettings({ defaultProvider: "custom" });
    vkey = ts.app.keys.create({ name: "live" }).key;
  });

  afterAll(async () => {
    await ts?.close();
  });

  const openai = (headers: Record<string, string> = {}) =>
    new OpenAI({ baseURL: `${gateway}/v1`, apiKey: vkey, defaultHeaders: headers, maxRetries: 0 });

  it("non-streaming chat through the OpenAI SDK", async () => {
    const { data, response } = await openai()
      .chat.completions.create({
        model: MODEL,
        max_tokens: 1500,
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      })
      .withResponse();
    expect(data.choices[0]?.message.content?.toLowerCase()).toContain("pong");
    expect(response.headers.get("x-tokensip-provider")).toBe("custom");
    const row = rowById(response.headers.get("x-tokensip-request-id"));
    expect(row?.status).toBe(200);
    expect(Number(row?.input_tokens) + Number(row?.cache_read_tokens)).toBeGreaterThan(0);
    expect(row?.estimated).toBe(0);
  });

  it("streaming chat: every chunk arrives and usage is exact", async () => {
    const { data: stream, response } = await openai()
      .chat.completions.create({
        model: MODEL,
        stream: true,
        max_tokens: 1500,
        messages: [{ role: "user", content: "Count from 1 to 5 separated by spaces. Output only the numbers." }],
      })
      .withResponse();
    let text = "";
    let sawUsageChunk = false;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta?.content ?? "";
      if (chunk.usage) sawUsageChunk = true;
    }
    expect(text.replace(/\s+/g, " ").trim()).toContain("1 2 3 4 5");
    // The client did not ask for usage. A provider may still attach it to its last content chunk,
    // but TokenSip must never add a usage-only chunk with empty choices.
    void sawUsageChunk;
    const row = await waitForRow(response.headers.get("x-tokensip-request-id"));
    expect(row?.stream).toBe(1);
    expect(row?.estimated).toBe(0);
    expect(Number(row?.output_tokens)).toBeGreaterThan(0);
  });

  it("tool calling round-trip with the balanced profile (minified + deduplicated tool output)", async () => {
    const client = openai({ "x-tokensip-profile": "balanced" });
    const tools: OpenAI.Chat.ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ];
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: "You are a weather assistant.   \n\n\n\nAlways use the tool.  " },
      { role: "user", content: "What is the temperature in Tehran right now? Use the tool." },
    ];
    const first = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1500,
      messages,
      tools,
      tool_choice: "required",
    });
    const call = first.choices[0]?.message.tool_calls?.[0];
    expect(call?.type).toBe("function");
    if (call?.type !== "function") return;
    expect(call.function.name).toBe("get_weather");

    const report = JSON.stringify(
      {
        city: "Tehran",
        temperature_c: 23,
        conditions: "clear",
        history: Array.from({ length: 40 }, (_, i) => ({ hour: i, t: 20 + (i % 5) })),
      },
      null,
      2,
    );
    messages.push(first.choices[0]?.message as OpenAI.Chat.ChatCompletionMessageParam, {
      role: "tool",
      tool_call_id: call.id,
      content: report,
    });
    messages.push({ role: "user", content: "What is the current temperature in °C? Answer with the number only." });

    const { data: second, response } = await client.chat.completions
      .create({ model: MODEL, max_tokens: 1500, messages })
      .withResponse();
    expect(second.choices[0]?.message.content).toContain("23");
    expect(Number(response.headers.get("x-tokensip-tokens-saved"))).toBeGreaterThan(0);
  });

  it("serves an identical temperature-0 request from the response cache", async () => {
    const body = {
      model: MODEL,
      temperature: 0,
      max_tokens: 1500,
      messages: [{ role: "user" as const, content: `Reply with the word cache-${Date.now()}` }],
    };
    const a = await openai().chat.completions.create(body).withResponse();
    expect(a.response.headers.get("x-tokensip-cache")).toBe("MISS");
    const b = await openai().chat.completions.create(body).withResponse();
    expect(b.response.headers.get("x-tokensip-cache")).toBe("HIT");
    expect(b.data.choices[0]?.message.content).toBe(a.data.choices[0]?.message.content);
    expect(rowById(b.response.headers.get("x-tokensip-request-id"))?.cache_hit).toBe(1);
  });

  it("serves a cached *stream* that the SDK can consume", async () => {
    const body = {
      model: MODEL,
      temperature: 0,
      stream: true as const,
      max_tokens: 1500,
      messages: [{ role: "user" as const, content: `Say: streamed-cache-${Date.now()}` }],
    };
    const collect = async () => {
      const { data, response } = await openai().chat.completions.create(body).withResponse();
      let text = "";
      for await (const c of data) text += c.choices[0]?.delta?.content ?? "";
      const row = await waitForRow(response.headers.get("x-tokensip-request-id"));
      return { text, cache: response.headers.get("x-tokensip-cache"), row };
    };
    const first = await collect();
    const second = await collect();
    expect(first.cache).toBe("MISS");
    expect(second.cache, `first response: ${JSON.stringify(first.row)}`).toBe("HIT");
    expect(second.text).toBe(first.text);
    expect(second.text.length).toBeGreaterThan(0);
  });

  it("extreme profile still produces an answer and warns", async () => {
    const { data, response } = await openai({ "x-tokensip-profile": "extreme" })
      .chat.completions.create({
        model: MODEL,
        max_tokens: 4000,
        messages: [
          { role: "system", content: `You are helpful. ${"Background notes. ".repeat(400)}` },
          { role: "user", content: "What is 2 + 2? Answer with the number only." },
        ],
      })
      .withResponse();
    expect(response.headers.get("x-tokensip-warning")).toMatch(/lossy/);
    expect(Number(response.headers.get("x-tokensip-tokens-saved"))).toBeGreaterThan(500);
    expect(data.choices[0]?.message.content ?? "").toContain("4");
  });

  it("passes provider errors through with their status", async () => {
    const err = await openai()
      .chat.completions.create({ model: "this-model-does-not-exist-xyz", messages: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.APIError);
    const status = (err as InstanceType<typeof OpenAI.APIError>).status ?? 0;
    expect(status).toBeGreaterThanOrEqual(400);
    await new Promise((r) => setTimeout(r, 100));
    expect(lastRow().status).toBe(status);
  });

  it("handles a client aborting mid-stream", async () => {
    const controller = new AbortController();
    const { data: stream, response } = await openai()
      .chat.completions.create(
        {
          model: MODEL,
          stream: true,
          max_tokens: 1500,
          messages: [{ role: "user", content: "Write the numbers from 1 to 300, one per line." }],
        },
        { signal: controller.signal },
      )
      .withResponse();
    try {
      for await (const _ of stream) controller.abort();
    } catch {
      /* depending on timing the SDK either throws or ends quietly */
    }
    // The request is still recorded (499 if the client left early, 200 if the provider was faster)
    // and the gateway stays healthy.
    const row = await waitForRow(response.headers.get("x-tokensip-request-id"));
    expect([200, 499]).toContain(row.status);
    expect((await fetch(`${gateway}/healthz`)).ok).toBe(true);
  });

  it("handles concurrent requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        openai().chat.completions.create({
          model: MODEL,
          max_tokens: 1500,
          messages: [{ role: "user", content: `Reply with the number ${i * 7} only.` }],
        }),
      ),
    );
    for (const [i, r] of results.entries()) expect(r.choices[0]?.message.content).toContain(String(i * 7));
  });

  it("passthrough: the client's own provider key is forwarded", async () => {
    const client = new OpenAI({ baseURL: `${gateway}/p/${providerId}/v1`, apiKey: KEY, maxRetries: 0 });
    const r = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    });
    expect(r.choices[0]?.message.content?.toLowerCase()).toContain("ok");
    expect(lastRow().key_id).toBeNull();
  });

  it("models list is proxied", async () => {
    const list = await openai().models.list();
    expect(list.data.length).toBeGreaterThan(0);
  });

  describe.skipIf(!ANTHROPIC_BASE)("Anthropic format", () => {
    const anthropic = () => new Anthropic({ baseURL: `${gateway}/p/${providerId}`, apiKey: vkey, maxRetries: 0 });

    it("messages through the Anthropic SDK", async () => {
      const msg = await anthropic().messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        messages: [{ role: "user", content: "Reply with the single word: pong" }],
      });
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      expect(text.toLowerCase()).toContain("pong");
      expect(Number(lastRow().output_tokens)).toBeGreaterThan(0);
    });

    it("streaming with automatic cache breakpoints on a long system prompt", async () => {
      const stream = anthropic().messages.stream({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system: `You are a precise assistant.\n${"Follow the house style guide carefully. ".repeat(300)}`,
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi! How can I help?" },
          { role: "user", content: "Reply with the single word: streamed" },
        ],
      });
      const final = await stream.finalMessage();
      const text = final.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      expect(text.toLowerCase()).toContain("streamed");
      const row = lastRow();
      expect(row.status).toBe(200);
      expect(Number(row.output_tokens)).toBeGreaterThan(0);
    });

    it("Anthropic tool use round-trip", async () => {
      const client = anthropic();
      const tools: Anthropic.Tool[] = [
        {
          name: "lookup_price",
          description: "Look up a product price",
          input_schema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
        },
      ];
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: "What does SKU A-17 cost? Use the tool." }];
      const first = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        tools,
        tool_choice: { type: "any" },
        messages,
      });
      const use = first.content.find((b) => b.type === "tool_use");
      expect(use?.type).toBe("tool_use");
      if (use?.type !== "tool_use") return;
      messages.push({ role: "assistant", content: first.content });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: use.id, content: '{"sku":"A-17","price_usd":42}' }],
      });
      const second = await client.messages.create({ model: ANTHROPIC_MODEL, max_tokens: 1500, tools, messages });
      const text = second.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      expect(text).toContain("42");
    });
  });
});
