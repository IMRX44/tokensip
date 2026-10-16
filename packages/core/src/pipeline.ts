import { PROFILES, STAGES } from "./optimizers/index.js";
import type { StageContext } from "./optimizers/types.js";
import { adapterFor } from "./protocols/index.js";
import { countTokens } from "./tokenizer.js";
import type { OptimizeOptions, OptimizeResult, ProfileId, StageId, StageOptions, StageReport } from "./types.js";

export const DEFAULT_STAGE_OPTIONS: Required<StageOptions> = {
  dedupeMinTokens: 200,
  keepRecentSteps: 8,
  maxStaleToolTokens: 2000,
  maxMessages: 60,
  minCacheableTokens: 1024,
  targetRatio: 0.1,
  minBudgetTokens: 512,
  maxOutputTokens: 1024,
  reasoningEffort: "low",
  maxThinkingTokens: 1024,
};

/** Strings longer than this are counted approximately to keep proxy overhead in the low milliseconds. */
const EXACT_COUNT_MAX_CHARS = 120_000;

export function resolveStages(opts: Pick<OptimizeOptions, "profile" | "stages" | "overrides">): Set<StageId> {
  const base = opts.stages ?? PROFILES[opts.profile ?? "safe"];
  const set = new Set<StageId>(base);
  for (const [id, on] of Object.entries(opts.overrides ?? {}) as [StageId, boolean][]) {
    if (on) set.add(id);
    else set.delete(id);
  }
  return set;
}

/**
 * Optimize a native request payload. The input is never mutated.
 *
 * Every stage is deterministic and prefix-stable: the rewrite of message `i`
 * depends only on messages `0..i`, so the same conversation produces the same
 * prefix on every turn and provider prompt caches keep hitting.
 */
export function optimize<T>(payload: T, opts: OptimizeOptions): OptimizeResult<T> {
  const started = performance.now();
  const mode = opts.tokenCounting ?? "exact";
  const count = (text: string) =>
    countTokens(text, mode === "approx" || text.length > EXACT_COUNT_MAX_CHARS ? "approx" : "exact");

  const enabled = resolveStages(opts);
  const profile: ProfileId | "custom" =
    opts.stages || (opts.overrides && Object.keys(opts.overrides).length > 0) ? "custom" : (opts.profile ?? "safe");

  if (!payload || typeof payload !== "object" || Array.isArray(payload) || enabled.size === 0) {
    return {
      payload,
      report: {
        protocol: opts.protocol,
        profile,
        changed: false,
        tokensBefore: 0,
        tokensAfter: 0,
        tokensSaved: 0,
        lossy: false,
        stages: [],
        durationMs: performance.now() - started,
      },
    };
  }

  const work = structuredClone(payload) as Record<string, unknown>;
  const adapter = adapterFor(opts.protocol);
  const totalApprox = () => adapter.slots(work).reduce((sum, slot) => sum + Math.ceil(slot.get().length / 4), 0);
  const tokensBefore =
    mode === "exact" ? adapter.slots(work).reduce((s, slot) => s + count(slot.get()), 0) : totalApprox();

  const ctx: StageContext = {
    payload: work,
    adapter,
    protocol: opts.protocol,
    model: opts.model ?? (typeof work.model === "string" ? work.model : undefined),
    provider: opts.provider,
    cacheKeySalt: opts.cacheKeySalt,
    options: { ...DEFAULT_STAGE_OPTIONS, ...opts.options },
    count,
  };

  const stages: StageReport[] = [];
  let edits = 0;
  let tokensSaved = 0;
  for (const stage of STAGES) {
    if (!enabled.has(stage.id)) continue;
    if (stage.protocols && !stage.protocols.includes(opts.protocol)) continue;
    const result = stage.run(ctx);
    edits += result.edits;
    tokensSaved += result.tokensSaved;
    stages.push({
      id: stage.id,
      safety: stage.safety,
      applied: result.edits > 0,
      tokensSaved: result.tokensSaved,
      edits: result.edits,
      note: result.note,
    });
  }

  const changed = edits > 0;
  return {
    payload: (changed ? work : payload) as T,
    report: {
      protocol: opts.protocol,
      profile,
      changed,
      tokensBefore,
      tokensAfter: Math.max(0, tokensBefore - tokensSaved),
      tokensSaved,
      lossy: stages.some((s) => s.applied && s.safety === "lossy"),
      stages,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    },
  };
}
