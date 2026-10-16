import { createHash } from "node:crypto";
import { canonicalJson } from "../json.js";
import { optimize } from "../pipeline.js";
import type { PriceBook } from "../pricing.js";
import { adapterFor } from "../protocols/index.js";
import type { OptimizeOptions, OptimizeResult, Usage } from "../types.js";
import { type Block, blocksOf, commonPrefix, totalTokens } from "./blocks.js";
import { type CacheLeak, detectLeak, volatileSpan } from "./leaks.js";
import type { SchedulerDecision, SessionRuntime, SessionState } from "./runtime.js";

export interface SessionReport {
  id: string;
  turn: number;
  /** Provider cache believed warm for this conversation. */
  warm: boolean;
  /** Prompt tokens the shadow cache expects the provider to serve from cache. */
  predictedCachedTokens: number;
  promptTokens: number;
  leak?: CacheLeak;
  decision?: SchedulerDecision;
  repairs: string[];
}

export interface SessionEngineOptions {
  /** Maximum conversations kept in memory (least recently used are evicted). */
  maxSessions?: number;
  /** Conversations idle for longer than this are forgotten. */
  idleMs?: number;
  /** Prices for cache economics. A function so a live, editable PriceBook can be passed. */
  prices?: () => PriceBook | undefined;
  /**
   * `economic` (default) schedules context changes around the provider cache.
   * `eager` applies them every turn, like conventional pruning — useful for comparisons.
   */
  schedule?: "economic" | "eager";
}

/** Seconds after which a provider's prompt cache is assumed cold. */
function warmWindowMs(model: string, provider?: string): number {
  if (provider === "deepseek" || /deepseek/i.test(model)) return 60 * 60_000; // disk-backed cache
  return 5 * 60_000; // Anthropic 5-minute TTL; OpenAI/Gemini typically 5–10 minutes
}

function ratios(model: string, prices: PriceBook | undefined): { read: number; write: number } {
  const price = prices?.lookup(model);
  if (price && price.input > 0) {
    return {
      read: price.cacheRead !== undefined ? price.cacheRead / price.input : /claude/i.test(model) ? 0.1 : 0.5,
      write: price.cacheWrite !== undefined ? price.cacheWrite / price.input : /claude/i.test(model) ? 1.25 : 1,
    };
  }
  return /claude/i.test(model) ? { read: 0.1, write: 1.25 } : { read: 0.5, write: 1 };
}

const hash = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 16);

const toolName = (t: unknown): string => {
  const o = t as { name?: unknown; function?: { name?: unknown } };
  return typeof o?.name === "string" ? o.name : typeof o?.function?.name === "string" ? o.function.name : "";
};

/**
 * Blocks as the provider will see them once Cache Doctor repairs are applied
 * (canonical tools, volatile system value replaced by its placeholder), so the
 * shadow cache predicts real cache hits instead of seeing the client's leak.
 */
function comparableBlocks(
  payload: Record<string, unknown>,
  orig: Block[],
  state: SessionState,
  profile: OptimizeOptions["profile"],
): Block[] {
  const repairsOn = profile !== "off" && profile !== undefined;
  if (!repairsOn || (!state.sortTools && !state.volatile)) return orig;
  const out = orig.slice();
  if (state.sortTools && Array.isArray(payload.tools)) {
    const sorted = [...payload.tools]
      .map((t) => JSON.parse(canonicalJson(t)) as unknown)
      .sort((a, b) => toolName(a).localeCompare(toolName(b)));
    let i = 0;
    for (let k = 0; k < out.length; k++) {
      if (out[k]?.region !== "tools") continue;
      const sig = hash(JSON.stringify(sorted[i++] ?? null));
      out[k] = { ...(out[k] as Block), hash: sig, canon: sig };
    }
  }
  const v = state.volatile;
  if (v && profile !== "safe") {
    for (let k = 0; k < out.length; k++) {
      const b = out[k] as Block;
      if (b.region !== "system" || b.index !== v.systemIndex || b.text === undefined) continue;
      if (b.text.startsWith(v.prefix) && b.text.endsWith(v.suffix)) {
        const sig = hash(`${v.prefix}\u0000${v.suffix}`);
        out[k] = { ...b, hash: sig, canon: sig };
      }
    }
  }
  return out;
}

/**
 * Tracks conversations across stateless API calls and runs the optimizer with
 * conversation context: a shadow model of the provider's prompt cache, cache
 * leak detection, and cache-economic scheduling of context changes.
 *
 * State lives in memory only. Losing it (a restart) is always safe: the next
 * request simply behaves like the first turn of a conversation.
 */
export class SessionEngine {
  private readonly sessions = new Map<string, SessionState>();
  private readonly maxSessions: number;
  private readonly idleMs: number;

