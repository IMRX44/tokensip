import { isObj, type Json, type MessageInfo, type ProtocolAdapter, propSlot, type TextSlot } from "./types.js";

export const anthropicAdapter: ProtocolAdapter = {
  protocol: "anthropic",

  slots(payload) {
    const out: TextSlot[] = [];
    if (typeof payload.system === "string") {
      out.push(
        propSlot(payload, "system", {
          role: "system",
          messageIndex: -1,
          isToolResult: false,
        }),
      );
    } else if (Array.isArray(payload.system)) {
      for (const block of payload.system) {
        if (isObj(block) && block.type === "text" && typeof block.text === "string") {
          out.push(
            propSlot(block, "text", {
              role: "system",
              messageIndex: -1,
              isToolResult: false,
            }),
          );
        }
      }
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    messages.forEach((msg, i) => {
      if (!isObj(msg) || msg.role !== "user") return;
      if (typeof msg.content === "string") {
        out.push(
          propSlot(msg, "content", {
            role: "user",
            messageIndex: i,
            isToolResult: false,
          }),
        );
        return;
      }
      if (!Array.isArray(msg.content)) return;
      for (const block of msg.content) {
        if (!isObj(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          out.push(
            propSlot(block, "text", {
              role: "user",
              messageIndex: i,
              isToolResult: false,
            }),
          );
        } else if (block.type === "tool_result") {
          const meta = {
            role: "tool" as const,
            messageIndex: i,
            isToolResult: true,
            toolCallId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
          };
          if (typeof block.content === "string") {
            out.push(propSlot(block, "content", meta));
          } else if (Array.isArray(block.content)) {
            for (const inner of block.content) {
              if (isObj(inner) && inner.type === "text" && typeof inner.text === "string") {
                out.push(propSlot(inner, "text", meta));
              }
            }
          }
        }
      }
    });
    return out;
  },

  messages(payload) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    return messages.map((msg, index): MessageInfo => {
      const m = isObj(msg) ? msg : {};
      if (m.role === "assistant")
        return {
          index,
          role: "assistant",
          isUserTurn: false,
          hasToolResult: false,
        };
      const hasToolResult =
        Array.isArray(m.content) && m.content.some((b) => isObj(b) && (b as Json).type === "tool_result");
      return {
        index,
        role: hasToolResult ? "tool" : "user",
        isUserTurn: !hasToolResult,
        hasToolResult,
      };
    });
  },

  keepMessages(payload, indices) {
    if (!Array.isArray(payload.messages)) return;
    const keep = new Set(indices);
    payload.messages = payload.messages.filter((_, i) => keep.has(i));
  },
};
