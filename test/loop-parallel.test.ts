import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Emitter } from "../src/core/events.js";
import { runAgentLoop } from "../src/core/loop.js";
import type { Message, StreamEvent, ToolDef, Usage } from "../src/core/types.js";
import type { Provider } from "../src/providers/types.js";

const USAGE: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const sig = () => new AbortController().signal;
const userMsg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });

function scripted(scripts: StreamEvent[][]): Provider {
  let i = 0;
  return {
    id: "fake",
    defaultModel: "fake",
    async *stream() {
      const s = scripts[i++] ?? [];
      for (const ev of s) yield ev;
    },
  };
}

describe("parallel read-only tools", () => {
  test("runs concurrent reads in one turn", async () => {
    const starts: number[] = [];
    const ends: string[] = [];
    const gate = { n: 0, resolve: null as null | (() => void) };
    const waitBoth = new Promise<void>((r) => {
      gate.resolve = r;
    });

    const makeRead = (name: string): ToolDef => ({
      name: "read",
      description: "read",
      schema: Type.Object({ path: Type.String() }),
      async execute(_id, input) {
        starts.push(Date.now());
        gate.n++;
        if (gate.n === 2) gate.resolve?.();
        await waitBoth;
        await new Promise((r) => setTimeout(r, 20));
        ends.push(String((input as { path: string }).path));
        return { content: `ok:${(input as { path: string }).path}` };
      },
    });

    // Two separate tool defs with same name — loop finds by name, so use one tool
    // that handles both. Parallelism is Promise.all on two tool_use with name read.
    const readTool: ToolDef = {
      name: "read",
      description: "read",
      schema: Type.Object({ path: Type.String() }),
      async execute(_id, input) {
        starts.push(Date.now());
        gate.n++;
        if (gate.n === 2) gate.resolve?.();
        // Wait until both have started (proves overlap)
        await waitBoth;
        await new Promise((r) => setTimeout(r, 5));
        return { content: `ok:${(input as { path: string }).path}` };
      },
    };
    void makeRead;

    const provider = scripted([
      [
        {
          type: "done",
          stopReason: "tool_use",
          usage: USAGE,
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "a", name: "read", input: { path: "a.ts" } },
              { type: "tool_use", id: "b", name: "read", input: { path: "b.ts" } },
            ],
          },
        },
      ],
      [
        {
          type: "done",
          stopReason: "end_turn",
          usage: USAGE,
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        },
      ],
    ]);

    const events = new Emitter();
    const toolStarts: string[] = [];
    events.on("tool_start", (e) => toolStarts.push(e.id));

    const messages = [userMsg("read both")];
    const { stopReason } = await runAgentLoop({
      provider,
      system: "s",
      messages,
      tools: [readTool],
      events,
      signal: sig(),
    });
    expect(stopReason).toBe("end_turn");
    expect(toolStarts).toEqual(["a", "b"]);
    // Both started before either finished (gate opens at 2 starts)
    expect(gate.n).toBe(2);
    const results = messages.find((m) => m.role === "user" && m.content.some((c) => c.type === "tool_result"));
    expect(results).toBeTruthy();
  });

  test("forwards tool_use_start and tool_delta stream events", async () => {
    const provider: Provider = {
      id: "fake",
      defaultModel: "fake",
      async *stream() {
        yield { type: "tool_use_start", id: "t1", name: "read" };
        yield { type: "tool_use_delta", id: "t1", partialJson: '{"path":' };
        yield { type: "tool_use_delta", id: "t1", partialJson: '"x"}' };
        yield {
          type: "done",
          stopReason: "end_turn",
          usage: USAGE,
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
        };
      },
    };
    const events = new Emitter();
    const starts: string[] = [];
    const deltas: string[] = [];
    events.on("tool_use_start", (e) => starts.push(e.name));
    events.on("tool_delta", (e) => deltas.push(e.partialJson));
    await runAgentLoop({
      provider,
      system: "s",
      messages: [userMsg("x")],
      tools: [],
      events,
      signal: sig(),
    });
    expect(starts).toEqual(["read"]);
    expect(deltas.join("")).toBe('{"path":"x"}');
  });
});
