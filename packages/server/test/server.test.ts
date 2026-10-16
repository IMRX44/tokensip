import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenSipServer, type TokenSipServer } from "../src/index.js";

interface Seen {
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let upstream: Server;
let upstreamUrl: string;
const seen: Seen[] = [];
let ts: TokenSipServer;
let base: string;
let vkey: string;

function mockUpstream(req: IncomingMessage, body: string, res: import("node:http").ServerResponse) {
  const json = body ? JSON.parse(body) : {};
  if (req.url?.endsWith("/chat/completions")) {
    if (json.model === "lingering-stream") {
      // Sends the whole answer and [DONE], then keeps the connection open for a while.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      setTimeout(() => res.end(), 1500);
      return;
    }
    if (json.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: "Hel" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { content: "lo" } }] })}\n\n`);
      if (json.stream_options?.include_usage) {
        res.write(
          `data: ${JSON.stringify({ id: "1", choices: [], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 64 } } })}\n\n`,
        );
      }
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_123" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-1",
        choices: [{ index: 0, message: { role: "assistant", content: "Hi!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 } },
      }),
    );
    return;
  }
  if (req.url?.endsWith("/v1/messages")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0, output_tokens: 1 } } })}\n\n`,
    );
    res.write(
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
    );
    res.end(
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 5 } })}\n\n`,
    );
    return;
  }
  if (req.url?.endsWith("/embeddings")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }], usage: { prompt_tokens: 3, total_tokens: 3 } }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.setEncoding("latin1");
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      if (req.headers["content-encoding"]) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, encoding: req.headers["content-encoding"] }));
        return;
      }
      mockUpstream(req, body, res);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  ts = await createTokenSipServer({
    config: { dataDir: ":memory:", port: 0, logLevel: "silent", dashboard: false, allowPassthrough: true },
    env: {},
  });
  base = await ts.listen();
  ts.app.providers.create({
    preset: "openai",
    name: "OpenAI (mock)",
    apiKey: "sk-upstream-secret",
    baseUrl: `${upstreamUrl}/v1`,
  });
  ts.app.providers.create({
    preset: "anthropic",
    name: "Anthropic (mock)",
    apiKey: "sk-ant-upstream",
    anthropicBaseUrl: upstreamUrl,
  });
  vkey = ts.app.keys.create({ name: "test" }).key;
});

afterAll(async () => {
  await ts?.close();
  upstream?.close();
});

const last = () => seen[seen.length - 1] as Seen;

async function chat(body: unknown, headers: Record<string, string> = {}, path = "/v1/chat/completions") {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${vkey}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("admin auth", () => {
  it("requires the one-time setup token, then enforces CSRF", async () => {
    let r = await fetch(`${base}/api/auth/state`);
    expect((await r.json()).setupRequired).toBe(true);

    r = await fetch(`${base}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong", password: "correct horse battery" }),
    });
    expect(r.status).toBe(403);

    r = await fetch(`${base}/api/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ts.app.setupToken, password: "correct horse battery" }),
    });
    expect(r.status).toBe(200);
    const { csrfToken } = await r.json();
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
    expect(r.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(r.headers.get("set-cookie")).toMatch(/SameSite=Strict/i);

    r = await fetch(`${base}/api/settings`, { headers: { cookie } });
    expect(r.status).toBe(200);

    r = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ retentionDays: 10 }),
    });
    expect(r.status).toBe(403);

    r = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ retentionDays: 10 }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).retentionDays).toBe(10);

    r = await fetch(`${base}/api/providers`);
    expect(r.status).toBe(401);
  });

  it("sets strict security headers on the dashboard API", async () => {
    const r = await fetch(`${base}/api/auth/state`);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("proxy", () => {
  it("swaps the virtual key for the provider key and records usage", async () => {
    const r = await chat({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(200);
    expect((await r.json()).choices[0].message.content).toBe("Hi!");
    expect(r.headers.get("x-request-id")).toBe("req_123");
    expect(r.headers.get("x-tokensip-provider")).toBe("openai");
    expect(last().headers.authorization).toBe("Bearer sk-upstream-secret");
    expect(last().path).toBe("/v1/chat/completions");

    const row = ts.app.requests.list({ limit: 1 })[0] as Record<string, number>;
    expect(row.cache_read_tokens).toBe(800);
    expect(row.input_tokens).toBe(200);
    expect(row.cost).toBeGreaterThan(0);
    expect(row.baseline_cost).toBeGreaterThan(row.cost);
  });

  it("forwards unchanged requests byte-for-byte", async () => {
    const raw = '{"model":"gpt-4.1",   "messages":[{"role":"user","content":"exact bytes"}]}';
    await chat(raw);
    expect(last().body).toBe(raw);
  });

  it("hides the injected stream-usage chunk from the client but records usage", async () => {
    const r = await chat({ model: "gpt-4.1", stream: true, messages: [{ role: "user", content: "stream please" }] });
    const text = await r.text();
    expect(JSON.parse(last().body).stream_options).toEqual({ include_usage: true });
    expect(text).toContain('"Hel"');
    expect(text).not.toContain('"choices":[]');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    const row = ts.app.requests.list({ limit: 1 })[0] as Record<string, number>;
    expect(row.input_tokens).toBe(36);
    expect(row.output_tokens).toBe(2);
    expect(row.estimated).toBe(0);
  });

  it("keeps client-requested stream usage untouched", async () => {
    const r = await chat({
      model: "gpt-4.1",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "x" }],
    });
    expect(await r.text()).toContain('"choices":[]');
  });

  it("serves deterministic repeats from the encrypted response cache", async () => {
    const body = { model: "gpt-4.1", temperature: 0, messages: [{ role: "user", content: "cache me" }] };
    const before = seen.length;
    const a = await chat(body);
    expect(a.headers.get("x-tokensip-cache")).toBe("MISS");
    await a.text();
    const b = await chat(body);
    expect(b.headers.get("x-tokensip-cache")).toBe("HIT");
    expect((await b.json()).choices[0].message.content).toBe("Hi!");
    expect(seen.length - before).toBe(1);
    const c = await chat(body, { "x-tokensip-cache": "bypass" });
    await c.text();
    expect(seen.length - before).toBe(2);
  });

  it("routes Anthropic requests natively and adds cache breakpoints", async () => {
    const r = await chat(
      {
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        stream: true,
        system: "Rules. ".repeat(1200),
        messages: [{ role: "user", content: "hello" }],
      },
      { authorization: "", "x-api-key": vkey, "anthropic-version": "2023-06-01" },
      "/anthropic/v1/messages",
    );
    expect(r.status).toBe(200);
    await r.text();
    expect(last().headers["x-api-key"]).toBe("sk-ant-upstream");
    expect(last().headers.authorization).toBeUndefined();
    const sent = JSON.parse(last().body);
    expect(sent.system[0].cache_control).toEqual({ type: "ephemeral" });
    const row = ts.app.requests.list({ limit: 1 })[0] as Record<string, number>;
    expect(row.cache_read_tokens).toBe(3000);
    expect(row.output_tokens).toBe(5);
  });

  it("warns when a lossy profile is used", async () => {
    const r = await chat(
      { model: "gpt-4.1", max_completion_tokens: 9000, messages: [{ role: "user", content: "x" }] },
      { "x-tokensip-profile": "extreme" },
    );
    await r.text();
    expect(r.headers.get("x-tokensip-profile")).toBe("extreme");
    expect(r.headers.get("x-tokensip-warning")).toMatch(/lossy optimization/);
    expect(JSON.parse(last().body).max_completion_tokens).toBe(1024);
  });

  it("rejects unknown virtual keys in the client's error format", async () => {
    const r = await chat(
      { model: "claude-x", messages: [] },
      { authorization: "", "x-api-key": "tsk_nope" },
      "/anthropic/v1/messages",
    );
    expect(r.status).toBe(401);
    const j = await r.json();
    expect(j.type).toBe("error");
    expect(j.error.type).toBe("authentication_error");
  });

  it("enforces monthly budgets", async () => {
    const { key, record } = ts.app.keys.create({ name: "tiny", monthlyBudgetUsd: 0 });
    const r = await chat(
      { model: "gpt-4.1", messages: [{ role: "user", content: "x" }] },
      { authorization: `Bearer ${key}` },
    );
    expect(r.status).toBe(429);
    expect((await r.json()).error.code).toBe("budget_exceeded");
    ts.app.keys.delete(record.id);
  });

  it("enforces per-key rate limits", async () => {
    const { key } = ts.app.keys.create({ name: "slow", rpm: 1 });
    const body = { model: "gpt-4.1", messages: [{ role: "user", content: "x" }] };
    expect((await chat(body, { authorization: `Bearer ${key}` })).status).toBe(200);
    const r = await chat(body, { authorization: `Bearer ${key}` });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });

  it("passes the client's own key through when passthrough is on", async () => {
    const r = await chat(
      { model: "gpt-4.1", messages: [{ role: "user", content: "x" }] },
      { authorization: "Bearer sk-client-own" },
      "/openai/v1/chat/completions",
    );
    await r.text();
    expect(last().headers.authorization).toBe("Bearer sk-client-own");
  });
});

describe("edge cases", () => {
  it("forwards compressed request bodies with their content-encoding", async () => {
    const { gzipSync } = await import("node:zlib");
    const gz = gzipSync(JSON.stringify({ model: "gpt-4.1", messages: [{ role: "user", content: "x" }] }));
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${vkey}`, "content-type": "application/json", "content-encoding": "gzip" },
      body: gz,
    });
    expect((await r.json()).encoding).toBe("gzip");
    expect(Buffer.from(last().body, "latin1").equals(gz)).toBe(true);
  });

  it("caches embeddings", async () => {
    const body = { model: "text-embedding-3-small", input: `embed-${Date.now()}` };
    const a = await chat(body, {}, "/v1/embeddings");
    await a.text();
    const b = await chat(body, {}, "/v1/embeddings");
    expect(b.headers.get("x-tokensip-cache")).toBe("HIT");
  });

  it("routes the Anthropic format to a custom provider with an Anthropic base URL", async () => {
    const rec = ts.app.providers.create({
      preset: "custom",
      name: "Aggregator",
      apiKey: "agg-secret",
      baseUrl: `${upstreamUrl}/v1`,
      anthropicBaseUrl: upstreamUrl,
    });
    const r = await chat(
      { model: "claude-x", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] },
      { authorization: "", "x-api-key": vkey, "anthropic-version": "2023-06-01" },
      `/p/${rec.id}/v1/messages`,
    );
    expect(r.status).toBe(200);
    await r.text();
    expect(last().path).toBe("/v1/messages");
    expect(last().headers["x-api-key"]).toBe("agg-secret");
    ts.app.providers.delete(rec.id);
  });

  it("only requests stream usage from custom providers that opt in", async () => {
    const off = ts.app.providers.create({
      preset: "custom",
      name: "no-usage",
      apiKey: "k",
      baseUrl: `${upstreamUrl}/v1`,
    });
    const body = { model: "m", stream: true, messages: [{ role: "user", content: "x" }] };
    await (await chat(body, {}, `/p/${off.id}/v1/chat/completions`)).text();
    expect(JSON.parse(last().body).stream_options).toBeUndefined();
    ts.app.providers.update(off.id, { streamUsage: true });
    await (await chat(body, {}, `/p/${off.id}/v1/chat/completions`)).text();
    expect(JSON.parse(last().body).stream_options).toEqual({ include_usage: true });
    ts.app.providers.delete(off.id);
  });
});

