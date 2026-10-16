import { randomUUID } from "node:crypto";
import type { ModelPrice, ProfileId, StageId, StageOptions, Usage } from "@tokensip/core";
import { generateVirtualKey, sha256Hex, type Vault } from "./crypto.js";
import type { Database } from "./db.js";

type Row = Record<string, unknown>;

// ---------------------------------------------------------------- settings

export interface Settings {
  profile: ProfileId;
  overrides: Partial<Record<StageId, boolean>>;
  stageOptions: StageOptions;
  responseCache: {
    enabled: boolean;
    ttlSeconds: number;
    /** Only cache requests with temperature 0 (or embeddings). */
    onlyDeterministic: boolean;
    maxEntryKb: number;
  };
  /** Ask OpenAI-compatible providers for usage on streams (the extra chunk is hidden from clients). */
  streamUsage: boolean;
  /** Allow per-request `x-tokensip-profile` headers. */
  allowProfileHeader: boolean;
  retentionDays: number;
  defaultProvider: string | null;
  priceOverrides: Record<string, ModelPrice>;
}

export const DEFAULT_SETTINGS: Settings = {
  profile: "safe",
  overrides: {},
  stageOptions: {},
  responseCache: { enabled: true, ttlSeconds: 3600, onlyDeterministic: true, maxEntryKb: 2048 },
  streamUsage: true,
  allowProfileHeader: true,
  retentionDays: 30,
  defaultProvider: null,
  priceOverrides: {},
};

export class KV {
  constructor(private readonly db: Database) {}
  get<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return row ? (JSON.parse(row.value as string) as T) : undefined;
  }
  set(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
  delete(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }
}

// ---------------------------------------------------------------- providers

export interface ProviderRecord {
  id: string;
  preset: string;
  name: string;
  baseUrl: string | null;
  anthropicBaseUrl: string | null;
  keyHint: string | null;
  enabled: boolean;
  priority: number;
  /** Ask for `stream_options.include_usage` on OpenAI-compatible streams. `null` = provider default. */
  streamUsage: boolean | null;
  createdAt: number;
  lastUsedAt: number | null;
  /** "db" for keys stored in the vault, "env" for keys read from environment variables. */
  source: "db" | "env";
}

function toProvider(r: Row): ProviderRecord {
  return {
    id: r.id as string,
    preset: r.preset as string,
    name: r.name as string,
    baseUrl: (r.base_url as string) ?? null,
    anthropicBaseUrl: (r.anthropic_base_url as string) ?? null,
    keyHint: (r.key_hint as string) ?? null,
    enabled: r.enabled === 1,
    priority: r.priority as number,
    streamUsage: r.stream_usage === null || r.stream_usage === undefined ? null : r.stream_usage === 1,
    createdAt: r.created_at as number,
    lastUsedAt: (r.last_used_at as number) ?? null,
    source: "db",
  };
}

