import { isObj, type Json, type MessageInfo, type ProtocolAdapter, propSlot, type TextSlot } from "./types.js";

function textParts(owner: Json, key: string, meta: Omit<TextSlot, "get" | "set">, out: TextSlot[]): void {
  const content = owner[key];
  if (typeof content === "string") {
    out.push(propSlot(owner, key, meta));
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (isObj(part) && part.type === "text" && typeof part.text === "string") {
        out.push(propSlot(part, "text", meta));
      }
    }
  }
}

function roleOf(raw: unknown): MessageInfo["role"] {
  if (raw === "system" || raw === "developer") return "system";
  if (raw === "tool" || raw === "function") return "tool";
  if (raw === "assistant") return "assistant";
  return "user";
}

export const openaiChatAdapter: ProtocolAdapter = {
  protocol: "openai-chat",

  slots(payload) {
    const out: TextSlot[] = [];
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    messages.forEach((msg, i) => {
      if (!isObj(msg)) return;
      const role = roleOf(msg.role);
      if (role === "assistant") return;
      if (role === "tool") {
        const toolCallId = typeof msg.tool_call_id === "string" ? msg.tool_call_id : undefined;
        textParts(msg, "content", { role: "tool", messageIndex: i, toolCallId, isToolResult: true }, out);
      } else {
        textParts(msg, "content", { role, messageIndex: i, isToolResult: false }, out);
      }
    });
    return out;
  },

  messages(payload) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    return messages.map((msg, index) => {
      const role = roleOf(isObj(msg) ? msg.role : undefined);
      return {
        index,
        role,
        isUserTurn: role === "user",
        hasToolResult: role === "tool",
      };
    });
  },

  keepMessages(payload, indices) {
    if (!Array.isArray(payload.messages)) return;
    const keep = new Set(indices);
    payload.messages = payload.messages.filter((_, i) => keep.has(i));
  },
};
