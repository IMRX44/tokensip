import { isObj, type Json, type MessageInfo, type ProtocolAdapter, propSlot, type TextSlot } from "./types.js";

const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);

function itemRole(item: Json): MessageInfo["role"] {
  const type = item.type;
  if (typeof type === "string" && TOOL_OUTPUT_TYPES.has(type)) return "tool";
  if (type === undefined || type === "message") {
    if (item.role === "system" || item.role === "developer") return "system";
    if (item.role === "assistant") return "assistant";
    return "user";
  }
  // function_call, reasoning, web_search_call, ... are model-produced items
  return "assistant";
}

export const openaiResponsesAdapter: ProtocolAdapter = {
  protocol: "openai-responses",

  slots(payload) {
    const out: TextSlot[] = [];
    if (typeof payload.instructions === "string") {
      out.push(
        propSlot(payload, "instructions", {
          role: "system",
          messageIndex: -1,
          isToolResult: false,
        }),
      );
    }
    if (typeof payload.input === "string") {
      out.push(
        propSlot(payload, "input", {
          role: "user",
          messageIndex: 0,
          isToolResult: false,
        }),
      );
      return out;
    }
    const items = Array.isArray(payload.input) ? payload.input : [];
    items.forEach((item, i) => {
      if (!isObj(item)) return;
      const role = itemRole(item);
      if (role === "assistant") return;
      if (role === "tool") {
        const meta = {
          role: "tool" as const,
          messageIndex: i,
          isToolResult: true,
          toolCallId: typeof item.call_id === "string" ? item.call_id : undefined,
        };
        if (typeof item.output === "string") out.push(propSlot(item, "output", meta));
        else if (Array.isArray(item.output)) {
          for (const part of item.output) {
            if (isObj(part) && part.type === "input_text" && typeof part.text === "string") {
              out.push(propSlot(part, "text", meta));
            }
          }
        }
        return;
      }
      const meta = { role, messageIndex: i, isToolResult: false } as const;
      if (typeof item.content === "string") out.push(propSlot(item, "content", meta));
      else if (Array.isArray(item.content)) {
        for (const part of item.content) {
          if (isObj(part) && part.type === "input_text" && typeof part.text === "string") {
            out.push(propSlot(part, "text", meta));
          }
        }
      }
    });
    return out;
  },

  messages(payload) {
    if (!Array.isArray(payload.input)) return [];
    return payload.input.map((item, index): MessageInfo => {
      const role = itemRole(isObj(item) ? item : {});
      return {
        index,
        role,
        isUserTurn: role === "user",
        hasToolResult: role === "tool",
      };
    });
  },

  keepMessages(payload, indices) {
    if (!Array.isArray(payload.input)) return;
    const keep = new Set(indices);
    payload.input = payload.input.filter((_, i) => keep.has(i));
  },
};
