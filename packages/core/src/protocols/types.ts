import type { Protocol } from "../types.js";

export type SlotRole = "system" | "user" | "tool";

/**
 * A mutable text location inside a native request payload.
 * Adapters only ever expose system, user and tool-result text — assistant
 * turns are never editable, because they may carry signed reasoning blocks
 * and because rewriting the model's own words changes its behavior.
 */
export interface TextSlot {
  role: SlotRole;
  /** Position of the owning message in the conversation; -1 for top-level system/instructions. */
  messageIndex: number;
  /** For tool results: the id of the tool call this result answers. */
  toolCallId?: string;
  /** True when the text sits inside a structured tool result. */
  isToolResult: boolean;
  get(): string;
  set(value: string): void;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface MessageInfo {
  index: number;
  role: MessageRole;
  /** A user-authored turn (not a tool result). Safe place to start a kept history window. */
  isUserTurn: boolean;
  /** The message contains one or more tool results. */
  hasToolResult: boolean;
}

export interface ProtocolAdapter {
  protocol: Protocol;
  slots(payload: Record<string, unknown>): TextSlot[];
  messages(payload: Record<string, unknown>): MessageInfo[];
  /** Keep only the conversation messages whose indices are listed. */
  keepMessages(payload: Record<string, unknown>, indices: number[]): void;
}

export type Json = Record<string, unknown>;

export function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function propSlot(target: Json, key: string, meta: Omit<TextSlot, "get" | "set">): TextSlot {
  return {
    ...meta,
    get: () => target[key] as string,
    set: (value: string) => {
      target[key] = value;
    },
  };
}
