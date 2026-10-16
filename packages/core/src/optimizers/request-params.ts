import { isObj } from "../protocols/types.js";
import type { Stage } from "./types.js";

/** OpenAI image inputs: request `detail: "low"` (a fixed ~85 tokens per image instead of up to thousands). */
export const imageDetailLow: Stage = {
  id: "image-detail-low",
  safety: "lossy",
  protocols: ["openai-chat", "openai-responses"],
  description:
    "Requests low-detail image processing (~85 tokens per image). Fine print in images may become unreadable.",
  run(ctx) {
    let edits = 0;
    const visit = (part: unknown) => {
      if (!isObj(part)) return;
      if (part.type === "image_url" && isObj(part.image_url) && part.image_url.detail !== "low") {
        part.image_url.detail = "low";
        edits++;
      } else if (part.type === "input_image" && part.detail !== "low") {
        part.detail = "low";
        edits++;
      }
    };
    const list = (ctx.payload.messages ?? ctx.payload.input) as unknown;
    if (Array.isArray(list)) {
      for (const msg of list) if (isObj(msg) && Array.isArray(msg.content)) msg.content.forEach(visit);
    }
    return {
      edits,
      tokensSaved: 0,
      note: edits ? `${edits} image(s) set to low detail` : undefined,
    };
  },
};

const EFFORT_RANK = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
} as Record<string, number>;

/**
 * Lowers reasoning effort / thinking budgets. Reasoning tokens are billed as
 * output — often the most expensive part of a request — but less thinking
 * means weaker answers on hard problems.
 */
export const reduceReasoning: Stage = {
  id: "reduce-reasoning",
  safety: "lossy",
  description: "Lowers reasoning effort and caps thinking budgets. Hard problems will get weaker answers.",
  run(ctx) {
    const p = ctx.payload;
    const effort = ctx.options.reasoningEffort;
    const cap = ctx.options.maxThinkingTokens;
    let edits = 0;
    const lower = (current: unknown) =>
      typeof current === "string" && (EFFORT_RANK[current] ?? 0) > (EFFORT_RANK[effort] ?? 1);

    if (ctx.protocol === "openai-chat" && lower(p.reasoning_effort)) {
      p.reasoning_effort = effort;
      edits++;
    }
    if (ctx.protocol === "openai-responses" && isObj(p.reasoning) && lower(p.reasoning.effort)) {
      p.reasoning.effort = effort;
      edits++;
    }
    if (ctx.protocol === "anthropic" && isObj(p.thinking) && p.thinking.type === "enabled") {
      const budget = p.thinking.budget_tokens;
      if (typeof budget === "number" && budget > cap) {
        p.thinking.budget_tokens = Math.max(1024, cap);
        edits++;
      }
    }
    if (ctx.protocol === "gemini") {
      const gc = p.generationConfig;
      if (isObj(gc) && isObj(gc.thinkingConfig)) {
        const budget = gc.thinkingConfig.thinkingBudget;
        if (typeof budget !== "number" || budget < 0 || budget > cap) {
          gc.thinkingConfig.thinkingBudget = cap;
          edits++;
        }
      }
    }
    return {
      edits,
      tokensSaved: 0,
      note: edits ? "reasoning reduced" : undefined,
    };
  },
};

/** Caps the maximum output tokens a request may ask for. Long answers will be cut off. */
export const capOutput: Stage = {
  id: "cap-output",
  safety: "lossy",
  description: "Caps max output tokens. Long answers or large code edits may be cut off.",
  run(ctx) {
    const p = ctx.payload;
    const cap = ctx.options.maxOutputTokens;
    let edits = 0;
    const clamp = (obj: Record<string, unknown>, key: string, setIfMissing: boolean) => {
      const v = obj[key];
      if (typeof v === "number" ? v > cap : setIfMissing) {
        obj[key] = cap;
        edits++;
      }
    };
    if (ctx.protocol === "openai-chat") {
      if ("max_tokens" in p) clamp(p, "max_tokens", false);
      else clamp(p, "max_completion_tokens", true);
    } else if (ctx.protocol === "openai-responses") {
      clamp(p, "max_output_tokens", true);
    } else if (ctx.protocol === "anthropic") {
      // Anthropic requires budget_tokens < max_tokens when thinking is enabled.
      const thinking = isObj(p.thinking) && typeof p.thinking.budget_tokens === "number" ? p.thinking.budget_tokens : 0;
      const v = p.max_tokens;
      const target = Math.max(cap, thinking + 256);
      if (typeof v === "number" && v > target) {
        p.max_tokens = target;
        edits++;
      }
    } else if (ctx.protocol === "gemini") {
      const gc = isObj(p.generationConfig) ? p.generationConfig : {};
      p.generationConfig = gc;
      clamp(gc, "maxOutputTokens", true);
    }
    return {
      edits,
      tokensSaved: 0,
      note: edits ? `output capped at ${cap} tokens` : undefined,
    };
  },
};
