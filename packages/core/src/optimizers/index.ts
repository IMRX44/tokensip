import type { ProfileId, StageId } from "../types.js";
import { anthropicCacheBreakpoints } from "./anthropic-cache.js";
import { contextBudget } from "./context-budget.js";
import { dedupeToolResults } from "./dedupe-tool-results.js";
import { historyWindow } from "./history-window.js";
import { minifyJson } from "./minify-json.js";
import { normalizeWhitespace } from "./normalize-whitespace.js";
import { openaiPromptCacheKey } from "./openai-cache-key.js";
import { capOutput, imageDetailLow, reduceReasoning } from "./request-params.js";
import { relocateVolatile, stabilizeTools } from "./stabilize.js";
import { supersedeObservations } from "./supersede.js";
import { truncateStaleToolResults } from "./truncate-stale.js";
import type { Stage } from "./types.js";

/** All stages in execution order. Lossy stages run last. */
export const STAGES: readonly Stage[] = [
  // Cache Doctor repairs and supersession run on the client's original bytes first.
  stabilizeTools,
  relocateVolatile,
  supersedeObservations,
  normalizeWhitespace,
  minifyJson,
  dedupeToolResults,
  truncateStaleToolResults,
  historyWindow,
  contextBudget,
  imageDetailLow,
  reduceReasoning,
  capOutput,
  // cache shaping runs after content edits so breakpoints/keys describe the final payload
  anthropicCacheBreakpoints,
  openaiPromptCacheKey,
];

export const STAGE_BY_ID = new Map<StageId, Stage>(STAGES.map((s) => [s.id, s]));

export const PROFILES: Record<ProfileId, StageId[]> = {
  off: [],
  safe: ["stabilize-tools", "normalize-whitespace", "anthropic-cache-breakpoints", "openai-prompt-cache-key"],
  balanced: [
    "stabilize-tools",
    "relocate-volatile",
    "supersede-observations",
    "normalize-whitespace",
    "dedupe-tool-results",
    "anthropic-cache-breakpoints",
    "openai-prompt-cache-key",
  ],
  aggressive: [
    "stabilize-tools",
    "relocate-volatile",
    "supersede-observations",
    "normalize-whitespace",
    "minify-json",
    "dedupe-tool-results",
    "truncate-stale-tool-results",
    "history-window",
    "image-detail-low",
    "anthropic-cache-breakpoints",
    "openai-prompt-cache-key",
  ],
  extreme: [
    "stabilize-tools",
    "relocate-volatile",
    "supersede-observations",
    "normalize-whitespace",
    "minify-json",
    "dedupe-tool-results",
    "truncate-stale-tool-results",
    "history-window",
    "context-budget",
    "image-detail-low",
    "reduce-reasoning",
    "cap-output",
    "anthropic-cache-breakpoints",
    "openai-prompt-cache-key",
  ],
};

export interface ProfileInfo {
  id: ProfileId;
  /** Rough share of prompt tokens that still reach the model (1 = everything). */
  typicalPromptRatio: string;
  risk: "none" | "low" | "medium" | "high";
  /** Shown to users before they enable the profile. Undefined for lossless profiles. */
  warning?: string;
}

export const PROFILE_INFO: Record<ProfileId, ProfileInfo> = {
  off: { id: "off", typicalPromptRatio: "100%", risk: "none" },
  safe: {
    id: "safe",
    typicalPromptRatio: "95–100% (cost cut via caching)",
    risk: "none",
  },
  balanced: { id: "balanced", typicalPromptRatio: "70–95%", risk: "low" },
  aggressive: {
    id: "aggressive",
    typicalPromptRatio: "40–70%",
    risk: "medium",
    warning:
      "Aggressive mode drops old conversation turns and truncates stale tool output. Long agent sessions may forget earlier details.",
  },
  extreme: {
    id: "extreme",
    typicalPromptRatio: "≈10% (configurable target)",
    risk: "high",
    warning:
      "Extreme mode compresses prompts to ~10% of their size and caps reasoning and output. Expect noticeably worse answers, cut-off output and broken agent tool use. Use only for cheap bulk or low-stakes tasks.",
  },
};

export { normalizeProse } from "./normalize-whitespace.js";
export { compactProse, headTail } from "./text.js";
export type { Stage, StageContext, StageResult } from "./types.js";
