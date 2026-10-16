import { isObj } from "./protocols/types.js";
import type { Protocol, Usage } from "./types.js";

type J = Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimated: false,
  };
}

/** Parse the usage block of a non-streaming response body. */
export function usageFromResponse(protocol: Protocol, body: unknown): Usage | null {
  if (!isObj(body)) return null;
  switch (protocol) {
    case "openai-chat":
      return isObj(body.usage) ? fromOpenAIChat(body.usage) : null;
    case "openai-responses":
      return isObj(body.usage) ? fromOpenAIResponses(body.usage) : null;
    case "anthropic":
      return isObj(body.usage) ? fromAnthropic(body.usage) : null;
    case "gemini":
      return isObj(body.usageMetadata) ? fromGemini(body.usageMetadata) : null;
  }
}

function fromOpenAIChat(u: J): Usage {
  const details = isObj(u.prompt_tokens_details) ? u.prompt_tokens_details : {};
  const outDetails = isObj(u.completion_tokens_details) ? u.completion_tokens_details : {};
  // DeepSeek reports cache hits with its own field names.
  const cached = num(details.cached_tokens) || num(u.prompt_cache_hit_tokens);
  const prompt = num(u.prompt_tokens);
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: num(u.completion_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: num(outDetails.reasoning_tokens),
    estimated: false,
  };
}

function fromOpenAIResponses(u: J): Usage {
  const details = isObj(u.input_tokens_details) ? u.input_tokens_details : {};
  const outDetails = isObj(u.output_tokens_details) ? u.output_tokens_details : {};
  const cached = num(details.cached_tokens);
  return {
    inputTokens: Math.max(0, num(u.input_tokens) - cached),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: num(outDetails.reasoning_tokens),
    estimated: false,
  };
}

function fromAnthropic(u: J): Usage {
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    reasoningTokens: 0,
    estimated: false,
  };
}

function fromGemini(u: J): Usage {
  const cached = num(u.cachedContentTokenCount);
  const thoughts = num(u.thoughtsTokenCount);
  return {
    inputTokens: Math.max(0, num(u.promptTokenCount) - cached),
    outputTokens: num(u.candidatesTokenCount) + thoughts,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    reasoningTokens: thoughts,
    estimated: false,
  };
}

/**
 * Accumulates usage from streaming events (already JSON-parsed `data:` payloads).
 * Also collects generated text so output tokens can be estimated when a
 * provider doesn't report usage on streams.
 */
export class StreamUsageAccumulator {
  private usage: Usage | null = null;
  private text = "";

  constructor(private readonly protocol: Protocol) {}

  push(data: unknown): void {
    if (!isObj(data)) return;
    switch (this.protocol) {
      case "openai-chat": {
        if (isObj(data.usage)) this.usage = fromOpenAIChat(data.usage);
        if (Array.isArray(data.choices)) {
          for (const c of data.choices) {
            if (isObj(c) && isObj(c.delta)) {
              if (typeof c.delta.content === "string") this.text += c.delta.content;
              if (typeof c.delta.reasoning_content === "string") this.text += c.delta.reasoning_content;
              if (Array.isArray(c.delta.tool_calls)) {
                for (const t of c.delta.tool_calls) {
                  if (isObj(t) && isObj(t.function) && typeof t.function.arguments === "string") {
                    this.text += t.function.arguments;
                  }
                }
              }
            }
          }
        }
        break;
      }
      case "openai-responses": {
        if (data.type === "response.output_text.delta" && typeof data.delta === "string") this.text += data.delta;
        if (
          (data.type === "response.completed" || data.type === "response.incomplete") &&
          isObj(data.response) &&
          isObj(data.response.usage)
        ) {
          this.usage = fromOpenAIResponses(data.response.usage);
        }
        break;
      }
      case "anthropic": {
        if (data.type === "message_start" && isObj(data.message) && isObj(data.message.usage)) {
          this.usage = fromAnthropic(data.message.usage);
        } else if (data.type === "message_delta" && isObj(data.usage)) {
          const u = this.usage ?? emptyUsage();
          const d = data.usage;
          u.outputTokens = num(d.output_tokens) || u.outputTokens;
          if (typeof d.input_tokens === "number") u.inputTokens = d.input_tokens;
          if (typeof d.cache_read_input_tokens === "number") u.cacheReadTokens = d.cache_read_input_tokens;
          if (typeof d.cache_creation_input_tokens === "number") u.cacheWriteTokens = d.cache_creation_input_tokens;
          this.usage = u;
        } else if (data.type === "content_block_delta" && isObj(data.delta)) {
          const d = data.delta;
          if (typeof d.text === "string") this.text += d.text;
          if (typeof d.partial_json === "string") this.text += d.partial_json;
          if (typeof d.thinking === "string") this.text += d.thinking;
        }
        break;
      }
      case "gemini": {
        if (isObj(data.usageMetadata)) this.usage = fromGemini(data.usageMetadata);
        if (Array.isArray(data.candidates)) {
          for (const c of data.candidates) {
            if (isObj(c) && isObj(c.content) && Array.isArray(c.content.parts)) {
              for (const p of c.content.parts) if (isObj(p) && typeof p.text === "string") this.text += p.text;
            }
          }
        }
        break;
      }
    }
  }

  hasUsage(): boolean {
    return this.usage !== null;
  }

  /** Generated text seen so far (used for output-token estimation). */
  generatedText(): string {
    return this.text;
  }

  result(): Usage | null {
    return this.usage;
  }
}
