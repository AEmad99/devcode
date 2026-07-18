import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../providers/types.js";
import { getLimits } from "./limits.js";
import { tmpDir } from "./paths.js";
import type { Message, Usage } from "./types.js";

// Oversized tool output: write the full text to a spill file, keep head 60% + tail 40% inline.
export function spillCap(text: string, capBytes: number, dir?: string): string {
  if (text.length <= capBytes) return text;
  const head = text.slice(0, Math.floor(capBytes * 0.6));
  const tail = text.slice(text.length - Math.floor(capBytes * 0.4));
  const path = join(dir ?? tmpDir(), `spill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`);
  writeFileSync(path, text, "utf8");
  const omitted = text.length - head.length - tail.length;
  return `${head}\n[... ${omitted} bytes truncated; full output at ${path} — use read/grep to inspect ...]\n${tail}`;
}

export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") chars += b.text.length;
      else if (b.type === "tool_result") chars += b.content.length;
      else chars += JSON.stringify(b.input).length;
    }
  }
  return Math.ceil(chars / 4);
}

// Replace old large tool outputs once past the protected recent tail. Mutates messages; returns count pruned.
export function pruneToolOutputs(messages: Message[], protectTailTokens = 40000): number {
  let accumulated = 0;
  let pruned = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of messages[i].content) {
      if (b.type !== "tool_result") continue;
      const tokens = Math.ceil(b.content.length / 4);
      if (accumulated + tokens <= protectTailTokens) {
        accumulated += tokens;
      } else if (b.content.length > 500) {
        b.content = "[cleared: old tool output pruned]";
        pruned++;
      }
    }
  }
  return pruned;
}

export function contextWindow(model: string, providerId?: string): number {
  return getLimits(providerId ?? "unknown", model).contextWindow;
}

export function shouldCompact(lastUsage: Usage, model: string, providerId?: string): boolean {
  const used = lastUsage.input + lastUsage.cacheRead + lastUsage.output;
  return used > (contextWindow(model, providerId) - 20000) * 0.85;
}

const COMPACT_PROMPT =
  "Summarize this coding session for continuation. Sections: 1) What was accomplished 2) Current work in progress 3) Files involved (paths) 4) Next steps 5) Key user constraints/preferences 6) Relevant tool outputs/findings. Be terse, preserve exact paths/commands/errors.";

export async function compactMessages(
  provider: Provider,
  messages: Message[],
  model: string,
  signal: AbortSignal,
): Promise<Message[]> {
  let summary = "";
  const request: Message[] = [...messages, { role: "user", content: [{ type: "text", text: COMPACT_PROMPT }] }];
  for await (const ev of provider.stream({ system: "You are a terse summarizer.", messages: request, tools: [], maxTokens: 4096, signal })) {
    if (ev.type === "text_delta") summary += ev.text;
  }
  void model; // model lives on the provider; kept in the signature for future providers
  return [{ role: "user", content: [{ type: "text", text: `${summary}\n\nContinue where you left off.` }] }];
}
