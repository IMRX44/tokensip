import { describe, expect, it } from "vitest";
import { minifyJsonText, optimize, PROFILES, STAGES } from "../src/index.js";
import { anthropicConversation, BIG_JSON, LONG_FILE, openaiAgentConversation } from "./fixtures.js";

describe("optimize()", () => {
  it("never mutates the input payload", () => {
    const input = openaiAgentConversation();
    const snapshot = JSON.stringify(input);
    optimize(input, { protocol: "openai-chat", profile: "extreme" });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("returns the original object when nothing changes", () => {
    const input = {
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hi" }],
    };
    const res = optimize(input, { protocol: "openai-chat", profile: "safe" });
    expect(res.report.changed).toBe(false);
    expect(res.payload).toBe(input);
  });

  it("safe profile never touches tool results or assistant turns", () => {
    const input = openaiAgentConversation();
    const { payload } = optimize(input, {
      protocol: "openai-chat",
      profile: "safe",
    });
    const out = payload.messages;
    expect(out[3]?.content).toBe(LONG_FILE);
    expect(out[5]?.content).toBe(BIG_JSON);
    expect(out[0]?.content).toBe("You are a coding agent.\n\nFollow the rules.");
    expect(out[8]).toEqual(input.messages[8]);
  });

  it("safe profile is prefix-stable across turns", () => {
    const turn1 = openaiAgentConversation();
    const turn2 = openaiAgentConversation();
    turn2.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "next   \n\n\n\n" });
    const a = optimize(turn1, { protocol: "openai-chat", profile: "balanced" }).payload.messages;
    const b = optimize(turn2, { protocol: "openai-chat", profile: "balanced" }).payload.messages;
    expect(JSON.stringify(b.slice(0, a.length))).toBe(JSON.stringify(a));
  });

  it("aggressive minifies JSON tool output; balanced keeps it exact but dedupes repeats", () => {
    const res = optimize(openaiAgentConversation(), {
      protocol: "openai-chat",
      profile: "aggressive",
    });
    const out = res.payload.messages;
    expect(out[5]?.content).toBe(minifyJsonText(BIG_JSON));
    expect(out[3]?.content).toBe(LONG_FILE);
    expect(out[7]?.content).toMatch(/identical to an earlier tool result \(c1\)/);
    expect(res.report.tokensSaved).toBeGreaterThan(1000);
    const balanced = optimize(openaiAgentConversation(), { protocol: "openai-chat", profile: "balanced" });
    expect(balanced.payload.messages[5]?.content).toBe(BIG_JSON);
    expect(balanced.payload.messages[7]?.content).toMatch(/identical to an earlier tool result/);
    expect(balanced.report.lossy).toBe(false);
  });

  it("extreme profile hits the target ratio and is flagged lossy", () => {
    const input = openaiAgentConversation();
    const res = optimize(input, {
      protocol: "openai-chat",
      profile: "extreme",
      options: { minBudgetTokens: 64 },
    });
    expect(res.report.lossy).toBe(true);
    const before = JSON.stringify(input.messages).length;
    const after = JSON.stringify(res.payload.messages).length;
    expect(after / before).toBeLessThan(0.2);
    expect((res.payload as Record<string, unknown>).max_completion_tokens).toBe(1024);
  });

  it("explicit stage list and overrides work", () => {
    const res = optimize(openaiAgentConversation(), {
      protocol: "openai-chat",
      profile: "safe",
      overrides: { "normalize-whitespace": false, "minify-json": true },
    });
    expect(res.report.profile).toBe("custom");
    expect(res.report.stages.map((s) => s.id)).toContain("minify-json");
    expect(res.report.stages.map((s) => s.id)).not.toContain("normalize-whitespace");
  });

  it("every profile references only known stages", () => {
    const ids = new Set(STAGES.map((s) => s.id));
    for (const stages of Object.values(PROFILES)) for (const id of stages) expect(ids.has(id)).toBe(true);
  });
});

