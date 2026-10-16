import type { Protocol, ProviderPreset, Surface } from "./types.js";

const oa = (baseUrl: string, auth: "bearer" | "api-key" | "none" = "bearer") => ({ openai: { baseUrl, auth } });

/**
 * Built-in provider catalog. Most providers speak the OpenAI wire format, so
 * one adapter covers them; Anthropic and Gemini are also reachable natively.
 * Anything not listed works through the `custom` preset.
 */
export const PROVIDERS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    surfaces: oa("https://api.openai.com/v1"),
    modelPatterns: [
      "^gpt-",
      "^o\\d",
      "^chatgpt-",
      "^codex-",
      "^text-embedding-3",
      "^text-embedding-ada",
      "^omni-moderation",
      "^computer-use",
    ],
    streamUsage: true,
    autoPrefixCache: true,
    docsUrl: "https://platform.openai.com/docs",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    surfaces: {
      anthropic: { baseUrl: "https://api.anthropic.com", auth: "x-api-key" },
      openai: { baseUrl: "https://api.anthropic.com/v1", auth: "bearer" },
    },
    modelPatterns: ["^claude-"],
    docsUrl: "https://docs.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "google",
    name: "Google Gemini",
    surfaces: {
      gemini: {
        baseUrl: "https://generativelanguage.googleapis.com",
        auth: "x-goog-api-key",
      },
      openai: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        auth: "bearer",
      },
    },
    modelPatterns: ["^gemini-", "^gemma-", "^models/gemini-"],
    autoPrefixCache: true,
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    surfaces: oa("", "api-key"),
    requiresBaseUrl: true,
    autoPrefixCache: true,
    docsUrl: "https://learn.microsoft.com/azure/ai-services/openai/",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    surfaces: {
      openai: { baseUrl: "https://api.deepseek.com/v1", auth: "bearer" },
      anthropic: {
        baseUrl: "https://api.deepseek.com/anthropic",
        auth: "x-api-key",
      },
    },
    modelPatterns: ["^deepseek-"],
    streamUsage: true,
    autoPrefixCache: true,
    docsUrl: "https://api-docs.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    surfaces: oa("https://api.mistral.ai/v1"),
    modelPatterns: ["^mistral-", "^codestral", "^ministral-", "^pixtral-", "^magistral-", "^devstral-", "^open-mi"],
    docsUrl: "https://docs.mistral.ai",
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "xai",
    name: "xAI Grok",
    surfaces: oa("https://api.x.ai/v1"),
    modelPatterns: ["^grok-"],
    autoPrefixCache: true,
    docsUrl: "https://docs.x.ai",
    keyUrl: "https://console.x.ai",
  },
  {
    id: "groq",
    name: "Groq",
    surfaces: oa("https://api.groq.com/openai/v1"),
    docsUrl: "https://console.groq.com/docs",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    surfaces: oa("https://openrouter.ai/api/v1"),
    docsUrl: "https://openrouter.ai/docs",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "together",
    name: "Together AI",
    surfaces: oa("https://api.together.xyz/v1"),
    docsUrl: "https://docs.together.ai",
    keyUrl: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    surfaces: oa("https://api.fireworks.ai/inference/v1"),
    docsUrl: "https://docs.fireworks.ai",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    surfaces: oa("https://api.cerebras.ai/v1"),
    docsUrl: "https://inference-docs.cerebras.ai",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    surfaces: oa("https://api.perplexity.ai"),
    modelPatterns: ["^sonar"],
    docsUrl: "https://docs.perplexity.ai",
  },
  {
    id: "cohere",
    name: "Cohere",
    surfaces: oa("https://api.cohere.ai/compatibility/v1"),
    modelPatterns: ["^command-"],
    docsUrl: "https://docs.cohere.com",
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    surfaces: {
      openai: { baseUrl: "https://api.moonshot.ai/v1", auth: "bearer" },
      anthropic: {
        baseUrl: "https://api.moonshot.ai/anthropic",
        auth: "x-api-key",
      },
    },
    modelPatterns: ["^kimi-", "^moonshot-"],
    autoPrefixCache: true,
    docsUrl: "https://platform.moonshot.ai/docs",
  },
  {
    id: "zai",
    name: "Z.ai GLM",
    surfaces: {
      openai: { baseUrl: "https://api.z.ai/api/paas/v4", auth: "bearer" },
      anthropic: {
        baseUrl: "https://api.z.ai/api/anthropic",
        auth: "x-api-key",
      },
    },
    modelPatterns: ["^glm-"],
    docsUrl: "https://docs.z.ai",
  },
  {
    id: "qwen",
    name: "Alibaba Qwen",
    surfaces: oa("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
    modelPatterns: ["^qwen", "^qwq-"],
    docsUrl: "https://www.alibabacloud.com/help/en/model-studio",
  },
  {
    id: "ollama",
    name: "Ollama",
    surfaces: oa("http://127.0.0.1:11434/v1", "none"),
    local: true,
    docsUrl: "https://ollama.com",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    surfaces: oa("http://127.0.0.1:1234/v1", "none"),
    local: true,
    docsUrl: "https://lmstudio.ai",
  },
  {
    id: "vllm",
    name: "vLLM",
    surfaces: oa("http://127.0.0.1:8000/v1", "none"),
    local: true,
    docsUrl: "https://docs.vllm.ai",
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    surfaces: oa("", "bearer"),
    requiresBaseUrl: true,
  },
];

export const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function surfaceForProtocol(protocol: Protocol): Surface {
  if (protocol === "anthropic") return "anthropic";
  if (protocol === "gemini") return "gemini";
  return "openai";
}

/** Find the first provider (from a candidate list) whose model patterns match. */
export function matchProviderByModel<T extends Pick<ProviderPreset, "id" | "modelPatterns">>(
  model: string | undefined,
  candidates: T[],
): T | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  return candidates.find((p) => (p.modelPatterns ?? []).some((re) => new RegExp(re).test(m)));
}
