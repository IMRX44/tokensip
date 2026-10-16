import type { CostBreakdown, ModelPrice, Usage } from "./types.js";

/**
 * Reference prices in USD per 1M tokens (standard tier, short context).
 * Prices change — every entry can be overridden from the dashboard or config,
 * and unknown models are still tracked in tokens, just not in dollars.
 * Matching is by longest prefix after stripping any `provider/` prefix.
 */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cacheRead: 0.025 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  o3: { input: 2, output: 8, cacheRead: 0.5 },
  "o3-mini": { input: 1.1, output: 4.4, cacheRead: 0.55 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
  // Anthropic (cache writes 1.25x, cache reads 0.1x)
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-1": {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-3-7-sonnet": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-3-5-sonnet": {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // Google
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.31 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.075 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cacheRead: 0.025 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4, cacheRead: 0.025 },
  // DeepSeek
  "deepseek-chat": { input: 0.28, output: 0.42, cacheRead: 0.028 },
  "deepseek-reasoner": { input: 0.28, output: 0.42, cacheRead: 0.028 },
  // xAI
  "grok-4": { input: 3, output: 15, cacheRead: 0.75 },
  "grok-3-mini": { input: 0.3, output: 0.5, cacheRead: 0.075 },
  // Mistral
  "mistral-large": { input: 2, output: 6 },
  "mistral-medium": { input: 0.4, output: 2 },
  "mistral-small": { input: 0.1, output: 0.3 },
  codestral: { input: 0.3, output: 0.9 },
  // Groq-hosted open models
  "llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
};

export class PriceBook {
  private readonly prices: Map<string, ModelPrice>;
  private keys: string[];

  constructor(overrides: Record<string, ModelPrice> = {}, base: Record<string, ModelPrice> = DEFAULT_PRICES) {
    this.prices = new Map(Object.entries({ ...base, ...overrides }));
    this.keys = this.sortedKeys();
  }

  private sortedKeys(): string[] {
    return [...this.prices.keys()].sort((a, b) => b.length - a.length);
  }

  set(model: string, price: ModelPrice): void {
    this.prices.set(model, price);
    this.keys = this.sortedKeys();
  }

  entries(): [string, ModelPrice][] {
    return [...this.prices.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  lookup(model: string | undefined): ModelPrice | undefined {
    if (!model) return undefined;
    const normalized = model.toLowerCase().replace(/^models\//, "");
    const bare = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
    for (const candidate of [normalized, bare]) {
      const exact = this.prices.get(candidate);
      if (exact) return exact;
      for (const key of this.keys) if (candidate.startsWith(key)) return this.prices.get(key);
    }
    return undefined;
  }

  /**
   * Cost of a request. `extraBaselineInputTokens` are prompt tokens TokenSip
   * removed before sending; they count toward the baseline only.
   */
  cost(model: string | undefined, usage: Usage, extraBaselineInputTokens = 0): CostBreakdown {
    const price = this.lookup(model);
    if (!price) return { actual: 0, baseline: 0, saved: 0, priced: false };
    return computeCost(price, usage, extraBaselineInputTokens);
  }
}

export function computeCost(price: ModelPrice, usage: Usage, extraBaselineInputTokens = 0): CostBreakdown {
  const cacheRead = price.cacheRead ?? price.input;
  const cacheWrite = price.cacheWrite ?? price.input;
  const actual =
    (usage.inputTokens * price.input +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite +
      usage.outputTokens * price.output) /
    1e6;
  const promptTotal = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + extraBaselineInputTokens;
  const baseline = (promptTotal * price.input + usage.outputTokens * price.output) / 1e6;
  // Can be negative on a turn that only writes to the Anthropic cache (writes cost 1.25x).
  return { actual, baseline, saved: baseline - actual, priced: true };
}
