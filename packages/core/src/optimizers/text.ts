/** Keep the head and tail of a long text, cutting at line boundaries when close. */
export function headTail(text: string, budgetChars: number, label = "content"): string {
  if (text.length <= budgetChars) return text;
  const headLen = Math.floor(budgetChars * 0.7);
  const tailLen = Math.floor(budgetChars * 0.3);
  let headEnd = text.lastIndexOf("\n", headLen);
  if (headEnd === -1 || headLen - headEnd > 300) headEnd = headLen;
  let tailStart = text.indexOf("\n", text.length - tailLen);
  if (tailStart === -1 || tailStart - (text.length - tailLen) > 300) tailStart = text.length - tailLen;
  if (tailStart <= headEnd) return text;
  const omitted = Math.ceil((tailStart - headEnd) / 4);
  return `${text.slice(0, headEnd)}\n[TokenSip: ~${omitted} tokens of ${label} omitted]\n${text.slice(tailStart)}`;
}

const FENCE = /(```[\s\S]*?```)/g;

/** Aggressive prose compaction: collapse all whitespace runs outside code fences. */
export function compactProse(text: string): string {
  return text
    .split(FENCE)
    .map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/[ \t]+/g, " ").replace(/ ?\n[ \t\n]*/g, "\n")))
    .join("")
    .trim();
}
