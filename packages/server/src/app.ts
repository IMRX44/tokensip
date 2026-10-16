import {
  type AuthStyle,
  matchProviderByModel,
  PROVIDER_BY_ID,
  PriceBook,
  type ProviderPreset,
  type Surface,
} from "@tokensip/core";
import { ENV_PROVIDER_KEYS, type TokenSipConfig } from "./config.js";
import { Vault } from "./crypto.js";
import { type Database, openDatabase } from "./db.js";
import { Metrics } from "./lib/metrics.js";
import { RateLimiter } from "./lib/ratelimit.js";
import {
  ApiKeyStore,
  AuditLog,
  DEFAULT_SETTINGS,
  KV,
  keyHint,
  type ProviderRecord,
  ProviderStore,
  RequestLog,
  ResponseCache,
  SessionStore,
  type Settings,
} from "./store.js";

export interface ResolvedProvider {
  /** Provider record id (`env:<preset>` for environment keys, `passthrough:<preset>` for client keys). */
  id: string;
  preset: ProviderPreset;
  name: string;
  surface: Surface;
  baseUrl: string;
  auth: AuthStyle;
  apiKey: string | null;
  source: "db" | "env" | "passthrough";
  /** Request `stream_options.include_usage` on OpenAI-compatible streams. */
  streamUsage: boolean;
}

interface ConfiguredProvider {
  record: ProviderRecord;
  preset: ProviderPreset;
  apiKey: () => string | null;
}

export class TokenSipApp {
  readonly kv: KV;
  readonly providers: ProviderStore;
  readonly keys: ApiKeyStore;
  readonly requests: RequestLog;
  readonly cache: ResponseCache;
  readonly sessions: SessionStore;
  readonly audit: AuditLog;
  readonly metrics = new Metrics();
  readonly keyLimiter = new RateLimiter(60_000);
  readonly loginLimiter = new RateLimiter(15 * 60_000);
  prices: PriceBook;
  /** One-time setup token, present only until an admin password exists. */
  setupToken: string | null = null;
  private settingsCache: Settings;
  private readonly spendCache = new Map<string, { at: number; spent: number }>();
  private readonly envProviders: ConfiguredProvider[];

  private constructor(
    readonly config: TokenSipConfig,
    readonly db: Database,
    readonly vault: Vault,
    readonly vaultSource: "env" | "file" | "generated",
    env: NodeJS.ProcessEnv,
  ) {
    this.kv = new KV(db);
    this.providers = new ProviderStore(db, vault);
    this.requests = new RequestLog(db);
    this.keys = new ApiKeyStore(db, () => this.requests.flush());
    this.cache = new ResponseCache(db, vault);
    this.sessions = new SessionStore(db);
    this.audit = new AuditLog(db);
    const stored = this.kv.get<Partial<Settings>>("settings");
    this.settingsCache = {
      ...DEFAULT_SETTINGS,
      profile: config.defaultProfile,
      ...stored,
      responseCache: { ...DEFAULT_SETTINGS.responseCache, ...stored?.responseCache },
    };
    this.prices = new PriceBook(this.settingsCache.priceOverrides);
    this.envProviders = loadEnvProviders(env);
  }

  static async create(config: TokenSipConfig, env: NodeJS.ProcessEnv = process.env): Promise<TokenSipApp> {
    const { vault, source } =
      config.dataDir === ":memory:"
        ? {
            vault: config.secret ? Vault.fromSecret(config.secret) : new Vault(Buffer.alloc(32, 7)),
            source: "env" as const,
          }
        : Vault.load(config.dataDir, config.secret);
    const db = await openDatabase(config.dataDir === ":memory:" ? ":memory:" : config.dataDir);
    const app = new TokenSipApp(config, db, vault, source, env);
    app.verifyVault();
    return app;
  }

  /** Refuse to start with a different master key than the one that encrypted existing data. */
  private verifyVault(): void {
    const check = this.kv.get<string>("vault_check");
    if (!check) {
      this.kv.set("vault_check", this.vault.encryptString("tokensip"));
      return;
    }
    try {
      if (this.vault.decryptString(check) === "tokensip") return;
    } catch {
      /* fallthrough */
    }
    throw new Error(
      "The master key does not match this data directory. Restore the original TOKENSIP_SECRET / master.key, or start with an empty data directory.",
    );
  }

