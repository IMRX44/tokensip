import type { Block } from "./blocks.js";
import type { CacheLeak } from "./leaks.js";

/** Per-conversation memory kept by the SessionEngine (in RAM only). */
export interface SessionState {
  id: string;
  createdAt: number;
  lastAt: number;
  turns: number;
  /** Blocks of the previous request as the client sent it (for leak detection). */
  prevOriginal: Block[];
  /** Blocks of the previous request with Cache Doctor repairs applied — what the provider actually cached. */
  prevComparable: Block[];
  /** Superseded observations already replaced — sticky, so the prompt prefix stays stable. */
  applied: Set<string>;
  /** Tools are re-ordered/re-serialized canonically (after the client was seen shuffling them). */
  sortTools: boolean;
  /** Learned template of a volatile value in the system prompt. */
  volatile?: { systemIndex: number; prefix: string; suffix: string };
  /** Appendices added to user messages (keyed by the original message hash), re-applied every turn. */
  appendices: Map<string, string>;
  /** Moving average of (cache read / prompt) actually reported by the provider; null until observed. */
  observedCacheRatio: number | null;
  leaks: number;
  lastLeak?: CacheLeak;
}

export interface SchedulerDecision {
  pending: number;
  pendingTokens: number;
  applied: boolean;
  reason: string;
}

/** What optimizer stages can see about the conversation. */
export interface SessionRuntime {
  state: SessionState;
  origBlocks: Block[];
  /** The provider's cache is believed to be warm for this conversation. */
  warm: boolean;
  /** Prompt tokens (from the start) expected to be served from the provider cache. */
  cachedUpTo: number;
  /** Cache read price ÷ input price (0.1 for Anthropic, ~0.1–0.5 elsewhere, 1 = no caching). */
  readRatio: number;
  /** Cache write price ÷ input price (1.25 for Anthropic 5-minute writes, 1 when writes are free). */
  writeRatio: number;
  /** Expected remaining turns in the conversation. */
  horizon: number;
  /** Apply superseded replacements immediately, ignoring cache economics (naive pruning; for comparisons). */
  eager?: boolean;
  /** Filled in by stages. */
  decision?: SchedulerDecision;
  repairs: string[];
}
