import { canonicalJson, sha256 } from "../json.js";
import type { Stage } from "./types.js";
import { NOOP } from "./types.js";

/**
 * OpenAI routes requests with the same `prompt_cache_key` to the same cache
 * shard, which noticeably raises automatic prefix-cache hit rates for apps
 * that share a long system prompt / tool list. The key is derived from the
 * stable prefix (model + tools + system text) so it never changes mid-session.
 */
export const openaiPromptCacheKey: Stage = {
  id: "openai-prompt-cache-key",
  safety: "lossless",
  protocols: ["openai-chat", "openai-responses"],
  description: "Sets a stable prompt_cache_key on OpenAI requests so shared prefixes hit the same cache shard.",
  run(ctx) {
    if (ctx.provider !== "openai") return { ...NOOP, note: "only applies to api.openai.com" };
    if (ctx.payload.prompt_cache_key !== undefined) return { ...NOOP, note: "client set prompt_cache_key" };
    const system = ctx.adapter
      .slots(ctx.payload)
      .filter((s) => s.role === "system")
      .map((s) => s.get())
      .join("\n");
    const tools = ctx.payload.tools ?? null;
    if (!system && !tools) return { ...NOOP, note: "no shared prefix to key on" };
    const key = sha256(
      canonicalJson({
        m: ctx.model ?? ctx.payload.model,
        s: system,
        t: tools,
        k: ctx.cacheKeySalt ?? "",
      }),
    );
    ctx.payload.prompt_cache_key = `tsip_${key.slice(0, 32)}`;
    return { edits: 1, tokensSaved: 0, note: "prompt_cache_key set" };
  },
};
