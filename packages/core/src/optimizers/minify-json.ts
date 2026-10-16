import { minifyJsonText } from "../json.js";
import type { Stage } from "./types.js";
import { rewrite } from "./types.js";

/**
 * Removes formatting whitespace from tool results that are pure JSON.
 * The data is identical (no parse/re-serialize, so big integers and float
 * formatting survive), but agents that later edit *JSON files* via exact
 * string matching could see different whitespace than the file on disk —
 * which is why this stage lives in the `balanced` profile, not `safe`.
 */
export const minifyJson: Stage = {
  id: "minify-json",
  safety: "equivalent",
  description: "Strips pretty-print whitespace from JSON tool results without re-serializing values.",
  run(ctx) {
    let edits = 0;
    let tokensSaved = 0;
    for (const slot of ctx.adapter.slots(ctx.payload)) {
      if (!slot.isToolResult) continue;
      const text = slot.get();
      if (text.length < 64) continue;
      const min = minifyJsonText(text);
      if (min !== null && min.length < text.length) {
        tokensSaved += rewrite(ctx, slot, min);
        edits++;
      }
    }
    return { edits, tokensSaved };
  },
};
