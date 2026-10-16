import type { Stage } from "./types.js";
import { rewrite } from "./types.js";

const FENCE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;

/**
 * Normalize whitespace in prose only:
 * - CRLF → LF
 * - strip trailing spaces/tabs at line ends
 * - collapse 3+ consecutive newlines into one blank line
 *
 * Fenced code blocks are left untouched, and tool results are never edited
 * (agents use exact file contents for search/replace edits).
 */
export function normalizeProse(text: string): string {
  return text
    .split(FENCE)
    .map((segment, i) => {
      if (i % 2 === 1) return segment; // fenced code block
      return segment
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n");
    })
    .join("");
}

export const normalizeWhitespace: Stage = {
  id: "normalize-whitespace",
  safety: "lossless",
  description:
    "Trims trailing spaces and runs of blank lines in system/user prose. Code blocks and tool output are never touched.",
  run(ctx) {
    let edits = 0;
    let tokensSaved = 0;
    for (const slot of ctx.adapter.slots(ctx.payload)) {
      if (slot.isToolResult) continue;
      const before = slot.get();
      const after = normalizeProse(before);
      if (after !== before) {
        tokensSaved += rewrite(ctx, slot, after);
        edits++;
      }
    }
    return { edits, tokensSaved };
  },
};
