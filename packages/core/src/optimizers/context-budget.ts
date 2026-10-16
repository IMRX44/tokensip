import { windowMessages } from "./history-window.js";
import { compactProse, headTail } from "./text.js";
import type { Stage, StageContext } from "./types.js";
import { rewrite } from "./types.js";

const approx = (text: string) => Math.ceil(text.length / 4);

function promptSize(ctx: StageContext): number {
  return ctx.adapter.slots(ctx.payload).reduce((sum, s) => sum + approx(s.get()), 0);
}

/**
 * Compresses the prompt toward a hard budget (`targetRatio` × original size),
 * escalating through progressively more destructive steps and stopping as
 * soon as the budget is met:
 *
 *   1. head/tail-truncate older tool results
 *   2. compact whitespace in all prose
 *   3. head/tail-truncate every text proportionally (newest message weighted 2x)
 *   4. only if still over: drop the middle of the conversation
 *
 * Expect noticeably worse answers — this trades quality for cost.
 */
export const contextBudget: Stage = {
  id: "context-budget",
  safety: "lossy",
  description:
    "Squeezes the prompt down to a target fraction of its size. Large quality loss — the model sees a summary-like view.",
  run(ctx) {
    const original = promptSize(ctx);
    // The budget is a fraction of what the client originally sent, not of what earlier stages left.
    const target = Math.max(ctx.options.minBudgetTokens, Math.ceil(ctx.originalSize * ctx.options.targetRatio));
    if (original <= target) return { edits: 0, tokensSaved: 0, note: "already within budget" };

    let edits = 0;
    let tokensSaved = 0;
    const over = () => promptSize(ctx) > target;

    // 1. Older tool results → 300 tokens each.
    const tools = ctx.adapter.slots(ctx.payload).filter((s) => s.isToolResult);
    for (const slot of tools.slice(0, -1)) {
      if (!over()) break;
      const next = headTail(slot.get(), 1200, "tool output");
      if (next !== slot.get()) {
        tokensSaved += rewrite(ctx, slot, next);
        edits++;
      }
    }

    // 2. Compact prose whitespace everywhere (outside code fences).
    if (over()) {
      for (const slot of ctx.adapter.slots(ctx.payload)) {
        const next = compactProse(slot.get());
        if (next !== slot.get() && next.length > 0) {
          tokensSaved += rewrite(ctx, slot, next);
          edits++;
        }
      }
    }

    // 3. Proportionally truncate every remaining text so all turns survive in abbreviated form.
    //    The newest message gets double weight; shares are normalized so they sum to the target.
    if (over()) {
      const slots = ctx.adapter.slots(ctx.payload);
      const lastIndex = Math.max(...slots.map((s) => s.messageIndex));
      const weightOf = (messageIndex: number) => (messageIndex === lastIndex ? 2 : 1);
      const weighted = slots.reduce((sum, s) => sum + approx(s.get()) * weightOf(s.messageIndex), 0);
      for (const slot of slots) {
        const size = approx(slot.get());
        const share = Math.max(48, Math.floor((target * size * weightOf(slot.messageIndex)) / Math.max(1, weighted)));
        const next = headTail(slot.get(), share * 4, slot.role === "system" ? "instructions" : "content");
        if (next !== slot.get()) {
          tokensSaved += rewrite(ctx, slot, next);
          edits++;
        }
      }
    }

    // 4. Last resort for very long sessions: drop the middle of the conversation (task + latest steps survive).
    for (
      let max = ctx.adapter.messages(ctx.payload).length - 2;
      over() && max >= 3;
      max -= Math.max(2, Math.floor(max * 0.2))
    ) {
      const r = windowMessages(ctx, max);
      tokensSaved += r.tokensSaved;
      edits += r.dropped;
    }

    const finalSize = promptSize(ctx);
    return {
      edits,
      tokensSaved,
      note: `~${ctx.originalSize} → ~${finalSize} tokens (target ${target})`,
    };
  },
};
