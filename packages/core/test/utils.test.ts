import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createTokenSipFetch,
  matchProviderByModel,
  minifyJsonText,
  normalizeProse,
  PROVIDERS,
  PriceBook,
  protocolFromPath,
  requestFingerprint,
  SseParser,
  StreamUsageAccumulator,
  usageFromResponse,
} from "../src/index.js";

describe("minifyJsonText", () => {
  it("preserves big integers and string whitespace", () => {
    const src = '{\n  "n": 12345678901234567890,\n  "s": "a  b\\n c"\n}';
    expect(minifyJsonText(src)).toBe('{"n":12345678901234567890,"s":"a  b\\n c"}');
  });
  it("rejects non-JSON and scalars", () => {
    expect(minifyJsonText("hello")).toBeNull();
    expect(minifyJsonText("42")).toBeNull();
    expect(minifyJsonText("{broken")).toBeNull();
  });
});

describe("normalizeProse", () => {
  it("leaves fenced code intact", () => {
    const code = "```py\ndef f():  \n\n\n\n    return 1  \n```";
    expect(normalizeProse(`Intro   \n\n\n\n${code}\n\n\n\nEnd  `)).toBe(`Intro\n\n${code}\n\nEnd`);
  });
});

describe("fingerprint", () => {
  it("is key-order independent and ignores user/metadata", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(requestFingerprint({ model: "x", user: "u1", a: 1 })).toBe(
      requestFingerprint({ a: 1, model: "x", user: "u2" }),
    );
  });
});

describe("protocolFromPath", () => {
  it("detects protocols", () => {
    expect(protocolFromPath("/v1/chat/completions")).toBe("openai-chat");
    expect(protocolFromPath("/openai/v1/responses")).toBe("openai-responses");
    expect(protocolFromPath("/v1/messages")).toBe("anthropic");
    expect(protocolFromPath("/v1beta/models/gemini-2.5-flash:streamGenerateContent")).toBe("gemini");
    expect(protocolFromPath("/v1/embeddings")).toBeUndefined();
  });
});

describe("usage", () => {
  it("normalizes OpenAI cached tokens", () => {
    const u = usageFromResponse("openai-chat", {
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });
    expect(u).toMatchObject({
      inputTokens: 200,
      cacheReadTokens: 800,
      outputTokens: 50,
    });
  });
  it("accumulates Anthropic stream usage", () => {
    const acc = new StreamUsageAccumulator("anthropic");
    acc.push({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 500,
          output_tokens: 1,
        },
      },
    });
    acc.push({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "hello" },
    });
    acc.push({ type: "message_delta", usage: { output_tokens: 42 } });
    expect(acc.result()).toMatchObject({
      inputTokens: 10,
      cacheReadTokens: 500,
      outputTokens: 42,
    });
    expect(acc.generatedText()).toBe("hello");
  });
});

describe("SseParser", () => {
  it("handles events split across chunks", () => {
    const p = new SseParser();
    expect(p.push('data: {"a":')).toEqual([]);
    const events = p.push("1}\n\nevent: done\ndata: [DONE]\n\n");
    expect(events.map((e) => e.data)).toEqual(['{"a":1}', "[DONE]"]);
    expect(events[1]?.event).toBe("done");
  });
});

describe("PriceBook", () => {
  it("matches by longest prefix and prices cache reads", () => {
    const book = new PriceBook();
    expect(book.lookup("gpt-4o-mini-2024-07-18")?.input).toBe(0.15);
    expect(book.lookup("openai/gpt-4o")?.input).toBe(2.5);
    const cost = book.cost("claude-sonnet-4-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      estimated: false,
    });
    expect(cost.actual).toBeCloseTo(0.3);
    expect(cost.baseline).toBeCloseTo(3);
    expect(
      book.cost("unknown-model", {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimated: false,
      }).priced,
    ).toBe(false);
  });
});

describe("PriceBook.resolve", () => {
  const book = new PriceBook({ "my-model": { input: 1, output: 2 } });
  it.each([
    ["gpt-5.5-pro", "family", 15],
    ["gpt-5.6-sol", "family", 1.25],
    ["o3-2025-04-16", "list", 2],
    ["gpt-4o-mini-2024-07-18", "list", 0.15],
    ["claude-sonnet-4-5-20250929", "list", 3],
    ["claude-opus-4-1-20250805", "list", 15],
    ["claude-sonnet-5", "family", 3],
    ["gemini-2.5-flash-preview-05-20", "list", 0.3],
    ["deepseek-v4-flash-0731", "family", 0.28],
    ["openrouter/anthropic/claude-sonnet-4.5", "list", 3],
    ["my-model", "override", 1],
  ])("%s → %s", (model, source, input) => {
    const r = book.resolve(model);
    expect(r.source).toBe(source);
    expect(r.price?.input).toBe(input);
  });
  it("never prices a different tier through a prefix", () => {
    expect(book.resolve("o3-pro").source).toBe("none");
    expect(book.resolve("gpt-4o-audio-preview").source).toBe("none");
  });
});

describe("providers", () => {
  it("auto-routes by model name", () => {
    expect(matchProviderByModel("claude-opus-4-5", PROVIDERS)?.id).toBe("anthropic");
    expect(matchProviderByModel("gpt-5-mini", PROVIDERS)?.id).toBe("openai");
    expect(matchProviderByModel("o4-mini", PROVIDERS)?.id).toBe("openai");
    expect(matchProviderByModel("gemini-2.5-pro", PROVIDERS)?.id).toBe("google");
    expect(matchProviderByModel("deepseek-chat", PROVIDERS)?.id).toBe("deepseek");
    expect(matchProviderByModel("llama3:8b", PROVIDERS)).toBeUndefined();
  });
});

describe("createTokenSipFetch", () => {
  it("optimizes chat requests in-process and leaves other calls alone", async () => {
    const seen: string[] = [];
    const fake = (async (_input: unknown, init?: RequestInit) => {
      seen.push(String(init?.body ?? ""));
      return new Response("{}");
    }) as typeof fetch;
    const reports: number[] = [];
    const f = createTokenSipFetch({
      fetch: fake,
      onReport: (r) => reports.push(r.tokensSaved),
    });
    await f("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4.1",
        messages: [{ role: "user", content: "hi   \n\n\n\n\nthere" }],
      }),
    });
    await f("https://api.openai.com/v1/models");
    expect(JSON.parse(seen[0] ?? "{}").messages[0].content).toBe("hi\n\nthere");
    expect(seen[1]).toBe("");
    expect(reports).toHaveLength(1);
  });
});
