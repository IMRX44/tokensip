import {
  DEFAULT_STAGE_OPTIONS,
  optimize,
  PROFILE_INFO,
  PROFILES,
  PROVIDER_BY_ID,
  PROVIDERS,
  STAGES,
  VERSION,
} from "@tokensip/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TokenSipApp } from "../app.js";
import type { Range } from "../store.js";
import { requireSession } from "./auth.js";

const profileEnum = z.enum(["off", "safe", "balanced", "aggressive", "extreme"]);
const stageIds = STAGES.map((s) => s.id) as [string, ...string[]];
const stageEnum = z.enum(stageIds);
const httpUrl = z
  .string()
  .max(500)
  .refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v), "must be an http(s) URL");

const settingsSchema = z
  .object({
    profile: profileEnum,
    overrides: z.record(stageEnum, z.boolean()),
    stageOptions: z
      .object({
        dedupeMinTokens: z.number().int().min(20).max(100_000),
        keepRecentSteps: z.number().int().min(1).max(200),
        maxStaleToolTokens: z.number().int().min(50).max(200_000),
        maxMessages: z.number().int().min(4).max(10_000),
        minCacheableTokens: z.number().int().min(0).max(100_000),
        targetRatio: z.number().min(0.02).max(1),
        minBudgetTokens: z.number().int().min(64).max(200_000),
        maxOutputTokens: z.number().int().min(16).max(200_000),
        reasoningEffort: z.enum(["minimal", "low", "medium"]),
        maxThinkingTokens: z.number().int().min(0).max(200_000),
      })
      .partial(),
    responseCache: z
      .object({
        enabled: z.boolean(),
        ttlSeconds: z
          .number()
          .int()
          .min(10)
          .max(30 * 86400),
        onlyDeterministic: z.boolean(),
        maxEntryKb: z
          .number()
          .int()
          .min(1)
          .max(64 * 1024),
      })
      .partial(),
    streamUsage: z.boolean(),
    allowProfileHeader: z.boolean(),
    retentionDays: z.number().int().min(1).max(3650),
    defaultProvider: z.string().max(64).nullable(),
  })
  .partial();

const keySchema = z.object({
  name: z.string().min(1).max(100),
  profile: profileEnum.nullable().optional(),
  monthlyBudgetUsd: z.number().min(0).max(1e9).nullable().optional(),
  rpm: z.number().int().min(1).max(1e6).nullable().optional(),
  allowedProviders: z.array(z.string().max(64)).max(50).nullable().optional(),
  expiresAt: z.number().int().nullable().optional(),
  enabled: z.boolean().optional(),
});

const priceSchema = z.object({
  input: z.number().min(0).max(10_000),
  output: z.number().min(0).max(10_000),
  cacheRead: z.number().min(0).max(10_000).optional(),
  cacheWrite: z.number().min(0).max(10_000).optional(),
});

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

