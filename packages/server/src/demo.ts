import { randomUUID } from "node:crypto";
import { emptyUsage, type Usage } from "@tokensip/core";
import type { TokenSipApp } from "./app.js";

interface Mix {
  model: string;
  provider: string;
  protocol: string;
  weight: number;
  prompt: [number, number];
  output: [number, number];
  /** Share of the prompt served from the provider's prompt cache. */
  cached: [number, number];
  /** Share of the prompt trimmed by TokenSip optimizers. */
  trimmed: [number, number];
}

const MIX: Mix[] = [
  {
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    protocol: "anthropic",
    weight: 30,
    prompt: [18000, 90000],
    output: [300, 2500],
    cached: [0.7, 0.93],
    trimmed: [0.05, 0.25],
  },
  {
    model: "gpt-4.1",
    provider: "openai",
    protocol: "openai-chat",
    weight: 22,
    prompt: [4000, 40000],
    output: [200, 1500],
    cached: [0.4, 0.85],
    trimmed: [0.05, 0.3],
  },
  {
    model: "gpt-5-mini",
    provider: "openai",
    protocol: "openai-responses",
    weight: 18,
    prompt: [2000, 20000],
    output: [200, 3000],
    cached: [0.3, 0.8],
    trimmed: [0.02, 0.2],
  },
  {
    model: "gemini-2.5-flash",
    provider: "google",
    protocol: "gemini",
    weight: 14,
    prompt: [3000, 30000],
    output: [150, 1200],
    cached: [0.2, 0.6],
    trimmed: [0.02, 0.15],
  },
  {
    model: "deepseek-chat",
    provider: "deepseek",
    protocol: "openai-chat",
    weight: 10,
    prompt: [3000, 25000],
    output: [200, 1500],
    cached: [0.5, 0.9],
    trimmed: [0.05, 0.25],
  },
  {
    model: "claude-haiku-4-5",
    provider: "anthropic",
    protocol: "anthropic",
    weight: 6,
    prompt: [1500, 9000],
    output: [80, 600],
    cached: [0.5, 0.9],
    trimmed: [0.02, 0.1],
  },
];

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pick(): Mix {
  const total = MIX.reduce((s, m) => s + m.weight, 0);
  let r = Math.random() * total;
  for (const m of MIX) {
    r -= m.weight;
    if (r <= 0) return m;
  }
  return MIX[0] as Mix;
}

/** Fill a fresh data directory with realistic synthetic traffic for demos and screenshots. */
export function seedDemo(app: TokenSipApp, days = 30): number {
  const keys = [
    app.keys.create({ name: "production-agent", monthlyBudgetUsd: 500, rpm: 600 }).record,
    app.keys.create({ name: "support-bot", profile: "balanced", monthlyBudgetUsd: 120 }).record,
    app.keys.create({ name: "batch-summaries", profile: "extreme", rpm: 120 }).record,
  ];
  app.providers.create({ preset: "openai", name: "OpenAI", apiKey: "sk-demo-not-a-real-key-0000" });
  app.providers.create({ preset: "anthropic", name: "Anthropic", apiKey: "sk-ant-demo-not-a-real-key" });
  app.providers.create({ preset: "deepseek", name: "DeepSeek", apiKey: "sk-demo-deepseek-0000" });

  const now = Date.now();
  let count = 0;
  app.db.exec("BEGIN");
  for (let d = days; d >= 0; d--) {
    // Gentle growth over the month plus a weekday/weekend rhythm.
    const dayStart = now - d * 864e5;
    const weekday = new Date(dayStart).getUTCDay();
    const volume = Math.round((weekday === 0 || weekday === 6 ? 60 : 140) * (1 + (days - d) / days));
    for (let i = 0; i < volume; i++) {
      const hour = Math.min(23, Math.max(0, Math.round(rand(6, 22) + rand(-2, 2))));
      const ts = dayStart - (dayStart % 864e5) + hour * 3_600_000 + Math.floor(rand(0, 3_600_000));
      if (ts > now) continue;
      const m = pick();
      const key = keys[Math.floor(Math.random() * keys.length)] as (typeof keys)[number];
      const lossy = key.profile === "extreme";
      const prompt = Math.round(rand(...m.prompt));
      const trimmed = Math.round(prompt * (lossy ? rand(0.6, 0.9) : rand(...m.trimmed)));
      const sent = prompt - trimmed;
      const cached = Math.round(sent * rand(...m.cached));
      const cacheHit = Math.random() < 0.06;
      const usage: Usage = {
        ...emptyUsage(),
        inputTokens: m.provider === "anthropic" ? Math.round((sent - cached) * 0.85) : sent - cached,
        cacheWriteTokens: m.provider === "anthropic" ? Math.round((sent - cached) * 0.15) : 0,
        cacheReadTokens: cached,
        outputTokens: Math.round(rand(...m.output) * (lossy ? 0.4 : 1)),
      };
      const status = Math.random() < 0.012 ? 429 : Math.random() < 0.006 ? 500 : 200;
      const cost = app.prices.cost(m.model, usage, trimmed);
      app.requests.insert({
        id: randomUUID(),
        ts,
        keyId: key.id,
        tenant: `key:${key.id}`,
        provider: m.provider,
        model: m.model,
        protocol: m.protocol,
        path:
          m.protocol === "anthropic"
            ? "/v1/messages"
            : m.protocol === "gemini"
              ? `/v1beta/models/${m.model}:streamGenerateContent`
              : m.protocol === "openai-responses"
                ? "/v1/responses"
                : "/v1/chat/completions",
        stream: Math.random() < 0.7,
        status,
        latencyMs: cacheHit ? rand(3, 12) : rand(600, 14000),
        ttfbMs: cacheHit ? rand(2, 8) : rand(250, 1800),
        overheadMs: Math.round(rand(0.1, lossy ? 9 : 3.5) * 100) / 100,
        usage: status === 200 ? usage : emptyUsage(),
        optimizerSaved: status === 200 ? trimmed : 0,
        cost: status === 200 && !cacheHit ? cost.actual : 0,
        baselineCost: status === 200 ? cost.baseline : 0,
        cacheHit: status === 200 && cacheHit,
        profile: key.profile ?? "safe",
        lossy,
        error: status === 200 ? null : status === 429 ? "rate limited by provider" : "upstream error",
      });
      count++;
    }
  }
  app.db.exec("COMMIT");
  return count;
}
