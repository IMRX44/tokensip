import type { Json } from "../protocols/types.js";
import type { Protocol } from "../types.js";
import { type Resource, resourceOf } from "./resources.js";
import { type ToolResult, toolCalls, toolResults } from "./tools.js";

export interface Observation {
  callId: string;
  name: string;
  resource: Resource;
  messageIndex: number;
  result: ToolResult;
}

/** Tool results paired with the call that produced them, for calls that observe a resource. */
export function observations(protocol: Protocol, payload: Json): Observation[] {
  const calls = new Map(toolCalls(protocol, payload).map((c) => [c.id, c]));
  const out: Observation[] = [];
  for (const result of toolResults(protocol, payload)) {
    const call = calls.get(result.callId);
    if (!call) continue;
    const resource = resourceOf(call.name, call.args);
    if (resource) out.push({ callId: call.id, name: call.name, resource, messageIndex: result.messageIndex, result });
  }
  return out.sort((a, b) => a.messageIndex - b.messageIndex);
}

function supersedes(newer: Observation, older: Observation): boolean {
  if (newer.result.isError) return false; // an error never replaces real content
  if (newer.resource.key === older.resource.key) return true;
  // A full read of a file makes every earlier read of that file (full or partial) outdated.
  return (
    newer.resource.kind === "file" &&
    older.resource.kind === "file" &&
    !newer.resource.partial &&
    newer.resource.fileKey !== undefined &&
    newer.resource.fileKey === older.resource.fileKey
  );
}

/**
 * Observations made outdated by a later observation of the same resource
 * (a file read again after edits, a test suite re-run, a repeated search).
 * Byte-identical repeats are left to `dedupe-tool-results`, which keeps the
 * *earliest* copy and is therefore cache-friendlier.
 *
 * Returns older call id → the newer observation that supersedes it.
 */
export function supersededMap(obs: Observation[], minChars: number): Map<string, Observation> {
  const out = new Map<string, Observation>();
  for (let i = 0; i < obs.length; i++) {
    const older = obs[i] as Observation;
    const text = older.result.text();
    if (text.length < minChars) continue;
    for (let j = i + 1; j < obs.length; j++) {
      const newer = obs[j] as Observation;
      if (newer.messageIndex <= older.messageIndex) continue;
      if (!supersedes(newer, older)) continue;
      if (newer.result.text() === text) break; // identical: dedupe's job
      out.set(older.callId, newer);
      break;
    }
  }
  return out;
}

export function tombstone(older: Observation, newer: Observation, tokens: number): string {
  const what = older.resource.kind === "file" ? "file" : older.resource.kind === "command" ? "command" : "query";
  return `[TokenSip · superseded] This earlier ${older.name} result for ${older.resource.label} is outdated: the same ${what} was observed again later (call ${newer.callId}), and that newer result shows the current state. ~${tokens} tokens removed.`;
}
