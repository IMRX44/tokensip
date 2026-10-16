import type { Stage } from "./types.js";
import { rewrite } from "./types.js";

function cutAtLine(text: string, at: number, forward: boolean): number {
  const nl = forward ? text.indexOf("\n", at) : text.lastIndexOf("\n", at);
  if (nl === -1 || Math.abs(nl - at) > 400) return at;
  return forward ? nl + 1 : nl;
}

/**
 * Shortens very large tool results once the agent has moved on: results
 * followed by at least `keepRecentSteps` assistant steps keep their head and
 * tail, with an explicit marker in between. Lossy — opt in only.
 */
export const truncateStaleToolResults: Stage = {
  id: "truncate-stale-tool-results",
  safety: "lossy",
  description: "Keeps head and tail of large tool outputs the agent has moved past, with an explicit omission marker.",
  run(ctx) {
    const messages = ctx.adapter.messages(ctx.payload);
    const assistantIdx = messages.filter((m) => m.role === "assistant").map((m) => m.index);
    const cutoff = assistantIdx[assistantIdx.length - ctx.options.keepRecentSteps];
    if (cutoff === undefined) return { edits: 0, tokensSaved: 0 };

    const budgetChars = ctx.options.maxStaleToolTokens * 4;
    let edits = 0;
    let tokensSaved = 0;
    for (const slot of ctx.adapter.slots(ctx.payload)) {
      if (!slot.isToolResult || slot.messageIndex >= cutoff) continue;
      const text = slot.get();
      if (text.length <= budgetChars * 1.25) continue;
      const tokens = ctx.count(text);
      if (tokens <= ctx.options.maxStaleToolTokens) continue;
      const headEnd = cutAtLine(text, Math.floor(budgetChars * 0.7), false);
      const tailStart = cutAtLine(text, text.length - Math.floor(budgetChars * 0.3), true);
      if (tailStart <= headEnd) continue;
      const omitted = ctx.count(text.slice(headEnd, tailStart));
      const next = `${text.slice(0, headEnd)}\n[TokenSip: ~${omitted} tokens of earlier tool output omitted]\n${text.slice(tailStart)}`;
      tokensSaved += rewrite(ctx, slot, next);
      edits++;
    }
    return { edits, tokensSaved };
  },
};
