import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenSipServer, type TokenSipServer } from "../src/index.js";

const PASSWORD = "correct horse battery staple";
let ts: TokenSipServer;
let base: string;
let cookie = "";
let csrf = "";

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      cookie,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "x-csrf-token": csrf } : {}),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

beforeAll(async () => {
  ts = await createTokenSipServer({
    config: { dataDir: ":memory:", port: 0, logLevel: "silent", dashboard: false, adminPassword: PASSWORD },
    env: {},
  });
  base = await ts.listen();
  const r = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  csrf = (await r.json()).csrfToken;
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
});

afterAll(async () => {
  await ts?.close();
});

describe("providers API", () => {
  it("requires a base URL for custom providers and validates URLs", async () => {
    expect((await call("POST", "/providers", { preset: "custom", apiKey: "k" })).json.error).toBe("base_url_required");
    expect((await call("POST", "/providers", { preset: "custom", baseUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await call("POST", "/providers", { preset: "nope" })).json.error).toBe("unknown_preset");
  });

  it("never returns provider keys, only a hint", async () => {
    const created = await call("POST", "/providers", {
      preset: "custom",
      name: "Agg",
      apiKey: "sk-very-secret-provider-key-123456",
      baseUrl: "https://api.example.com/v1",
      anthropicBaseUrl: "https://api.example.com",
      streamUsage: true,
    });
    expect(created.status).toBe(200);
    expect(created.text).not.toContain("very-secret");
    expect(created.json.keyHint).toBe("sk-ve…3456");
    expect(created.json.streamUsage).toBe(true);
    const list = await call("GET", "/providers");
    expect(list.text).not.toContain("very-secret");

    const patched = await call("PATCH", `/providers/${created.json.id}`, { streamUsage: null, anthropicBaseUrl: null });
    expect(patched.json.streamUsage).toBeNull();
    expect(patched.json.anthropicBaseUrl).toBeNull();
    expect(ts.app.providers.apiKey(created.json.id)).toBe("sk-very-secret-provider-key-123456");
    expect((await call("DELETE", `/providers/${created.json.id}`)).status).toBe(200);
    expect((await call("DELETE", `/providers/${created.json.id}`)).status).toBe(404);
  });
});

describe("virtual keys API", () => {
  it("shows the key once and never again", async () => {
    const created = await call("POST", "/keys", {
      name: "app",
      monthlyBudgetUsd: 5,
      rpm: 60,
      allowedProviders: ["openai"],
    });
    expect(created.json.key).toMatch(/^tsk_/);
    const list = await call("GET", "/keys");
    expect(list.text).not.toContain(created.json.key);
    expect(list.text).not.toMatch(/"hash"/);
    expect(list.json[0].allowedProviders).toEqual(["openai"]);
    expect((await call("POST", "/keys", { name: "" })).status).toBe(400);
  });
});

describe("settings API", () => {
  it("validates input", async () => {
    expect((await call("PUT", "/settings", { profile: "ultra" })).status).toBe(400);
    expect((await call("PUT", "/settings", { stageOptions: { targetRatio: 5 } })).status).toBe(400);
    expect((await call("PUT", "/settings", { overrides: { "not-a-stage": true } })).status).toBe(400);
    const ok = await call("PUT", "/settings", { profile: "balanced", stageOptions: { targetRatio: 0.2 } });
    expect(ok.json.profile).toBe("balanced");
    expect(ok.json.stageOptions.targetRatio).toBe(0.2);
    // Partial updates keep other stage options.
    const again = await call("PUT", "/settings", { stageOptions: { maxOutputTokens: 512 } });
    expect(again.json.stageOptions).toEqual({ targetRatio: 0.2, maxOutputTokens: 512 });
  });
});

describe("pricing API", () => {
  it("reports price sources and accepts overrides", async () => {
    ts.app.requests.insert({
      id: "r1",
      ts: Date.now(),
      keyId: null,
      tenant: null,
      provider: "custom",
      model: "brand-new-model-9",
      protocol: "openai-chat",
      path: "/v1/chat/completions",
      stream: false,
      status: 200,
      latencyMs: 10,
      ttfbMs: 5,
      overheadMs: 0.1,
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimated: false,
      },
      optimizerSaved: 0,
      cost: 0,
      baselineCost: 0,
      cacheHit: false,
      profile: "safe",
      lossy: false,
      error: null,
    });
    let p = await call("GET", "/pricing");
    expect(p.json.models.find((m: { model: string }) => m.model === "brand-new-model-9").source).toBe("none");
    expect((await call("GET", "/overview?range=24h")).json.unpricedModels).toContain("brand-new-model-9");

    expect((await call("PUT", "/pricing/brand-new-model-9", { input: 1, output: 4 })).status).toBe(200);
    p = await call("GET", "/pricing");
    const m = p.json.models.find((x: { model: string }) => x.model === "brand-new-model-9");
    expect(m.source).toBe("override");
    expect(m.price).toEqual({ input: 1, output: 4 });
    expect(
      ts.app.prices.cost(
        "brand-new-model-9",
        m && {
          inputTokens: 1e6,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          estimated: false,
        },
      ).actual,
    ).toBe(1);
    expect((await call("PUT", "/pricing/x", { input: -1, output: 1 })).status).toBe(400);
    await call("DELETE", "/pricing/brand-new-model-9");
    expect((await call("GET", "/pricing")).json.overrides).toEqual({});
  });
});

describe("optimizer lab API", () => {
  it("optimizes without calling any provider", async () => {
    const r = await call("POST", "/optimize", {
      protocol: "openai-chat",
      profile: "safe",
      payload: { model: "gpt-4.1", messages: [{ role: "user", content: "hi   \n\n\n\n\nthere" }] },
    });
    expect(r.json.payload.messages[0].content).toBe("hi\n\nthere");
    expect(r.json.report.changed).toBe(true);
  });
});

describe("session security", () => {
  it("rejects state changes from another origin even with a valid CSRF token", async () => {
    const r = await call("PUT", "/settings", { retentionDays: 5 }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
  });

  it("logout invalidates the session server-side", async () => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const c = (login.headers.get("set-cookie") ?? "").split(";")[0] as string;
    const token = (await login.json()).csrfToken;
    await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { cookie: c, "x-csrf-token": token } });
    expect((await fetch(`${base}/api/settings`, { headers: { cookie: c } })).status).toBe(401);
  });

  it("throttles password guessing", async () => {
    const attempt = () =>
      fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong-password" }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
