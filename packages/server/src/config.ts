import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProfileId } from "@tokensip/core";

export type Mode = "local" | "server";

export interface TokenSipConfig {
  mode: Mode;
  host: string;
  port: number;
  dataDir: string;
  /** Master secret used to encrypt provider keys and cached responses. Generated if absent. */
  secret?: string;
  /** Bootstrap admin password (skips the one-time setup token flow). */
  adminPassword?: string;
  /** Trust X-Forwarded-* headers (set when running behind a reverse proxy). */
  trustProxy: boolean;
  /** Allow clients to send their own provider key instead of a TokenSip virtual key. */
  allowPassthrough: boolean;
  /** Origins allowed to call the proxy endpoints from a browser. */
  corsOrigins: string[];
  bodyLimitBytes: number;
  upstreamTimeoutMs: number;
  /** Bearer token required for /metrics. When unset, /metrics is disabled. */
  metricsToken?: string;
  /** Profile used until changed in the dashboard. */
  defaultProfile: ProfileId;
  /** Serve the web dashboard. */
  dashboard: boolean;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase());

const PROFILES = new Set(["off", "safe", "balanced", "aggressive", "extreme"]);

export function loadConfig(overrides: Partial<TokenSipConfig> = {}, env = process.env): TokenSipConfig {
  const mode: Mode = (overrides.mode ?? env.TOKENSIP_MODE) === "server" ? "server" : "local";
  const profileEnv = env.TOKENSIP_PROFILE ?? "balanced";
  const config: TokenSipConfig = {
    mode,
    host: env.TOKENSIP_HOST ?? (mode === "server" ? "0.0.0.0" : "127.0.0.1"),
    port: Number(env.TOKENSIP_PORT ?? env.PORT ?? 8787),
    dataDir: resolve(env.TOKENSIP_DATA_DIR ?? join(homedir(), ".tokensip")),
    secret: env.TOKENSIP_SECRET || undefined,
    adminPassword: env.TOKENSIP_ADMIN_PASSWORD || undefined,
    trustProxy: bool(env.TOKENSIP_TRUST_PROXY, false),
    allowPassthrough: bool(env.TOKENSIP_ALLOW_PASSTHROUGH, mode === "local"),
    corsOrigins: (env.TOKENSIP_CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    bodyLimitBytes: Number(env.TOKENSIP_BODY_LIMIT_MB ?? 50) * 1024 * 1024,
    upstreamTimeoutMs: Number(env.TOKENSIP_UPSTREAM_TIMEOUT_MS ?? 600_000),
    metricsToken: env.TOKENSIP_METRICS_TOKEN || undefined,
    defaultProfile: (PROFILES.has(profileEnv) ? profileEnv : "balanced") as ProfileId,
    dashboard: bool(env.TOKENSIP_DASHBOARD, true),
    logLevel: (env.TOKENSIP_LOG_LEVEL as TokenSipConfig["logLevel"]) ?? "info",
    ...overrides,
  };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`);
  }
  return config;
}

/** Environment variables that are imported as read-only providers at startup. */
export const ENV_PROVIDER_KEYS: Record<string, string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  xai: ["XAI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  cohere: ["COHERE_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  zai: ["ZAI_API_KEY"],
  qwen: ["DASHSCOPE_API_KEY"],
};
