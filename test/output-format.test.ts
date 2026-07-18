import { describe, expect, test } from "bun:test";
import { formatEventLine, formatFinalResult } from "../src/core/output-format.js";
import type { AgentEvent, Message, Usage } from "../src/core/types.js";

describe("formatEventLine", () => {
  const events: AgentEvent[] = [
    { type: "text_delta", text: "hello\nworld" },
    { type: "thinking_delta", text: "let me think…" },
    { type: "tool_start", id: "t1", name: "bash", input: { command: "ls -la" } },
    { type: "tool_end", id: "t1", name: "bash", result: { content: "ok", is_error: true } },
    { type: "turn_end", stopReason: "end_turn", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    { type: "error", error: "boom\nstack trace" },
  ];

  test("every AgentEvent variant is parseable single-line JSON that round-trips", () => {
    for (const e of events) {
      const line = formatEventLine(e);
      expect(line).not.toContain("\n");
      expect(line).not.toContain("\r");
      expect(JSON.parse(line)).toEqual(e);
    }
  });

  test("lines carry the event type for NDJSON consumers", () => {
    for (const e of events) {
      expect(JSON.parse(formatEventLine(e)).type).toBe(e.type);
    }
  });
});

describe("formatFinalResult", () => {
  test("shape: stopReason, usage, messages", () => {
    const usage: Usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const parsed = JSON.parse(formatFinalResult({ stopReason: "end_turn", usage, messages }));
    expect(parsed.stopReason).toBe("end_turn");
    expect(parsed.usage).toEqual(usage);
    expect(parsed.messages).toEqual(messages);
  });

  test("pretty-printed (multi-line) but still valid JSON", () => {
    const out = formatFinalResult({
      stopReason: "aborted",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      messages: [],
    });
    expect(out).toContain("\n");
    expect(JSON.parse(out).messages).toEqual([]);
  });
});