  constructor(private readonly opts: SessionEngineOptions = {}) {
    this.maxSessions = opts.maxSessions ?? 5000;
    this.idleMs = opts.idleMs ?? 6 * 60 * 60_000;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Stable id of the conversation a request belongs to (tenant + model + first user turn). */
  sessionId(
    payload: Record<string, unknown>,
    opts: { protocol: OptimizeOptions["protocol"]; tenant?: string; model?: string },
  ): string | undefined {
    const first = adapterFor(opts.protocol)
      .slots(payload)
      .find((s) => s.role === "user" && !s.isToolResult);
    if (!first) return undefined;
    return hash(`${opts.tenant ?? ""}|${opts.protocol}|${opts.model ?? payload.model ?? ""}|${first.get()}`);
  }

  private state(id: string, now: number): SessionState {
    let s = this.sessions.get(id);
    if (s && now - s.lastAt > this.idleMs) s = undefined;
    if (!s) {
      s = {
        id,
        createdAt: now,
        lastAt: 0,
        turns: 0,
        prevOriginal: [],
        prevComparable: [],
        applied: new Set(),
        sortTools: false,
        appendices: new Map(),
        observedCacheRatio: null,
        leaks: 0,
      };
    }
    // LRU: re-insert as most recent
    this.sessions.delete(id);
    this.sessions.set(id, s);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return s;
  }

  run<T>(
    payload: T,
    o: OptimizeOptions & { tenant?: string; now?: number },
  ): OptimizeResult<T> & { session?: SessionReport } {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return optimize(payload, o);
    const p = payload as Record<string, unknown>;
    const model = o.model ?? (typeof p.model === "string" ? p.model : "");
    const id = this.sessionId(p, { protocol: o.protocol, tenant: o.tenant, model });
    if (!id) return optimize(payload, o);

    const now = o.now ?? Date.now();
    const state = this.state(id, now);
    const origBlocks = blocksOf(o.protocol, p);

    // ---- cache doctor: what did the client change since the previous turn?
    let leak: CacheLeak | undefined;
    if (state.prevOriginal.length > 0) {
      leak = detectLeak(state.prevOriginal, origBlocks);
      if (leak) {
        state.leaks++;
        state.lastLeak = leak;
        if (leak.location === "tools" && (leak.kind === "tool-order" || leak.kind === "json-key-order"))
          state.sortTools = true;
        if (leak.location.startsWith("system[") && ["timestamp", "id", "counter"].includes(leak.kind)) {
          const index = Number(/system\[(\d+)\]/.exec(leak.location)?.[1] ?? 0);
          const was = state.prevOriginal.find((b) => b.region === "system" && b.index === index)?.text;
          const cur = origBlocks.find((b) => b.region === "system" && b.index === index)?.text;
          const span = was !== undefined && cur !== undefined ? volatileSpan(was, cur) : undefined;
          if (span) state.volatile = { systemIndex: index, prefix: span.prefix, suffix: span.suffix };
        }
      }
    }

    // ---- shadow cache: how much of this prompt does the provider still have cached?
    // Compare what the provider receives — i.e. with Cache Doctor repairs applied — not the raw client bytes.
    const comparable = comparableBlocks(p, origBlocks, state, o.profile);
    const warm = state.turns > 0 && now - state.lastAt < warmWindowMs(model, o.provider);
    const cachedUpTo = warm ? commonPrefix(state.prevComparable, comparable).tokens : 0;
    const r = ratios(model, this.opts.prices?.());
    // Learned behavior wins over list prices: a provider that never reports cache hits isn't caching.
    const readRatio =
      state.observedCacheRatio !== null && state.turns >= 3 && state.observedCacheRatio < 0.02 ? 1 : r.read;

    const runtime: SessionRuntime = {
      state,
      origBlocks,
      warm,
      cachedUpTo,
      readRatio,
      writeRatio: readRatio === 1 ? 1 : r.write,
      horizon: Math.min(30, Math.max(2, state.turns)),
      eager: this.opts.schedule === "eager",
      repairs: [],
    };

    const result = optimize(payload, { ...o, session: runtime });

    state.prevOriginal = origBlocks;
    state.prevComparable = comparable;
    state.lastAt = now;
    state.turns++;
    return {
      ...result,
      session: {
        id,
        turn: state.turns,
        warm,
        predictedCachedTokens: cachedUpTo,
        promptTokens: totalTokens(origBlocks),
        leak,
        decision: runtime.decision,
        repairs: runtime.repairs,
      },
    };
  }

  /** Feed back the usage the provider reported, so the engine learns how well it really caches. */
  observe(sessionId: string, usage: Usage): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    if (prompt <= 0 || s.turns < 2) return; // the first turn can't hit the cache
    const ratio = usage.cacheReadTokens / prompt;
    s.observedCacheRatio = s.observedCacheRatio === null ? ratio : 0.7 * s.observedCacheRatio + 0.3 * ratio;
  }
}
