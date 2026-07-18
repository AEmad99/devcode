import type { AgentEvent, Message, StopReason, Usage } from "./types.js";

/**
 * One AgentEvent as single-line JSON (NDJSON), for `-p --output-format stream-json`.
 * JSON.stringify escapes control chars, so the output never contains a raw newline.
 */
export function formatEventLine(e: AgentEvent): string {
  return JSON.stringify(e);
}

/** Pretty-printed final result, for `-p --output-format json`. */
export function formatFinalResult(r: { stopReason: StopReason; usage: Usage; messages: Message[] }): string {
  return JSON.stringify(r, null, 2);
}
