import { isObj, type Json, type MessageInfo, type ProtocolAdapter, propSlot, type TextSlot } from "./types.js";

function systemOf(payload: Json): Json | undefined {
  const sys = payload.systemInstruction ?? payload.system_instruction;
  return isObj(sys) ? sys : undefined;
}

export const geminiAdapter: ProtocolAdapter = {
  protocol: "gemini",

  slots(payload) {
    const out: TextSlot[] = [];
    const sys = systemOf(payload);
    if (sys && Array.isArray(sys.parts)) {
      for (const part of sys.parts) {
        if (isObj(part) && typeof part.text === "string") {
          out.push(
            propSlot(part, "text", {
              role: "system",
              messageIndex: -1,
              isToolResult: false,
            }),
          );
        }
      }
    }
    const contents = Array.isArray(payload.contents) ? payload.contents : [];
    contents.forEach((content, i) => {
      if (!isObj(content) || content.role === "model") return;
      if (!Array.isArray(content.parts)) return;
      for (const part of content.parts) {
        // Only plain text parts. Thought parts carry signatures; functionResponse is structured data.
        if (isObj(part) && typeof part.text === "string" && part.thought !== true && !part.thoughtSignature) {
          out.push(
            propSlot(part, "text", {
              role: "user",
              messageIndex: i,
              isToolResult: false,
            }),
          );
        }
      }
    });
    return out;
  },

  messages(payload) {
    const contents = Array.isArray(payload.contents) ? payload.contents : [];
    return contents.map((content, index): MessageInfo => {
      const c = isObj(content) ? content : {};
      if (c.role === "model")
        return {
          index,
          role: "assistant",
          isUserTurn: false,
          hasToolResult: false,
        };
      const parts = Array.isArray(c.parts) ? c.parts : [];
      const hasToolResult = parts.some((p) => isObj(p) && ("functionResponse" in p || "function_response" in p));
      return {
        index,
        role: hasToolResult ? "tool" : "user",
        isUserTurn: !hasToolResult,
        hasToolResult,
      };
    });
  },

  keepMessages(payload, indices) {
    if (!Array.isArray(payload.contents)) return;
    const keep = new Set(indices);
    payload.contents = payload.contents.filter((_, i) => keep.has(i));
  },
};
