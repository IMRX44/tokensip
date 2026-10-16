export interface SseEvent {
  event?: string;
  data: string;
  /** The raw text of the event including its trailing blank line. */
  raw: string;
}

/**
 * Incremental Server-Sent Events parser. Feed it decoded text chunks as they
 * arrive; it yields complete events and keeps the remainder buffered.
 */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      const parsed = parseBlock(raw);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  /** Flush whatever is left (a final event without a trailing blank line). */
  flush(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    if (!rest.trim()) return [];
    const parsed = parseBlock(rest);
    return parsed ? [parsed] : [];
  }
}

function parseBlock(raw: string): SseEvent | null {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && event === undefined) return { data: "", raw };
  return { event, data: data.join("\n"), raw };
}
