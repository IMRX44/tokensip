import { messageOffset } from "../session/blocks.js";
import { observations, supersededMap, tombstone } from "../session/supersede.js";
import type { Stage } from "./types.js";
import { NOOP } from "./types.js";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * Replaces tool outputs that a later observation of the same resource has made
 * outdated — and does it on a cache-economic schedule.
 *
 * Rewriting an old message invalidates the provider's prompt cache from that
 * point on. So pending replacements are applied only when that is free (the
 * cache is cold, or the region is being re-sent anyway) or when the read
 * discount saved over the expected remaining turns exceeds the one-off cost of
 * re-writing the cache. Once applied, a replacement is sticky for the session,
 * keeping every later prompt prefix byte-stable.
 */
export const supersedeObservations: Stage = {
  id: "supersede-observations",
  safety: "equivalent",
  protocols: ["openai-chat", "anthropic", "openai-responses"],
  description:
    "Removes tool outputs made outdated by a newer read of the same file/command — only when it pays off against prompt-cache rebuild cost.",
  run(ctx) {
    const s = ctx.session;
    if (!s) return { ...NOOP, note: "needs session tracking" };
    const obs = observations(ctx.protocol, ctx.payload);
    const superseded = supersededMap(obs, ctx.options.dedupeMinTokens * 3);
    if (superseded.size === 0) return NOOP;

    const byId = new Map(obs.map((o) => [o.callId, o]));
    const pending = [...superseded.keys()].filter((id) => !s.state.applied.has(id));
    let apply = new Set([...superseded.keys()].filter((id) => s.state.applied.has(id)));

    if (pending.length > 0) {
      const pendingTokens = pending.reduce(
        (sum, id) => sum + Math.ceil((byId.get(id)?.result.text().length ?? 0) / 4),
        0,
      );
      const firstAt = Math.min(...pending.map((id) => messageOffset(s.origBlocks, byId.get(id)?.messageIndex ?? 0)));
      const rebuildTokens = Math.max(0, s.cachedUpTo - firstAt);
      const extraCost = rebuildTokens * Math.max(0, s.writeRatio - s.readRatio);
      const savings = pendingTokens * s.readRatio * s.horizon;
      let applyNow: boolean;
      let reason: string;
      if (s.eager) {
        applyNow = true;
        reason = "eager mode";
      } else if (!s.warm) {
        applyNow = true;
        reason = "cache is cold — applied for free";
      } else if (extraCost === 0) {
        applyNow = true;
        reason = "region is re-sent anyway — applied for free";
      } else if (savings >= extraCost) {
        applyNow = true;
        reason = `pays back: saves ≈${fmt(savings)} vs one-off rebuild ≈${fmt(extraCost)} (input-token units)`;
      } else {
        applyNow = false;
        reason = `deferred: rebuild ≈${fmt(extraCost)} > savings ≈${fmt(savings)} — waiting for a free moment`;
      }
      s.decision = { pending: pending.length, pendingTokens, applied: applyNow, reason };
      if (applyNow) {
        for (const id of pending) s.state.applied.add(id);
        apply = new Set(superseded.keys());
      }
    }

    let edits = 0;
    let tokensSaved = 0;
    for (const id of apply) {
      const older = byId.get(id);
      const newer = superseded.get(id);
      if (!older || !newer) continue;
      const before = older.result.text();
      const tokens = ctx.count(before);
      const text = tombstone(older, newer, tokens);
      older.result.replace(text);
      tokensSaved += Math.max(0, tokens - ctx.count(text));
      edits++;
    }
    return { edits, tokensSaved, note: s.decision?.reason };
  },
};
