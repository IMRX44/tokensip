import type { Stage, StageContext } from "./types.js";

/**
 * Keep system messages, the first user turn and the newest messages, so that
 * at most `max` messages remain. The cut always lands at the start of an
 * assistant step, so tool calls stay paired with their results and role
 * alternation stays valid. Returns the number of dropped messages.
 */
export function windowMessages(ctx: StageContext, max: number): { dropped: number; tokensSaved: number } {
  const msgs = ctx.adapter.messages(ctx.payload);
  if (msgs.length <= max) return { dropped: 0, tokensSaved: 0 };

  const firstUser = msgs.find((m) => m.isUserTurn)?.index;
  if (firstUser === undefined) return { dropped: 0, tokensSaved: 0 };
  const head = new Set<number>(msgs.filter((m) => m.role === "system").map((m) => m.index));
  head.add(firstUser);

  const desired = Math.max(msgs.length - Math.max(1, max - head.size), firstUser + 1);
  let start = -1;
  for (let i = desired; i < msgs.length; i++) {
    const cur = msgs[i];
    const prev = msgs[i - 1];
    if (cur?.role === "assistant" && prev && prev.role !== "assistant") {
      start = i;
      break;
    }
  }
  if (start <= firstUser + 1) return { dropped: 0, tokensSaved: 0 };

  const keep = new Set(head);
  for (let i = start; i < msgs.length; i++) keep.add(i);
  const dropped = new Set(msgs.filter((m) => !keep.has(m.index)).map((m) => m.index));
  if (dropped.size === 0) return { dropped: 0, tokensSaved: 0 };

  let tokensSaved = 0;
  for (const slot of ctx.adapter.slots(ctx.payload)) {
    if (dropped.has(slot.messageIndex)) tokensSaved += ctx.count(slot.get());
  }
  ctx.adapter.keepMessages(
    ctx.payload,
    [...keep].sort((a, b) => a - b),
  );
  return { dropped: dropped.size, tokensSaved };
}

/**
 * Drops the middle of very long conversations. Lossy, and it invalidates
 * prompt caches each time the window slides — use for very long sessions.
 */
export const historyWindow: Stage = {
  id: "history-window",
  safety: "lossy",
  description: "Drops the middle of very long conversations, keeping the task, system prompt and recent steps.",
  run(ctx) {
    const { dropped, tokensSaved } = windowMessages(ctx, ctx.options.maxMessages);
    return dropped
      ? { edits: dropped, tokensSaved, note: `dropped ${dropped} message(s)` }
      : { edits: 0, tokensSaved: 0 };
  },
};
