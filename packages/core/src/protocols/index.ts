import type { Protocol } from "../types.js";
import { anthropicAdapter } from "./anthropic.js";
import { geminiAdapter } from "./gemini.js";
import { openaiChatAdapter } from "./openai-chat.js";
import { openaiResponsesAdapter } from "./openai-responses.js";
import type { ProtocolAdapter } from "./types.js";

const ADAPTERS: Record<Protocol, ProtocolAdapter> = {
  "openai-chat": openaiChatAdapter,
  "openai-responses": openaiResponsesAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
};

export function adapterFor(protocol: Protocol): ProtocolAdapter {
  return ADAPTERS[protocol];
}

/** Infer the protocol from a request path. Returns undefined for endpoints TokenSip only passes through. */
export function protocolFromPath(path: string): Protocol | undefined {
  const p = path.split("?")[0] ?? "";
  if (/\/chat\/completions\/?$/.test(p)) return "openai-chat";
  if (/\/responses\/?$/.test(p)) return "openai-responses";
  if (/\/messages\/?$/.test(p)) return "anthropic";
  if (/:(stream)?generateContent$/i.test(p)) return "gemini";
  return undefined;
}

export type { MessageInfo, ProtocolAdapter, TextSlot } from "./types.js";
