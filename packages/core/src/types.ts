/**
 * Wire protocols TokenSip understands natively. TokenSip never translates
 * between protocols: a request is optimized in its own native shape and
 * forwarded as-is, so every provider feature keeps working.
 */
export type Protocol = "openai-chat" | "openai-responses" | "anthropic" | "gemini";

/**
 * How much a stage may change what the model sees.
 * - `lossless`   — byte-level changes only; the model receives identical information.
 * - `equivalent` — information is preserved but represented differently (e.g. a pointer to an identical earlier tool result).
 * - `lossy`      — information is dropped. Never enabled unless you opt in.
 */
export type Safety = "lossless" | "equivalent" | "lossy";

export type ProfileId = "off" | "safe" | "balanced" | "aggressive" | "extreme";

export type StageId =
  | "stabilize-tools"
  | "relocate-volatile"
  | "supersede-observations"
  | "normalize-whitespace"
  | "anthropic-cache-breakpoints"
  | "openai-prompt-cache-key"
  | "minify-json"
  | "dedupe-tool-results"
  | "truncate-stale-tool-results"
  | "history-window"
  | "image-detail-low"
  | "reduce-reasoning"
  | "cap-output"
  | "context-budget";

export interface StageOptions {
  /** dedupe-tool-results: only dedupe outputs at least this many tokens long. */
  dedupeMinTokens?: number;
  /** truncate-stale-tool-results: tool results followed by fewer than N assistant steps are never touched. */
  keepRecentSteps?: number;
  /** truncate-stale-tool-results: stale results longer than this are truncated. */
  maxStaleToolTokens?: number;
  /** history-window: keep system + first user message + the last N messages. */
  maxMessages?: number;
  /** anthropic-cache-breakpoints: minimum estimated prefix tokens before adding a breakpoint. */
  minCacheableTokens?: number;
  /** context-budget: target prompt size as a fraction of the original (0.1 = keep ~10%). */
  targetRatio?: number;
  /** context-budget: never compress below this many tokens. */
  minBudgetTokens?: number;
  /** cap-output: maximum output tokens a request may ask for. */
  maxOutputTokens?: number;
  /** reduce-reasoning: effort level for OpenAI reasoning models. */
  reasoningEffort?: "minimal" | "low" | "medium";
  /** reduce-reasoning: cap for Anthropic/Gemini thinking budgets. */
  maxThinkingTokens?: number;
}

export interface OptimizeOptions {
  protocol: Protocol;
  /** Profile to use. Defaults to `safe`. */
  profile?: ProfileId;
  /** Explicit stage list; overrides the profile when provided. */
  stages?: StageId[];
  /** Per-stage enable/disable on top of the profile. */
  overrides?: Partial<Record<StageId, boolean>>;
  options?: StageOptions;
  /** Model name, used by provider-specific stages. */
  model?: string;
  /** Upstream provider id (e.g. `openai`), used by provider-specific stages. */
  provider?: string;
  /** Mixed into derived cache keys so tenants never share a routing key. */
  cacheKeySalt?: string;
  /** Conversation context, set by SessionEngine. */
  session?: import("./session/runtime.js").SessionRuntime;
  /**
   * `exact`: BPE-tokenize everything (accurate, slowest).
   * `fast`: estimate the prompt total, tokenize only the text that changed (default for the proxy).
   * `approx`: chars/4 everywhere.
   */
  tokenCounting?: "exact" | "fast" | "approx";
}

export interface StageReport {
  id: StageId;
  safety: Safety;
  applied: boolean;
  /** Estimated tokens removed from the prompt by this stage (can be 0). */
  tokensSaved: number;
  /** Number of individual edits this stage made. */
  edits: number;
  note?: string;
}

export interface OptimizeReport {
  protocol: Protocol;
  profile: ProfileId | "custom";
  changed: boolean;
  /** Estimated prompt tokens before optimization (text content only). */
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  /** True when a lossy stage changed the request — the model saw less information. */
  lossy: boolean;
  stages: StageReport[];
  durationMs: number;
}

export interface OptimizeResult<T = unknown> {
  payload: T;
  report: OptimizeReport;
}

/** Normalized token usage across providers. */
export interface Usage {
  /** Prompt tokens billed at the full input rate (excludes cache reads/writes). */
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's prompt cache. */
  cacheReadTokens: number;
  /** Prompt tokens written to the provider's prompt cache (Anthropic). */
  cacheWriteTokens: number;
  /** Reasoning tokens, already included in outputTokens. */
  reasoningTokens: number;
  /** True when some numbers were estimated locally rather than reported by the provider. */
  estimated: boolean;
}

export interface ModelPrice {
  /** USD per 1M tokens. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface CostBreakdown {
  /** What was actually billed. */
  actual: number;
  /** What it would have cost with no prompt caching and no TokenSip optimizations. */
  baseline: number;
  saved: number;
  priced: boolean;
}

export type AuthStyle = "bearer" | "x-api-key" | "x-goog-api-key" | "api-key" | "none";

export type Surface = "openai" | "anthropic" | "gemini";

export interface SurfaceConfig {
  /**
   * Base URL the client path is appended to.
   * openai: up to and including `/v1` (e.g. `https://api.openai.com/v1`)
   * anthropic / gemini: the origin (e.g. `https://api.anthropic.com`)
   */
  baseUrl: string;
  auth: AuthStyle;
}

export interface ProviderPreset {
  id: string;
  name: string;
  surfaces: Partial<Record<Surface, SurfaceConfig>>;
  /** Regex sources matched against the model name for auto-routing. */
  modelPatterns?: string[];
  /** Whether `stream_options.include_usage` is supported on the OpenAI surface. */
  streamUsage?: boolean;
  /** Provider caches prompt prefixes automatically. */
  autoPrefixCache?: boolean;
  /** Runs on the user's machine; no key needed. */
  local?: boolean;
  /** Base URL must be supplied by the user (Azure, custom). */
  requiresBaseUrl?: boolean;
  docsUrl?: string;
  keyUrl?: string;
}