export function keyHint(key: string): string {
  if (key.length <= 10) return "••••";
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

export class ProviderStore {
  constructor(
    private readonly db: Database,
    private readonly vault: Vault,
  ) {}

  list(): ProviderRecord[] {
    return (this.db.prepare("SELECT * FROM providers ORDER BY priority, created_at").all() as Row[]).map(toProvider);
  }

  get(id: string): ProviderRecord | undefined {
    const r = this.db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as Row | undefined;
    return r ? toProvider(r) : undefined;
  }

  apiKey(id: string): string | null {
    const r = this.db.prepare("SELECT api_key_enc FROM providers WHERE id = ?").get(id) as Row | undefined;
    if (!r?.api_key_enc) return null;
    return this.vault.decryptString(r.api_key_enc as string);
  }

  create(input: {
    preset: string;
    name: string;
    apiKey?: string | null;
    baseUrl?: string | null;
    anthropicBaseUrl?: string | null;
    priority?: number;
    enabled?: boolean;
    streamUsage?: boolean | null;
  }): ProviderRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO providers(id, preset, name, base_url, anthropic_base_url, api_key_enc, key_hint, enabled, priority, stream_usage, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.preset,
        input.name,
        input.baseUrl ?? null,
        input.anthropicBaseUrl ?? null,
        input.apiKey ? this.vault.encryptString(input.apiKey) : null,
        input.apiKey ? keyHint(input.apiKey) : null,
        input.enabled === false ? 0 : 1,
        input.priority ?? 100,
        input.streamUsage === undefined || input.streamUsage === null ? null : input.streamUsage ? 1 : 0,
        Date.now(),
      );
    return this.get(id) as ProviderRecord;
  }

  update(
    id: string,
    patch: Partial<{
      name: string;
      apiKey: string | null;
      baseUrl: string | null;
      anthropicBaseUrl: string | null;
      enabled: boolean;
      priority: number;
      streamUsage: boolean | null;
    }>,
  ): ProviderRecord | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const add = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.name !== undefined) add("name", patch.name);
    if (patch.baseUrl !== undefined) add("base_url", patch.baseUrl || null);
    if (patch.anthropicBaseUrl !== undefined) add("anthropic_base_url", patch.anthropicBaseUrl || null);
    if (patch.enabled !== undefined) add("enabled", patch.enabled ? 1 : 0);
    if (patch.priority !== undefined) add("priority", patch.priority);
    if (patch.streamUsage !== undefined)
      add("stream_usage", patch.streamUsage === null ? null : patch.streamUsage ? 1 : 0);
    if (patch.apiKey !== undefined) {
      add("api_key_enc", patch.apiKey ? this.vault.encryptString(patch.apiKey) : null);
      add("key_hint", patch.apiKey ? keyHint(patch.apiKey) : null);
    }
    if (sets.length) this.db.prepare(`UPDATE providers SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM providers WHERE id = ?").run(id).changes) > 0;
  }

  touch(id: string): void {
    this.db.prepare("UPDATE providers SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
  }
}

// ---------------------------------------------------------------- virtual keys

export interface ApiKeyRecord {
  id: string;
  name: string;
  hint: string;
  profile: ProfileId | null;
  monthlyBudgetUsd: number | null;
  rpm: number | null;
  allowedProviders: string[] | null;
  expiresAt: number | null;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

function toKey(r: Row): ApiKeyRecord {
  return {
    id: r.id as string,
    name: r.name as string,
    hint: r.hint as string,
    profile: (r.profile as ProfileId) ?? null,
    monthlyBudgetUsd: (r.monthly_budget_usd as number) ?? null,
    rpm: (r.rpm as number) ?? null,
    allowedProviders: r.allowed_providers ? (JSON.parse(r.allowed_providers as string) as string[]) : null,
    expiresAt: (r.expires_at as number) ?? null,
    enabled: r.enabled === 1,
    createdAt: r.created_at as number,
    lastUsedAt: (r.last_used_at as number) ?? null,
  };
}

export interface ApiKeyInput {
  name: string;
  profile?: ProfileId | null;
  monthlyBudgetUsd?: number | null;
  rpm?: number | null;
  allowedProviders?: string[] | null;
  expiresAt?: number | null;
  enabled?: boolean;
}

export class ApiKeyStore {
  constructor(private readonly db: Database) {}

  list(): ApiKeyRecord[] {
    return (this.db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() as Row[]).map(toKey);
  }

  get(id: string): ApiKeyRecord | undefined {
    const r = this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as Row | undefined;
    return r ? toKey(r) : undefined;
  }

  findByKey(key: string): ApiKeyRecord | undefined {
    const r = this.db.prepare("SELECT * FROM api_keys WHERE hash = ?").get(sha256Hex(key)) as Row | undefined;
    return r ? toKey(r) : undefined;
  }

  create(input: ApiKeyInput): { record: ApiKeyRecord; key: string } {
    const { key, hash, hint } = generateVirtualKey();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO api_keys(id, name, hash, hint, profile, monthly_budget_usd, rpm, allowed_providers, expires_at, enabled, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        hash,
        hint,
        input.profile ?? null,
        input.monthlyBudgetUsd ?? null,
        input.rpm ?? null,
        input.allowedProviders?.length ? JSON.stringify(input.allowedProviders) : null,
        input.expiresAt ?? null,
        input.enabled === false ? 0 : 1,
        Date.now(),
      );
    return { record: this.get(id) as ApiKeyRecord, key };
  }

  update(id: string, patch: Partial<ApiKeyInput>): ApiKeyRecord | undefined {
    if (!this.get(id)) return undefined;
    const map: Record<string, [string, (v: never) => string | number | null]> = {
      name: ["name", (v: string) => v],
      profile: ["profile", (v: string | null) => v ?? null],
      monthlyBudgetUsd: ["monthly_budget_usd", (v: number | null) => v ?? null],
      rpm: ["rpm", (v: number | null) => v ?? null],
      allowedProviders: ["allowed_providers", (v: string[] | null) => (v?.length ? JSON.stringify(v) : null)],
      expiresAt: ["expires_at", (v: number | null) => v ?? null],
      enabled: ["enabled", (v: boolean) => (v ? 1 : 0)],
    };
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m || v === undefined) continue;
      sets.push(`${m[0]} = ?`);
      vals.push(m[1](v as never));
    }
    if (sets.length) this.db.prepare(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id).changes) > 0;
  }

  touch(id: string): void {
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /** USD spent by a key since the start of the current UTC month. */
  monthSpend(id: string): number {
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const r = this.db
      .prepare("SELECT COALESCE(SUM(cost), 0) AS spent FROM requests WHERE key_id = ? AND ts >= ?")
      .get(id, start) as Row;
    return r.spent as number;
  }
}

// ---------------------------------------------------------------- request log

export interface RequestRecord {
  id: string;
  ts: number;
  keyId: string | null;
  tenant: string | null;
  provider: string | null;
  model: string | null;
  protocol: string | null;
  path: string;
  stream: boolean;
  status: number;
  latencyMs: number;
  ttfbMs: number | null;
  overheadMs: number;
  usage: Usage;
  optimizerSaved: number;
  cost: number;
  baselineCost: number;
  cacheHit: boolean;
  profile: string | null;
  lossy: boolean;
  error: string | null;
}

export type Range = "24h" | "7d" | "30d" | "90d";
const RANGE_MS: Record<Range, number> = { "24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5, "90d": 90 * 864e5 };

export class RequestLog {
  constructor(private readonly db: Database) {}

  insert(r: RequestRecord): void {
    this.db
      .prepare(
        `INSERT INTO requests(id, ts, key_id, tenant, provider, model, protocol, path, stream, status, latency_ms, ttfb_ms,
          overhead_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated,
          optimizer_saved, cost, baseline_cost, cache_hit, profile, lossy, error)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.ts,
        r.keyId,
        r.tenant,
        r.provider,
        r.model,
        r.protocol,
        r.path,
        r.stream ? 1 : 0,
        r.status,
        Math.round(r.latencyMs),
        r.ttfbMs === null ? null : Math.round(r.ttfbMs),
        r.overheadMs,
        r.usage.inputTokens,
        r.usage.outputTokens,
        r.usage.cacheReadTokens,
        r.usage.cacheWriteTokens,
        r.usage.reasoningTokens,
        r.usage.estimated ? 1 : 0,
        r.optimizerSaved,
        r.cost,
        r.baselineCost,
        r.cacheHit ? 1 : 0,
        r.profile,
        r.lossy ? 1 : 0,
        r.error ? r.error.slice(0, 500) : null,
      );
  }

  list(opts: { limit: number; before?: number; keyId?: string; provider?: string; status?: "ok" | "error" }): Row[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (opts.before) {
      where.push("ts < ?");
      vals.push(opts.before);
    }
    if (opts.keyId) {
      where.push("key_id = ?");
      vals.push(opts.keyId);
    }
    if (opts.provider) {
      where.push("provider = ?");
      vals.push(opts.provider);
    }
    if (opts.status === "ok") where.push("status < 400");
    if (opts.status === "error") where.push("status >= 400");
    const sql = `SELECT * FROM requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT ?`;
    return this.db.prepare(sql).all(...vals, opts.limit) as Row[];
  }

  overview(range: Range) {
    const since = Date.now() - RANGE_MS[range];
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
          COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
          COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
          COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
          COALESCE(SUM(optimizer_saved), 0) AS optimizer_saved,
          COALESCE(SUM(cost), 0) AS cost,
          COALESCE(SUM(baseline_cost), 0) AS baseline_cost,
          COALESCE(SUM(cache_hit), 0) AS cache_hits,
          COALESCE(SUM(CASE WHEN cache_hit = 1 THEN input_tokens + cache_read_tokens + cache_write_tokens + output_tokens ELSE 0 END), 0) AS cache_hit_tokens,
          COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
          COALESCE(AVG(overhead_ms), 0) AS avg_overhead_ms,
          COALESCE(AVG(CASE WHEN cache_hit = 0 THEN latency_ms END), 0) AS avg_latency_ms
         FROM requests WHERE ts >= ?`,
      )
      .get(since) as Row;

    const bucketMs = range === "24h" ? 3_600_000 : 86_400_000;
    // Inlined integer literal: node:sqlite binds JS numbers as REAL, which would turn this into float division.
    const series = this.db
      .prepare(
        `SELECT (ts / ${bucketMs}) * ${bucketMs} AS bucket, COUNT(*) AS requests,
          SUM(input_tokens + cache_read_tokens + cache_write_tokens + optimizer_saved) AS prompt_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(optimizer_saved + cache_read_tokens) AS saved_tokens,
          SUM(cost) AS cost, SUM(baseline_cost) AS baseline_cost
         FROM requests WHERE ts >= ? GROUP BY bucket ORDER BY bucket`,
      )
      .all(since) as Row[];

    const byModel = this.db
      .prepare(
        `SELECT model, provider, COUNT(*) AS requests,
          SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS prompt_tokens,
          SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(optimizer_saved) AS optimizer_saved, SUM(cost) AS cost, SUM(baseline_cost) AS baseline_cost
         FROM requests WHERE ts >= ? GROUP BY model, provider ORDER BY baseline_cost DESC, requests DESC LIMIT 12`,
      )
      .all(since) as Row[];

    const byProvider = this.db
      .prepare(
        `SELECT provider, COUNT(*) AS requests, SUM(cost) AS cost, SUM(baseline_cost) AS baseline_cost
         FROM requests WHERE ts >= ? GROUP BY provider ORDER BY requests DESC`,
      )
      .all(since) as Row[];

    return { range, since, bucketMs, totals, series, byModel, byProvider };
  }

  /** Models seen recently, most used first. */
  models(sinceMs: number, limit = 200): { model: string; requests: number; lastSeen: number }[] {
    return (
      this.db
        .prepare(
          `SELECT model, COUNT(*) AS requests, MAX(ts) AS last_seen FROM requests
           WHERE model IS NOT NULL AND model != '' AND ts >= ? GROUP BY model ORDER BY requests DESC LIMIT ?`,
        )
        .all(sinceMs, limit) as Row[]
    ).map((r) => ({ model: r.model as string, requests: r.requests as number, lastSeen: r.last_seen as number }));
  }

  prune(retentionDays: number): number {
    const cutoff = Date.now() - retentionDays * 864e5;
    return Number(this.db.prepare("DELETE FROM requests WHERE ts < ?").run(cutoff).changes);
  }
}

// ---------------------------------------------------------------- response cache

export interface CachedResponse {
  contentType: string;
  body: Buffer;
  usage: Usage;
  model: string | null;
  provider: string | null;
}

/** Exact-match response cache. Bodies are encrypted at rest and partitioned by tenant. */
export class ResponseCache {
  constructor(
    private readonly db: Database,
    private readonly vault: Vault,
  ) {}

  get(key: string, tenant: string): CachedResponse | undefined {
    const r = this.db
      .prepare("SELECT * FROM response_cache WHERE key = ? AND tenant = ? AND expires_at > ?")
      .get(key, tenant, Date.now()) as Row | undefined;
    if (!r) return undefined;
    this.db.prepare("UPDATE response_cache SET hits = hits + 1 WHERE key = ?").run(key);
    try {
      return {
        contentType: r.content_type as string,
        body: this.vault.decrypt(r.body as Uint8Array),
        usage: JSON.parse(r.usage as string) as Usage,
        model: (r.model as string) ?? null,
        provider: (r.provider as string) ?? null,
      };
    } catch {
      this.db.prepare("DELETE FROM response_cache WHERE key = ?").run(key);
      return undefined;
    }
  }

  set(key: string, tenant: string, ttlSeconds: number, entry: CachedResponse): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO response_cache(key, tenant, created_at, expires_at, content_type, body, usage, model, provider, size)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET created_at = excluded.created_at, expires_at = excluded.expires_at,
           content_type = excluded.content_type, body = excluded.body, usage = excluded.usage, size = excluded.size`,
      )
      .run(
        key,
        tenant,
        now,
        now + ttlSeconds * 1000,
        entry.contentType,
        this.vault.encrypt(entry.body),
        JSON.stringify(entry.usage),
        entry.model,
        entry.provider,
        entry.body.length,
      );
  }

  stats(): { entries: number; bytes: number; hits: number } {
    const r = this.db
      .prepare(
        "SELECT COUNT(*) AS entries, COALESCE(SUM(size), 0) AS bytes, COALESCE(SUM(hits), 0) AS hits FROM response_cache WHERE expires_at > ?",
      )
      .get(Date.now()) as Row;
    return { entries: r.entries as number, bytes: r.bytes as number, hits: r.hits as number };
  }

  clear(): number {
    return Number(this.db.prepare("DELETE FROM response_cache").run().changes);
  }

  prune(): number {
    return Number(this.db.prepare("DELETE FROM response_cache WHERE expires_at <= ?").run(Date.now()).changes);
  }
}