describe("stream completion", () => {
  it("finishes at [DONE] even if the provider keeps the connection open, and caches the result", async () => {
    const body = {
      model: "lingering-stream",
      temperature: 0,
      stream: true,
      messages: [{ role: "user", content: `x-${Date.now()}` }],
    };
    const started = Date.now();
    const a = await chat(body);
    const text = await a.text();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).toContain("[DONE]");
    const row = ts.app.requests.list({ limit: 1 })[0] as Record<string, unknown>;
    expect(row.status).toBe(200);
    expect(row.error).toBeNull();
    const b = await chat(body);
    expect(b.headers.get("x-tokensip-cache")).toBe("HIT");
    expect(await b.text()).toBe(text);
  });
});

describe("routing", () => {
  it("sends model names no preset claims to a configured custom gateway", async () => {
    const rec = ts.app.providers.create({
      preset: "custom",
      name: "Aggregator",
      apiKey: "agg-key",
      baseUrl: `${upstreamUrl}/v1`,
    });
    await (await chat({ model: "kimi-k3", messages: [{ role: "user", content: "x" }] })).text();
    expect(last().headers.authorization).toBe("Bearer agg-key");
    // Known families still go to their own provider.
    await (await chat({ model: "gpt-4.1", messages: [{ role: "user", content: "x" }] })).text();
    expect(last().headers.authorization).toBe("Bearer sk-upstream-secret");
    ts.app.providers.delete(rec.id);
  });
});

