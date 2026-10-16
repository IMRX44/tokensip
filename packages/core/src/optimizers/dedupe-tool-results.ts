import { sha256 } from "../json.js";
import type { Stage } from "./types.js";
import { rewrite } from "./types.js";

/**
 * Agents often re-read the same file or re-run the same command. When a tool
 * result is byte-identical to an earlier one, the later copy is replaced by a
 * short pointer. Earlier messages are never modified, so the conversation
 * prefix (and the provider's prompt cache) stays stable turn after turn.
 */
export const dedupeToolResults: Stage = {
  id: "dedupe-tool-results",
  safety: "equivalent",
  description: "Replaces repeated, byte-identical tool outputs with a pointer to the first copy.",
  run(ctx) {
    const seen = new Map<string, string | undefined>();
    let edits = 0;
    let tokensSaved = 0;
    for (const slot of ctx.adapter.slots(ctx.payload)) {
      if (!slot.isToolResult) continue;
      const text = slot.get();
      if (text.length < ctx.options.dedupeMinTokens * 3) continue;
      const hash = sha256(text);
      if (!seen.has(hash)) {
        seen.set(hash, slot.toolCallId);
        continue;
      }
      if (ctx.count(text) < ctx.options.dedupeMinTokens) continue;
      const ref = seen.get(hash);
      const pointer = `[TokenSip] This output is identical to an earlier tool result${ref ? ` (${ref})` : ""} in this conversation; see that result for the full content.`;
      tokensSaved += rewrite(ctx, slot, pointer);
      edits++;
    }
    return { edits, tokensSaved };
  },
};