// ---------------------------------------------------------------- sessions & audit

export interface Session {
  csrf: string;
  expiresAt: number;
}

export class SessionStore {
  constructor(private readonly db: Database) {}

  create(token: string, csrf: string, ttlMs: number, ip: string, userAgent: string): void {
    const now = Date.now();
    this.db
      .prepare("INSERT INTO sessions(id_hash, csrf, created_at, expires_at, ip, user_agent) VALUES(?, ?, ?, ?, ?, ?)")
      .run(sha256Hex(token), csrf, now, now + ttlMs, ip, userAgent.slice(0, 200));
  }

  get(token: string): Session | undefined {
    const r = this.db
      .prepare("SELECT csrf, expires_at FROM sessions WHERE id_hash = ? AND expires_at > ?")
      .get(sha256Hex(token), Date.now()) as Row | undefined;
    return r ? { csrf: r.csrf as string, expiresAt: r.expires_at as number } : undefined;
  }

  extend(token: string, ttlMs: number): void {
    this.db.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?").run(Date.now() + ttlMs, sha256Hex(token));
  }

  delete(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256Hex(token));
  }

  deleteAll(): void {
    this.db.prepare("DELETE FROM sessions").run();
  }

  prune(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  }
}

export class AuditLog {
  constructor(private readonly db: Database) {}

  add(action: string, detail: Record<string, unknown> = {}, ip: string | null = null): void {
    this.db
      .prepare("INSERT INTO audit_log(ts, action, detail, ip) VALUES(?, ?, ?, ?)")
      .run(Date.now(), action, JSON.stringify(detail), ip);
  }

  list(limit = 100): { id: number; ts: number; action: string; detail: unknown; ip: string | null }[] {
    return (this.db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      id: r.id as number,
      ts: r.ts as number,
      action: r.action as string,
      detail: JSON.parse((r.detail as string) || "{}"),
      ip: (r.ip as string) ?? null,
    }));
  }
}