  get settings(): Settings {
    return this.settingsCache;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next: Settings = {
      ...this.settingsCache,
      ...patch,
      responseCache: { ...this.settingsCache.responseCache, ...patch.responseCache },
    };
    this.kv.set("settings", next);
    this.settingsCache = next;
    this.prices = new PriceBook(next.priceOverrides);
    return next;
  }

  private configuredCache: { version: number; at: number; list: ConfiguredProvider[] } | null = null;

  /** Providers available for routing: stored ones plus read-only environment keys. */
  configured(): ConfiguredProvider[] {
    const c = this.configuredCache;
    // Rebuilt after any change through this process, and every 5 s to pick up other processes.
    if (c && c.version === this.providers.version && Date.now() - c.at < 5_000) return c.list;
    const list = this.loadConfigured();
    this.configuredCache = { version: this.providers.version, at: Date.now(), list };
    return list;
  }

  private loadConfigured(): ConfiguredProvider[] {
    const fromDb: ConfiguredProvider[] = this.providers
      .list()
      .filter((r) => r.enabled)
      .flatMap((record) => {
        const preset = PROVIDER_BY_ID.get(record.preset);
        if (!preset) return [];
        // Decrypted once per cache generation instead of on every request.
        let key: string | null | undefined;
        const apiKey = () => {
          if (key === undefined) key = this.providers.apiKey(record.id);
          return key;
        };
        return [{ record, preset, apiKey }];
      });
    const dbPresets = new Set(fromDb.map((p) => p.preset.id));
    return [...fromDb, ...this.envProviders.filter((p) => !dbPresets.has(p.preset.id))];
  }

  listEnvProviders(): ProviderRecord[] {
    return this.envProviders.map((p) => p.record);
  }

  /** Base URL + auth for a provider on a given API surface, or undefined when unsupported. */
  surfaceOf(
    preset: ProviderPreset,
    surface: Surface,
    record?: Pick<ProviderRecord, "baseUrl" | "anthropicBaseUrl">,
  ): { baseUrl: string; auth: AuthStyle } | undefined {
    // Any provider (including custom gateways and aggregators) can expose an
    // Anthropic-compatible endpoint by configuring its base URL.
    if (surface === "anthropic" && record?.anthropicBaseUrl) {
      return {
        baseUrl: record.anthropicBaseUrl.replace(/\/+$/, ""),
        auth: preset.surfaces.anthropic?.auth ?? "x-api-key",
      };
    }
    const s = preset.surfaces[surface];
    if (!s) return undefined;
    const baseUrl = surface === "openai" && record?.baseUrl ? record.baseUrl : s.baseUrl;
    if (!baseUrl) return undefined;
    return { baseUrl: baseUrl.replace(/\/+$/, ""), auth: s.auth };
  }

  /**
   * Pick the upstream provider for a request.
   * Order: explicit route/header → model-name patterns → default provider → custom gateway → first available.
   */
  resolve(opts: {
    surface: Surface;
    presetId?: string;
    model?: string;
    allowed?: string[] | null;
    passthrough: boolean;
  }): ResolvedProvider {
    const { surface } = opts;
    const pool = this.configured().filter(
      (p) => (!opts.allowed || opts.allowed.includes(p.preset.id)) && this.surfaceOf(p.preset, surface, p.record),
    );

    let chosen: ConfiguredProvider | undefined;
    if (opts.presetId) chosen = pool.find((p) => p.preset.id === opts.presetId || p.record.id === opts.presetId);
    if (!chosen && !opts.presetId) {
      chosen =
        matchProviderByModel(
          opts.model,
          pool.map((p) => ({ ...p, id: p.preset.id, modelPatterns: p.preset.modelPatterns })),
        ) ??
        pool.find((p) => p.preset.id === this.settings.defaultProvider) ??
        // A custom gateway/aggregator is the natural home for model names no preset claims.
        pool.find((p) => p.preset.id === "custom") ??
        (opts.passthrough ? undefined : pool[0]);
    }

    if (chosen) {
      const s = this.surfaceOf(chosen.preset, surface, chosen.record) as { baseUrl: string; auth: AuthStyle };
      return {
        id: chosen.record.id,
        preset: chosen.preset,
        name: chosen.record.name,
        surface,
        baseUrl: s.baseUrl,
        auth: s.auth,
        apiKey: opts.passthrough ? null : chosen.apiKey(),
        source: opts.passthrough ? "passthrough" : chosen.record.source,
        streamUsage: chosen.record.streamUsage ?? Boolean(chosen.preset.streamUsage),
      };
    }

    if (!opts.passthrough) {
      throw new Error(
        opts.presetId
          ? `Provider "${opts.presetId}" is not configured or not allowed for this key.`
          : "No provider is configured for this request. Add one in the dashboard or set e.g. OPENAI_API_KEY.",
      );
    }

    // Passthrough with zero configuration: route straight to the public endpoint of a known provider.
    const fallbackId =
      opts.presetId ??
      matchProviderByModel(opts.model, [...PROVIDER_BY_ID.values()])?.id ??
      (surface === "anthropic"
        ? "anthropic"
        : surface === "gemini"
          ? "google"
          : (this.settings.defaultProvider ?? "openai"));
    const preset = PROVIDER_BY_ID.get(fallbackId);
    const s = preset && this.surfaceOf(preset, surface);
    if (!preset || !s) {
      throw new Error(`Provider "${fallbackId}" does not support the ${surface} API or needs a base URL.`);
    }
    return {
      id: `passthrough:${preset.id}`,
      preset,
      name: preset.name,
      surface,
      baseUrl: s.baseUrl,
      auth: s.auth,
      apiKey: null,
      source: "passthrough",
      streamUsage: Boolean(preset.streamUsage),
    };
  }

