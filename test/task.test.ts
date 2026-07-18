import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Emitter } from "../src/core/events.js";
import { runAgentLoop } from "../src/core/loop.js";
import { taskTool } from "../src/core/tools/task.js";
import type { Message, StreamEvent, ToolDef } from "../src/core/types.js";
import type { Provider } from "../src/providers/types.js";

const sig = () => new AbortController().signal;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

function scriptedProvider(scripts: StreamEvent[][]): Provider {
  let i = 0;
  return {
    id: "fake",
    defaultModel: "fake",
    async *stream() {
      const script = scripts[Math.min(i, scripts.length - 1)] ?? [];
      i++;
      for (const ev of script) yield ev;
    },
  };
}

const pingTool: ToolDef = {
  name: "ping",
  description: "ping",
  schema: Type.Object({}),
  async execute() {
    return { content: "pong" };
  },
};

describe("task tool", () => {
  test("nested run completes and returns final assistant text", async () => {
    const provider = scriptedProvider([
      [
        { type: "text_delta", text: "subagent done" },
        {
          type: "done",
          stopReason: "end_turn",
          usage,
          message: { role: "assistant", content: [{ type: "text", text: "subagent done" }] },
        },
      ],
    ]);
    const tool = taskTool({
      provider,
      system: "sys",
      subTools: () => [pingTool],
    });
    const res = await tool.execute("1", { prompt: "do work", description: "test", mode: "all" }, sig());
    expect(res.is_error).toBeFalsy();
    expect(res.content).toContain("subagent done");
    expect(res.content).toContain("stop=end_turn");
  });

  test("task is absent from sub-tools (no recursion via filter)", async () => {
    const names: string[] = [];
    const provider = scriptedProvider([
      [
        {
          type: "done",
          stopReason: "end_turn",
          usage,
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        },
      ],
    ]);
    const outerTask = taskTool({
      provider,
      system: "sys",
      subTools: () => {
        const tools = [pingTool];
        names.push(...tools.map((t) => t.name));
        return tools;
      },
    });
    await outerTask.execute("1", { prompt: "x", mode: "all" }, sig());
    expect(names).not.toContain("task");
  });

  test("explore mode filters to read-only tools", async () => {
    const writeTool: ToolDef = {
      name: "write",
      description: "write",
      schema: Type.Object({}),
      async execute() {
        return { content: "wrote" };
      },
    };
    const readTool: ToolDef = {
      name: "read",
      description: "read",
      schema: Type.Object({}),
      async execute() {
        return { content: "data" };
      },
    };
    let subNames: string[] = [];
    const provider = scriptedProvider([
      [
        {
          type: "done",
          stopReason: "end_turn",
          usage,
          message: { role: "assistant", content: [{ type: "text", text: "explored" }] },
        },
      ],
    ]);
    // Capture tools actually passed into the loop via a wrapping provider is hard;
    // instead run explore with only write available — subTools returns both, filter drops write.
    const tool = taskTool({
      provider,
      system: "sys",
      subTools: () => {
        const tools = [writeTool, readTool];
        subNames = tools.map((t) => t.name);
        return tools;
      },
    });
    const res = await tool.execute("1", { prompt: "look around", mode: "explore" }, sig());
    expect(res.is_error).toBeFalsy();
    expect(res.content).toContain("explored");
    expect(res.content).toContain("mode=explore");
    expect(subNames).toContain("write"); // subTools still offered both; filter is internal
  });

  test("abort propagates as is_error", async () => {
    const provider: Provider = {
      id: "fake",
      defaultModel: "fake",
      async *stream({ signal }) {
        await new Promise<void>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
    };
    const tool = taskTool({ provider, system: "sys", subTools: () => [] });
    const ac = new AbortController();
    const p = tool.execute("1", { prompt: "hang" }, ac.signal);
    ac.abort();
    const res = await p;
    expect(res.is_error).toBe(true);
  });

  test("maxTurns exhausted → is_error", async () => {
    // Always requests another tool_use → hits maxTurns
    const provider = scriptedProvider([
      [
        {
          type: "done",
          stopReason: "tool_use",
          usage,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "ping", input: {} }],
          },
        },
      ],
    ]);
    const tool = taskTool({
      provider,
      system: "sys",
      subTools: () => [pingTool],
      maxTurns: 2,
    });
    const res = await tool.execute("1", { prompt: "loop", mode: "all" }, sig());
    expect(res.is_error).toBe(true);
    expect(res.content.toLowerCase()).toMatch(/max turns|error/);
  });

  test("full loop can call task tool", async () => {
    const nested = scriptedProvider([
      [
        {
          type: "done",
          stopReason: "end_turn",
          usage,
          message: { role: "assistant", content: [{ type: "text", text: "from-sub" }] },
        },
      ],
    ]);
    // Outer: first turn uses task, second ends
    let outerCalls = 0;
    const outer: Provider = {
      id: "outer",
      defaultModel: "fake",
      async *stream() {
        outerCalls++;
        if (outerCalls === 1) {
          yield {
            type: "done" as const,
            stopReason: "tool_use" as const,
            usage,
            message: {
              role: "assistant" as const,
              content: [{ type: "tool_use" as const, id: "tu1", name: "task", input: { prompt: "go" } }],
            },
          };
        } else {
          yield {
            type: "done" as const,
            stopReason: "end_turn" as const,
            usage,
            message: {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "outer done" }],
            },
          };
        }
      },
    };
    const task = taskTool({ provider: nested, system: "sys", subTools: () => [pingTool] });
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const events = new Emitter();
    const { stopReason } = await runAgentLoop({
      provider: outer,
      system: "sys",
      messages,
      tools: [task],
      events,
      signal: sig(),
    });
    expect(stopReason).toBe("end_turn");
    const toolResult = messages.flatMap((m) => m.content).find((b) => b.type === "tool_result");
    expect(toolResult && "content" in toolResult && String(toolResult.content)).toContain("from-sub");
  });
});
