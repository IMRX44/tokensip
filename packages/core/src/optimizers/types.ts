import type { ProtocolAdapter, TextSlot } from "../protocols/types.js";
import type { SessionRuntime } from "../session/runtime.js";
import type { Protocol, Safety, StageId, StageOptions } from "../types.js";

export interface StageContext {
  payload: Record<string, unknown>;
  adapter: ProtocolAdapter;
  protocol: Protocol;
  model?: string;
  provider?: string;
  cacheKeySalt?: string;
  options: Required<StageOptions>;
  /** Approximate prompt size (chars/4) before any stage ran. */
  originalSize: number;
  /** Token counter configured for this run. */
  count(text: string): number;
  /** Conversation-level state, when the request runs through a SessionEngine. */
  session?: SessionRuntime;
}

export interface StageResult {
  edits: number;
  tokensSaved: number;
  note?: string;
}

export interface Stage {
  id: StageId;
  safety: Safety;
  /** Protocols this stage supports; undefined means all. */
  protocols?: Protocol[];
  /** One-line human description, shown in the dashboard and docs. */
  description: string;
  run(ctx: StageContext): StageResult;
}

/** Replace a slot's text and return the token delta. */
export function rewrite(ctx: StageContext, slot: TextSlot, next: string): number {
  const prev = slot.get();
  if (prev === next) return 0;
  slot.set(next);
  return Math.max(0, ctx.count(prev) - ctx.count(next));
}

export const NOOP: StageResult = { edits: 0, tokensSaved: 0 };