export async function adminRoutes(fastify: FastifyInstance, { app }: { app: TokenSipApp }) {
  fastify.addHook("preHandler", requireSession(app));
  const ip = (req: { ip: string }) => req.ip;

  // ------------------------------------------------------------ catalog

  fastify.get("/catalog", async () => ({
    version: VERSION,
    mode: app.config.mode,
    passthrough: app.config.allowPassthrough,
    vaultSource: app.vaultSource,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      surfaces: Object.fromEntries(
        Object.entries(p.surfaces).map(([k, v]) => [k, { baseUrl: v.baseUrl, auth: v.auth }]),
      ),
      modelPatterns: p.modelPatterns ?? [],
      local: Boolean(p.local),
      requiresBaseUrl: Boolean(p.requiresBaseUrl),
      autoPrefixCache: Boolean(p.autoPrefixCache),
      docsUrl: p.docsUrl,
      keyUrl: p.keyUrl,
    })),
    stages: STAGES.map((s) => ({
      id: s.id,
      safety: s.safety,
      description: s.description,
      protocols: s.protocols ?? null,
    })),
    profiles: Object.entries(PROFILES).map(([id, stages]) => ({
      ...PROFILE_INFO[id as keyof typeof PROFILE_INFO],
      stages,
    })),
    stageDefaults: DEFAULT_STAGE_OPTIONS,
  }));

  // ------------------------------------------------------------ analytics

  fastify.get("/overview", async (req) => {
    const q = req.query as { range?: string };
    const range = (["24h", "7d", "30d", "90d"].includes(q.range ?? "") ? q.range : "7d") as Range;
    const o = app.requests.overview(range);
    const t = o.totals;
    const cost = num(t.cost);
    const baseline = num(t.baseline_cost);
    return {
      range,
      bucketMs: o.bucketMs,
      since: o.since,
      totals: {
        requests: num(t.requests),
        errors: num(t.errors),
        inputTokens: num(t.input_tokens),
        outputTokens: num(t.output_tokens),
        cacheReadTokens: num(t.cache_read_tokens),
        cacheWriteTokens: num(t.cache_write_tokens),
        reasoningTokens: num(t.reasoning_tokens),
        optimizerSaved: num(t.optimizer_saved),
        cacheHits: num(t.cache_hits),
        cacheHitTokens: num(t.cache_hit_tokens),
        cost,
        baselineCost: baseline,
        saved: baseline - cost,
        savingsRate: baseline > 0 ? (baseline - cost) / baseline : 0,
        avgOverheadMs: num(t.avg_overhead_ms),
        avgLatencyMs: num(t.avg_latency_ms),
      },
      series: o.series.map((r) => ({
        t: num(r.bucket),
        requests: num(r.requests),
        promptTokens: num(r.prompt_tokens),
        outputTokens: num(r.output_tokens),
        savedTokens: num(r.saved_tokens),
        cost: num(r.cost),
        baselineCost: num(r.baseline_cost),
      })),
      byModel: o.byModel.map((r) => ({
        model: r.model,
        provider: r.provider,
        requests: num(r.requests),
        promptTokens: num(r.prompt_tokens),
        outputTokens: num(r.output_tokens),
        cacheReadTokens: num(r.cache_read_tokens),
        optimizerSaved: num(r.optimizer_saved),
        cost: num(r.cost),
        baselineCost: num(r.baseline_cost),
      })),
      byProvider: o.byProvider.map((r) => ({
        provider: r.provider,
        requests: num(r.requests),
        cost: num(r.cost),
        baselineCost: num(r.baseline_cost),
      })),
      cache: app.cache.stats(),
    };
  });

  fastify.get("/requests", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(200, Math.max(1, Number(q.limit ?? 50)));
    const rows = app.requests.list({
      limit,
      before: q.before ? Number(q.before) : undefined,
      keyId: q.keyId || undefined,
      provider: q.provider || undefined,
      status: q.status === "ok" || q.status === "error" ? q.status : undefined,
    });
    const keyNames = new Map(app.keys.list().map((k) => [k.id, k.name]));
    return {
      items: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        key: r.key_id ? (keyNames.get(r.key_id as string) ?? "deleted key") : r.tenant ? "passthrough" : null,
        provider: r.provider,
        model: r.model,
        protocol: r.protocol,
        path: r.path,
        stream: r.stream === 1,
        status: r.status,
        latencyMs: r.latency_ms,
        ttfbMs: r.ttfb_ms,
        overheadMs: r.overhead_ms,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        cacheWriteTokens: r.cache_write_tokens,
        estimated: r.estimated === 1,
        optimizerSaved: r.optimizer_saved,
        cost: r.cost,
        baselineCost: r.baseline_cost,
        cacheHit: r.cache_hit === 1,
        profile: r.profile,
        lossy: r.lossy === 1,
        error: r.error,
      })),
      nextBefore: rows.length === limit ? rows[rows.length - 1]?.ts : null,
    };
  });

  // ------------------------------------------------------------ providers

  fastify.get("/providers", async () => [...app.providers.list(), ...app.listEnvProviders()]);

  fastify.post("/providers", async (req, reply) => {
    const body = z
      .object({
        preset: z.string().max(64),
        name: z.string().min(1).max(100).optional(),
        apiKey: z.string().max(4096).optional().nullable(),
        baseUrl: httpUrl.optional().nullable(),
        anthropicBaseUrl: httpUrl.optional().nullable(),
        priority: z.number().int().min(0).max(10_000).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input", issues: body.error.issues });
    const preset = PROVIDER_BY_ID.get(body.data.preset);
    if (!preset) return reply.code(400).send({ error: "unknown_preset" });
    if (preset.requiresBaseUrl && !body.data.baseUrl) return reply.code(400).send({ error: "base_url_required" });
    const rec = app.providers.create({ ...body.data, name: body.data.name ?? preset.name });
    app.audit.add("provider.created", { id: rec.id, preset: rec.preset }, ip(req));
    return rec;
  });

  fastify.patch("/providers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).max(100),
        apiKey: z.string().max(4096).nullable(),
        baseUrl: httpUrl.nullable(),
        anthropicBaseUrl: httpUrl.nullable(),
        enabled: z.boolean(),
        priority: z.number().int().min(0).max(10_000),
      })
      .partial()
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input", issues: body.error.issues });
    const rec = app.providers.update(id, body.data);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    app.audit.add("provider.updated", { id, fields: Object.keys(body.data) }, ip(req));
    return rec;
  });

  fastify.delete("/providers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!app.providers.delete(id)) return reply.code(404).send({ error: "not_found" });
    app.audit.add("provider.deleted", { id }, ip(req));
    return { ok: true };
  });

  fastify.post("/providers/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = app.configured().find((c) => c.record.id === id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    const surface = p.preset.surfaces.openai ? "openai" : p.preset.surfaces.anthropic ? "anthropic" : "gemini";
    const s = app.surfaceOf(p.preset, surface, p.record);
    if (!s) return { ok: false, status: 0, message: "No base URL configured" };
    const key = p.apiKey();
    const headers: Record<string, string> = {};
    if (key && s.auth === "bearer") headers.authorization = `Bearer ${key}`;
    if (key && s.auth === "x-api-key") headers["x-api-key"] = key;
    if (key && s.auth === "x-goog-api-key") headers["x-goog-api-key"] = key;
    if (key && s.auth === "api-key") headers["api-key"] = key;
    if (surface === "anthropic") headers["anthropic-version"] = "2023-06-01";
    const url =
      surface === "openai"
        ? `${s.baseUrl}/models`
        : surface === "anthropic"
          ? `${s.baseUrl}/v1/models`
          : `${s.baseUrl}/v1beta/models`;
    const started = performance.now();
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      let models = 0;
      try {
        const j = (await res.json()) as { data?: unknown[]; models?: unknown[] };
        models = (j.data ?? j.models ?? []).length;
      } catch {
        /* ignore */
      }
      return { ok: res.ok, status: res.status, latencyMs: Math.round(performance.now() - started), models };
    } catch (err) {
      return { ok: false, status: 0, message: (err as Error).message };
    }
  });

  // ------------------------------------------------------------ virtual keys

  fastify.get("/keys", async () => app.keys.list().map((k) => ({ ...k, monthSpend: app.keys.monthSpend(k.id) })));

  fastify.post("/keys", async (req, reply) => {
    const body = keySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input", issues: body.error.issues });
    const { record, key } = app.keys.create(body.data);
    app.audit.add("key.created", { id: record.id, name: record.name }, ip(req));
    return { ...record, key };
  });

  fastify.patch("/keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = keySchema.partial().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input", issues: body.error.issues });
    const rec = app.keys.update(id, body.data);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    app.audit.add("key.updated", { id, fields: Object.keys(body.data) }, ip(req));
    return rec;
  });

  fastify.delete("/keys/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!app.keys.delete(id)) return reply.code(404).send({ error: "not_found" });
    app.audit.add("key.deleted", { id }, ip(req));
    return { ok: true };
  });

  // ------------------------------------------------------------ settings

  fastify.get("/settings", async () => app.settings);

  fastify.put("/settings", async (req, reply) => {
    const body = settingsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input", issues: body.error.issues });
    const patch = body.data as Parameters<typeof app.updateSettings>[0];
    if (patch.stageOptions) patch.stageOptions = { ...app.settings.stageOptions, ...patch.stageOptions };
    const next = app.updateSettings(patch);
    app.audit.add("settings.updated", { fields: Object.keys(body.data), profile: next.profile }, ip(req));
    return next;
  });

  fastify.get("/pricing", async () => ({
    prices: Object.fromEntries(app.prices.entries()),
    overrides: app.settings.priceOverrides,
  }));

  fastify.put("/pricing/:model", async (req, reply) => {
    const { model } = req.params as { model: string };
    const body = priceSchema.safeParse(req.body);
    if (!body.success || model.length > 128) return reply.code(400).send({ error: "invalid_input" });
    app.updateSettings({ priceOverrides: { ...app.settings.priceOverrides, [model.toLowerCase()]: body.data } });
    app.audit.add("pricing.updated", { model }, ip(req));
    return { ok: true };
  });

  fastify.delete("/pricing/:model", async (req) => {
    const { model } = req.params as { model: string };
    const next = { ...app.settings.priceOverrides };
    delete next[model.toLowerCase()];
    app.updateSettings({ priceOverrides: next });
    return { ok: true };
  });

  // ------------------------------------------------------------ playground

  fastify.post("/optimize", async (req, reply) => {
    const body = z
      .object({
        protocol: z.enum(["openai-chat", "openai-responses", "anthropic", "gemini"]),
        payload: z.record(z.string(), z.unknown()),
        profile: profileEnum.optional(),
        overrides: z.record(stageEnum, z.boolean()).optional(),
        provider: z.string().max(64).optional(),
      })
      .safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_input", issues: body.error.issues });
    const { protocol, payload, profile, overrides, provider } = body.data;
    return optimize(payload, {
      protocol,
      profile: profile ?? app.settings.profile,
      overrides,
      options: app.settings.stageOptions,
      provider,
    });
  });

  // ------------------------------------------------------------ cache & audit

  fastify.get("/cache", async () => app.cache.stats());

  fastify.delete("/cache", async (req) => {
    const removed = app.cache.clear();
    app.audit.add("cache.cleared", { removed }, ip(req));
    return { ok: true, removed };
  });

  fastify.get("/audit", async (req) => {
    const q = req.query as { limit?: string };
    return app.audit.list(Math.min(500, Number(q.limit ?? 100)));
  });
}
