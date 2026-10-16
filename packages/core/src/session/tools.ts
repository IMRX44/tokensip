import { isObj, type Json } from "../protocols/types.js";
import type { Protocol } from "../types.js";

/** A tool call made by the model (assistant turn). Read-only view. */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments when they were JSON, otherwise the raw string. */
  args: unknown;
  messageIndex: number;
}

/** A tool result sent back by the client. Can be rewritten in place. */
export interface ToolResult {
  callId: string;
  messageIndex: number;
  isError: boolean;
  /** Text content of the result (images and other parts are ignored). */
  text(): string;
  /** Replace the whole result with plain text, keeping the call/result pairing intact. */
  replace(text: string): void;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function joinText(content: unknown, textType: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is Json => isObj(p) && p.type === textType && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

function list(payload: Json, key: string): Json[] {
  const v = payload[key];
  return Array.isArray(v) ? (v as Json[]) : [];
}

export function toolCalls(protocol: Protocol, payload: Json): ToolCall[] {
  const out: ToolCall[] = [];
  if (protocol === "openai-chat") {
    list(payload, "messages").forEach((m, i) => {
      if (!isObj(m) || m.role !== "assistant" || !Array.isArray(m.tool_calls)) return;
      for (const c of m.tool_calls) {
        if (isObj(c) && typeof c.id === "string" && isObj(c.function) && typeof c.function.name === "string") {
          out.push({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments), messageIndex: i });
        }
      }
    });
  } else if (protocol === "anthropic") {
    list(payload, "messages").forEach((m, i) => {
      if (!isObj(m) || m.role !== "assistant" || !Array.isArray(m.content)) return;
      for (const b of m.content) {
        if (isObj(b) && b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          out.push({ id: b.id, name: b.name, args: b.input, messageIndex: i });
        }
      }
    });
  } else if (protocol === "openai-responses") {
    list(payload, "input").forEach((item, i) => {
      if (!isObj(item) || typeof item.call_id !== "string") return;
      if (item.type === "function_call" && typeof item.name === "string") {
        out.push({ id: item.call_id, name: item.name, args: parseArgs(item.arguments), messageIndex: i });
      } else if (item.type === "custom_tool_call" && typeof item.name === "string") {
        out.push({ id: item.call_id, name: item.name, args: item.input, messageIndex: i });
      } else if (item.type === "local_shell_call" && isObj(item.action)) {
        out.push({
          id: item.call_id,
          name: "local_shell",
          args: { command: item.action.command, workdir: item.action.working_directory },
          messageIndex: i,
        });
      }
    });
  }
  return out;
}

const looksLikeError = (text: string) =>
  text.length < 400 && /^\s*(error|exception|traceback|fatal|failed)\b/i.test(text);

export function toolResults(protocol: Protocol, payload: Json): ToolResult[] {
  const out: ToolResult[] = [];
  if (protocol === "openai-chat") {
    list(payload, "messages").forEach((m, i) => {
      if (!isObj(m) || m.role !== "tool" || typeof m.tool_call_id !== "string") return;
      const text = () => joinText(m.content, "text");
      out.push({
        callId: m.tool_call_id,
        messageIndex: i,
        isError: looksLikeError(text()),
        text,
        replace: (t) => {
          m.content = t;
        },
      });
    });
  } else if (protocol === "anthropic") {
    list(payload, "messages").forEach((m, i) => {
      if (!isObj(m) || m.role !== "user" || !Array.isArray(m.content)) return;
      for (const b of m.content) {
        if (!isObj(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const text = () => joinText(b.content, "text");
        out.push({
          callId: b.tool_use_id,
          messageIndex: i,
          isError: b.is_error === true || looksLikeError(text()),
          text,
          replace: (t) => {
            b.content = t;
          },
        });
      }
    });
  } else if (protocol === "openai-responses") {
    list(payload, "input").forEach((item, i) => {
      if (!isObj(item) || typeof item.call_id !== "string") return;
      if (!["function_call_output", "custom_tool_call_output", "local_shell_call_output"].includes(item.type as string))
        return;
      const text = () => joinText(item.output, "input_text");
      out.push({
        callId: item.call_id,
        messageIndex: i,
        isError: looksLikeError(text()),
        text,
        replace: (t) => {
          item.output = t;
        },
      });
    });
  }
  return out;
}