  /** Month-to-date spend for a key, cached briefly to keep the hot path cheap. */
  keySpend(keyId: string): number {
    const hit = this.spendCache.get(keyId);
    if (hit && Date.now() - hit.at < 15_000) return hit.spent;
    const spent = this.keys.monthSpend(keyId);
    this.spendCache.set(keyId, { at: Date.now(), spent });
    return spent;
  }

  addSpend(keyId: string, usd: number): void {
    const hit = this.spendCache.get(keyId);
    if (hit) hit.spent += usd;
  }

  /** Periodic maintenance: retention, expired cache entries and sessions. */
  maintain(): void {
    this.requests.prune(this.settings.retentionDays);
    this.cache.prune();
    this.sessions.prune();
  }

  close(): void {
    this.requests.flush();
    this.db.close();
  }
}

function envRecord(
  id: string,
  presetId: string,
  name: string,
  key: string | null,
  extra: Partial<ProviderRecord> = {},
): ProviderRecord {
  return {
    id,
    preset: presetId,
    name,
    baseUrl: null,
    anthropicBaseUrl: null,
    keyHint: key ? keyHint(key) : null,
    enabled: true,
    priority: 1000,
    streamUsage: null,
    createdAt: 0,
    lastUsedAt: null,
    source: "env",
    ...extra,
  };
}

function loadEnvProviders(env: NodeJS.ProcessEnv): ConfiguredProvider[] {
  const out: ConfiguredProvider[] = [];
  for (const [presetId, vars] of Object.entries(ENV_PROVIDER_KEYS)) {
    const name = vars.find((v) => env[v]);
    const preset = PROVIDER_BY_ID.get(presetId);
    if (!name || !preset) continue;
    const key = env[name] as string;
    out.push({
      preset,
      apiKey: () => key,
      record: envRecord(`env:${presetId}`, presetId, `${preset.name} (${name})`, key),
    });
  }

  // Any OpenAI-compatible gateway or aggregator, optionally with an Anthropic-compatible endpoint.
  const customBase = env.TOKENSIP_CUSTOM_BASE_URL;
  const custom = PROVIDER_BY_ID.get("custom");
  if (customBase && custom) {
    const key = env.TOKENSIP_CUSTOM_API_KEY || null;
    const streamUsage = env.TOKENSIP_CUSTOM_STREAM_USAGE;
    out.push({
      preset: custom,
      apiKey: () => key,
      record: envRecord("env:custom", "custom", env.TOKENSIP_CUSTOM_NAME || "Custom (TOKENSIP_CUSTOM_BASE_URL)", key, {
        baseUrl: customBase,
        anthropicBaseUrl: env.TOKENSIP_CUSTOM_ANTHROPIC_BASE_URL || null,
        streamUsage:
          streamUsage === undefined || streamUsage === ""
            ? null
            : ["1", "true", "yes", "on"].includes(streamUsage.toLowerCase()),
      }),
    });
  }
  return out;
}
