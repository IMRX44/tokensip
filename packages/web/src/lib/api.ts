let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrf(token: string | null): void {
  csrfToken = token;
}

export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: unknown,
  ) {
    super(code);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized?.();
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `http_${res.status}`, data);
  }
  return data as T;
}

// ------------------------------------------------------------------ types

export type ProfileId = "off" | "safe" | "balanced" | "aggressive" | "extreme";
export type Safety = "lossless" | "equivalent" | "lossy";

export interface AuthState {
  setupRequired: boolean;
  authenticated: boolean;
  csrfToken: string | null;
  totpEnabled: boolean;
  mode: "local" | "server";
}

export interface CatalogProvider {
  id: string;
  name: string;
  surfaces: Partial<Record<"openai" | "anthropic" | "gemini", { baseUrl: string; auth: string }>>;
  modelPatterns: string[];
  local: boolean;
  requiresBaseUrl: boolean;
  autoPrefixCache: boolean;
  docsUrl?: string;
  keyUrl?: string;
}

export interface Catalog {
  version: string;
  mode: "local" | "server";
  passthrough: boolean;
  vaultSource: string;
  providers: CatalogProvider[];
  stages: { id: string; safety: Safety; description: string; protocols: string[] | null }[];
  profiles: {
    id: ProfileId;
    stages: string[];
    typicalPromptRatio: string;
    risk: "none" | "low" | "medium" | "high";
    warning?: string;
  }[];
  stageDefaults: Record<string, number | string>;
}

export interface Overview {
  range: string;
  bucketMs: number;
  since: number;
  totals: {
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    optimizerSaved: number;
    cacheHits: number;
    cacheHitTokens: number;
    cost: number;
    baselineCost: number;
    saved: number;
    savingsRate: number;
    avgOverheadMs: number;
    avgLatencyMs: number;
  };
  series: {
    t: number;
    requests: number;
    promptTokens: number;
    outputTokens: number;
    savedTokens: number;
    cost: number;
    baselineCost: number;
  }[];
  byModel: {
    model: string | null;
    provider: string | null;
    requests: number;
    promptTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    optimizerSaved: number;
    cost: number;
    baselineCost: number;
  }[];
  byProvider: { provider: string | null; requests: number; cost: number; baselineCost: number }[];
  cache: { entries: number; bytes: number; hits: number };
}

export interface RequestItem {
  id: string;
  ts: number;
  key: string | null;
  provider: string | null;
  model: string | null;
  protocol: string | null;
  path: string;
  stream: boolean;
  status: number;
  latencyMs: number;
  ttfbMs: number | null;
  overheadMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimated: boolean;
  optimizerSaved: number;
  cost: number;
  baselineCost: number;
  cacheHit: boolean;
  profile: string | null;
  lossy: boolean;
  error: string | null;
}

export interface ProviderRecord {
  id: string;
  preset: string;
  name: string;
  baseUrl: string | null;
  anthropicBaseUrl: string | null;
  keyHint: string | null;
  enabled: boolean;
  priority: number;
  createdAt: number;
  lastUsedAt: number | null;
  source: "db" | "env";
}

export interface ApiKey {
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
  monthSpend: number;
}

export interface Settings {
  profile: ProfileId;
  overrides: Record<string, boolean>;
  stageOptions: Record<string, number | string>;
  responseCache: { enabled: boolean; ttlSeconds: number; onlyDeterministic: boolean; maxEntryKb: number };
  streamUsage: boolean;
  allowProfileHeader: boolean;
  retentionDays: number;
  defaultProvider: string | null;
}

export interface OptimizeReport {
  protocol: string;
  profile: string;
  changed: boolean;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  lossy: boolean;
  durationMs: number;
  stages: { id: string; safety: Safety; applied: boolean; tokensSaved: number; edits: number; note?: string }[];
}