describe("environment-configured custom provider", () => {
  it("is routable without touching the dashboard", async () => {
    const s = await createTokenSipServer({
      config: { dataDir: ":memory:", port: 0, logLevel: "silent", dashboard: false },
      env: {
        TOKENSIP_CUSTOM_BASE_URL: `${upstreamUrl}/v1`,
        TOKENSIP_CUSTOM_ANTHROPIC_BASE_URL: upstreamUrl,
        TOKENSIP_CUSTOM_API_KEY: "env-secret",
        TOKENSIP_CUSTOM_STREAM_USAGE: "true",
      },
    });
    const url = await s.listen();
    const key = s.app.keys.create({ name: "env" }).key;
    const r = await fetch(`${url}/custom/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "anything", stream: true, messages: [{ role: "user", content: "x" }] }),
    });
    await r.text();
    expect(last().headers.authorization).toBe("Bearer env-secret");
    expect(JSON.parse(last().body).stream_options).toEqual({ include_usage: true });
    const a = await fetch(`${url}/custom/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-x", max_tokens: 5, messages: [{ role: "user", content: "x" }] }),
    });
    await a.text();
    expect(last().headers["x-api-key"]).toBe("env-secret");
    await s.close();
  });
});

describe("server mode", () => {
  it("refuses provider-key passthrough by default", async () => {
    const s = await createTokenSipServer({
      config: { dataDir: ":memory:", port: 0, logLevel: "silent", dashboard: false, mode: "server", host: "127.0.0.1" },
      env: {},
    });
    const url = await s.listen();
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer sk-raw", "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(401);
    expect((await r.json()).error.message).toMatch(/Passthrough/);
    await s.close();
  });
});