describe("anthropic", () => {
  it("adds cache breakpoints when the client set none", () => {
    const res = optimize(anthropicConversation(), {
      protocol: "anthropic",
      profile: "safe",
    });
    const p = res.payload as ReturnType<typeof anthropicConversation> & Record<string, any>;
    expect(p.tools[0]).toHaveProperty("cache_control");
    expect(Array.isArray(p.system)).toBe(true);
    expect(p.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(p.messages[4].content[0].cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("is byte-for-byte prefix-stable across turns once caching applies", () => {
    const turn1 = anthropicConversation();
    const turn2 = anthropicConversation();
    turn2.messages.push(
      { role: "assistant", content: [{ type: "text", text: "You're welcome" }] },
      { role: "user", content: "One more thing" },
    );
    const strip = (v: unknown) => JSON.parse(JSON.stringify(v), (k, val) => (k === "cache_control" ? undefined : val));
    const a = optimize(turn1, { protocol: "anthropic", profile: "safe" }).payload as Record<string, any>;
    const b = optimize(turn2, { protocol: "anthropic", profile: "safe" }).payload as Record<string, any>;
    expect(JSON.stringify(strip(b.messages.slice(0, a.messages.length)))).toBe(JSON.stringify(strip(a.messages)));
    expect(JSON.stringify(strip(b.system))).toBe(JSON.stringify(strip(a.system)));
  });

  it("respects client-managed cache_control", () => {
    const input = anthropicConversation() as Record<string, any>;
    input.system = [
      {
        type: "text",
        text: input.system,
        cache_control: { type: "ephemeral" },
      },
    ];
    const res = optimize(input, {
      protocol: "anthropic",
      profile: "safe",
      overrides: { "normalize-whitespace": false },
    });
    expect(res.report.changed).toBe(false);
  });

  it("never edits assistant turns (thinking signatures stay intact)", () => {
    const input = anthropicConversation();
    const res = optimize(input, {
      protocol: "anthropic",
      profile: "aggressive",
    });
    const p = res.payload as Record<string, any>;
    expect(p.messages[1]).toEqual(input.messages[1]);
    expect(p.messages[3]).toEqual(input.messages[3]);
  });

  it("extreme keeps thinking budget below max_tokens", () => {
    const input = {
      ...anthropicConversation(),
      max_tokens: 32000,
      thinking: { type: "enabled", budget_tokens: 16000 },
    };
    const p = optimize(input, { protocol: "anthropic", profile: "extreme" }).payload as Record<string, any>;
    expect(p.thinking.budget_tokens).toBe(1024);
    expect(p.max_tokens).toBeGreaterThan(p.thinking.budget_tokens);
  });
});

describe("openai prompt_cache_key", () => {
  it("only applies to the official OpenAI provider", () => {
    const input = openaiAgentConversation();
    const groq = optimize(input, { protocol: "openai-chat", provider: "groq" }).payload as Record<string, unknown>;
    expect(groq.prompt_cache_key).toBeUndefined();
    const a = optimize(input, { protocol: "openai-chat", provider: "openai" }).payload as Record<string, unknown>;
    const b = optimize(input, { protocol: "openai-chat", provider: "openai" }).payload as Record<string, unknown>;
    expect(a.prompt_cache_key).toMatch(/^tsip_[0-9a-f]{32}$/);
    expect(a.prompt_cache_key).toBe(b.prompt_cache_key);
  });
});

describe("history-window", () => {
  it("keeps tool calls paired with their results", () => {
    const input = openaiAgentConversation();
    const res = optimize(input, {
      protocol: "openai-chat",
      stages: ["history-window"],
      options: { maxMessages: 5 },
    });
    const msgs = res.payload.messages as Array<Record<string, any>>;
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[2]?.role).toBe("assistant");
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i]?.role === "tool") expect(msgs[i - 1]?.role).toBe("assistant");
    }
  });
});

describe("context-budget", () => {
  it("lands close to the target ratio of the original prompt", () => {
    const input = openaiAgentConversation();
    const approx = (p: unknown) => JSON.stringify(p).length;
    for (const targetRatio of [0.1, 0.25, 0.5]) {
      const { payload, report } = optimize(input, {
        protocol: "openai-chat",
        stages: ["context-budget"],
        options: { targetRatio, minBudgetTokens: 64 },
      });
      expect(report.lossy).toBe(true);
      const ratio = approx((payload as typeof input).messages) / approx(input.messages);
      expect(ratio).toBeGreaterThan(targetRatio * 0.5);
      expect(ratio).toBeLessThan(targetRatio * 1.6);
    }
  });
});
