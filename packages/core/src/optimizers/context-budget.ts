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
 *   3. drop the middle of the conversation (task + latest steps survive)
 *   4. head/tail-truncate every remaining text, newest messages last
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
    const target = Math.max(ctx.options.minBudgetTokens, Math.ceil(original * ctx.options.targetRatio));
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

    // 3. Shrink the conversation window step by step.
    for (let max = ctx.adapter.messages(ctx.payload).length - 2; over() && max >= 3; max = Math.floor(max * 0.6)) {
      const r = windowMessages(ctx, max);
      tokensSaved += r.tokensSaved;
      edits += r.dropped;
    }

    // 4. Proportionally truncate whatever is left; latest messages keep a bigger share.
    if (over()) {
      const slots = ctx.adapter.slots(ctx.payload);
      const total = promptSize(ctx);
      const lastIndex = Math.max(...slots.map((s) => s.messageIndex));
      for (const slot of slots) {
        const size = approx(slot.get());
        const weight = slot.messageIndex === lastIndex ? 2 : 1;
        const share = Math.max(64, Math.floor(target * (size / total) * weight));
        const next = headTail(slot.get(), share * 4, slot.role === "system" ? "instructions" : "content");
        if (next !== slot.get()) {
          tokensSaved += rewrite(ctx, slot, next);
          edits++;
        }
      }
    }

    const finalSize = promptSize(ctx);
    return {
      edits,
      tokensSaved,
      note: `prompt ~${original} → ~${finalSize} tokens (target ${target})`,
    };
  },
};
