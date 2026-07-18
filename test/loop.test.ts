import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Emitter } from "../src/core/events.js";
import { runAgentLoop } from "../src/core/loop.js";
import type { Message, StopReason, StreamEvent, ToolDef, Usage } from "../src/core/types.js";
import type { Provider, StreamParams } from "../src/providers/types.js";

const USAGE: Usage = { input: 3, output: 5, cacheRead: 0, cacheWrite: 0 };
type Done = Extract<StreamEvent, { type: "done" }>;

function textDone(text: string, stopReason: StopReason = "end_turn"): Done {
  return { type: "done", message: { role: "assistant", content: [{ type: "text", text }] }, stopReason, usage: USAGE };
}

function toolUseDone(calls: { id: string; name: string; input: unknown }[]): Done {
  return {
    type: "done",
    message: {
      role: "assistant",
      content: calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
    },
    stopReason: "tool_use",
    usage: USAGE,
  };
}

class FakeProvider implements Provider {
  id = "fake";
  defaultModel = "fake-model";
  scripts: StreamEvent[][] = [];
  calls: StreamParams[] = [];

  stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const script = this.scripts.shift();
    this.calls.push({ ...params, messages: [...params.messages] });
    if (!script) throw new Error("FakeProvider: no script queued");
    return (async function* () {
      for (const ev of script) yield ev;
    })();
  }
}

const echoTool = (onCall?: (input: any) => void): ToolDef => ({
  name: "echo",
  description: "echo back the text",
  schema: Type.Object({ text: Type.String() }),
  execute: async (_id, input) => {
    onCall?.(input);
    return { content: String(input.text) };
  },
});

const userMsg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const freshSignal = (): AbortSignal => new AbortController().signal;

describe("runAgentLoop", () => {
  test("returns immediately on end_turn", async () => {
    const provider = new FakeProvider();
    provider.scripts.push([{ type: "text_delta", text: "hi" }, textDone("hi")]);
    const events = new Emitter();
    const deltas: string[] = [];
    let turnEnd: StopReason | undefined;
    events.on("text_delta", (e) => deltas.push(e.text));
    events.on("turn_end", (e) => (turnEnd = e.stopReason));

    const messages = [userMsg("hello")];
    const { stopReason } = await runAgentLoop({
      provider, system: "s", messages, tools: [], events, signal: freshSignal(),
    });

    expect(stopReason).toBe("end_turn");
    expect(turnEnd).toBe("end_turn");
    expect(deltas).toEqual(["hi"]);
    expect(messages.length).toBe(2);
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content[0]).toEqual({ type: "text", text: "hi" });
  });

  test("mid-stream provider throw keeps partial text and surfaces one error", async () => {
    const provider: Provider = {
      id: "drop",
      defaultModel: "drop",
      async *stream() {
        yield { type: "text_delta", text: "partial " };
        yield { type: "text_delta", text: "answer" };
        throw new Error("Stream interrupted: network reset");
      },
    };
    const events = new Emitter();
    const errors: string[] = [];
    events.on("error", (e) => errors.push(e.error));
    const messages = [userMsg("hi")];
    const { stopReason } = await runAgentLoop({
      provider, system: "s", messages, tools: [], events, signal: freshSignal(),
    });
    expect(stopReason).toBe("error");
    expect(errors).toEqual(["Stream interrupted: network reset"]);
    expect(messages.length).toBe(2);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "partial answer" }],
    });
  });

  test("executes tool calls and feeds results back with full history", async () => {
    const provider = new FakeProvider();
    provider.scripts.push([toolUseDone([{ id: "t1", name: "echo", input: { text: "yo" } }])]);
    provider.scripts.push([textDone("done")]);
    const events = new Emitter();
    const toolEvents: string[] = [];
    events.on("tool_start", (e) => toolEvents.push(`start:${e.name}`));
    events.on("tool_end", (e) => toolEvents.push(`end:${e.name}:${e.result.content}`));

    const messages = [userMsg("go")];
    const { stopReason } = await runAgentLoop({
      provider, system: "s", messages, tools: [echoTool()], events, signal: freshSignal(),
    });

    expect(stopReason).toBe("end_turn");
    expect(toolEvents).toEqual(["start:echo", "end:echo:yo"]);
    expect(messages.length).toBe(4);
    expect(messages[2].role).toBe("user");
    expect(messages[2].content[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "yo" });
    expect(provider.calls.length).toBe(2);
    expect(provider.calls[1].messages.length).toBe(3);
  });

  test("tool throwing produces an is_error tool_result", async () => {
    const provider = new FakeProvider();
    provider.scripts.push([toolUseDone([{ id: "t1", name: "echo", input: { text: "x" } }])]);
    provider.scripts.push([textDone("ok")]);
    const failing: ToolDef = {
      name: "echo",
      description: "throws",
      schema: Type.Object({ text: Type.String() }),
      execute: async () => {
        throw new Error("boom");
      },
    };

    const messages = [userMsg("go")];
    await runAgentLoop({
      provider, system: "s", messages, tools: [failing], events: new Emitter(), signal: freshSignal(),
    });

    expect(messages[2].content[0]).toMatchObject({
      type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true,
    });
  });

  test("unknown tool produces an is_error result", async () => {
    const provider = new FakeProvider();
    provider.scripts.push([toolUseDone([{ id: "t1", name: "nope", input: {} }])]);
    provider.scripts.push([textDone("ok")]);

    const messages = [userMsg("go")];
    await runAgentLoop({
      provider, system: "s", messages, tools: [echoTool()], events: new Emitter(), signal: freshSignal(),
    });

    const result = messages[2].content[0];
    expect(result.type).toBe("tool_result");
    if (result.type === "tool_result") {
      expect(result.is_error).toBe(true);
      expect(result.content).toMatch(/unknown tool/i);
    }
  });

  test("aborted signal produces 'Aborted by user' for every pending tool", async () => {
    const provider = new FakeProvider();
    provider.scripts.push([
      toolUseDone([
        { id: "t1", name: "echo", input: { text: "a" } },
        { id: "t2", name: "echo", input: { text: "b" } },
      ]),
    ]);
    provider.scripts.push([textDone("ok")]);
    const controller = new AbortController();
    controller.abort();
    let executed = 0;

    const messages = [userMsg("go")];
    await runAgentLoop({
      provider, system: "s", messages, tools: [echoTool(() => executed++)], events: new Emitter(),
      signal: controller.signal,
    });

    expect(executed).toBe(0);
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "Aborted by user", is_error: true },
      { type: "tool_result", tool_use_id: "t2", content: "Aborted by user", is_error: true },
    ]);
  });

  test("steering message skips remaining tools and lands after the results message", async () => {
    const provider = new FakeProvider();
    provider.scripts.push([
      toolUseDone([
        { id: "t1", name: "echo", input: { text: "a" } },
        { id: "t2", name: "echo", input: { text: "b" } },
        { id: "t3", name: "echo", input: { text: "c" } },
      ]),
    ]);
    provider.scripts.push([textDone("ok")]);
    const queue: Message[] = [];
    const steering = { take: () => queue.shift() ?? null };

    const messages = [userMsg("go")];
    const { stopReason } = await runAgentLoop({
      provider, system: "s", messages, tools: [echoTool(() => queue.push(userMsg("steer!")))],
      events: new Emitter(), signal: freshSignal(), steering,
    });

    expect(stopReason).toBe("end_turn");
    expect(messages.length).toBe(5);
    const results = messages[2].content;
    expect(results[0]).toEqual({ type: "tool_result", tool_use_id: "t1", content: "a" });
    expect(results[1]).toMatchObject({
      tool_use_id: "t2", content: "Skipped: user sent a new message", is_error: true,
    });
    expect(results[2]).toMatchObject({
      tool_use_id: "t3", content: "Skipped: user sent a new message", is_error: true,
    });
    expect(messages[3]).toEqual(userMsg("steer!"));
    expect(messages[4].content[0]).toEqual({ type: "text", text: "ok" });
    expect(provider.calls[1].messages.length).toBe(4);
  });

  test("maxTurns cap emits an error event and stops with 'error'", async () => {
    const provider = new FakeProvider();
    provider.scripts.push([toolUseDone([{ id: "t1", name: "echo", input: { text: "a" } }])]);
    provider.scripts.push([toolUseDone([{ id: "t2", name: "echo", input: { text: "b" } }])]);
    const events = new Emitter();
    const errors: string[] = [];
    events.on("error", (e) => errors.push(e.error));

    const messages = [userMsg("go")];
    const { stopReason } = await runAgentLoop({
      provider, system: "s", messages, tools: [echoTool()], events, signal: freshSignal(), maxTurns: 2,
    });

    expect(stopReason).toBe("error");
    expect(errors).toEqual(["Max turns (2) reached"]);
    expect(provider.calls.length).toBe(2);
  });
});

describe("loop detector", () => {
  test("identical tool call 3 times in a row stops with an error", async () => {
    const provider = new FakeProvider();
    for (let i = 0; i < 3; i++) {
      provider.scripts.push([toolUseDone([{ id: `t${i}`, name: "echo", input: { text: "same" } }])]);
    }
    const events = new Emitter();
    const errors: string[] = [];
    events.on("error", (e) => errors.push(e.error));

    const messages = [userMsg("go")];
    const { stopReason } = await runAgentLoop({
      provider, system: "s", messages, tools: [echoTool()], events, signal: freshSignal(),
    });

    expect(stopReason).toBe("error");
    expect(errors[0]).toContain("Loop detected");
    expect(errors[0]).toContain("echo");
    expect(provider.calls.length).toBe(3);
    // the third call still produced exactly one tool_result, appended as one user message
    const last = messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t2", is_error: true });
  });

  test("different inputs reset the streak", async () => {
    const provider = new FakeProvider();
    provider.scripts.push([toolUseDone([{ id: "t1", name: "echo", input: { text: "a" } }])]);
    provider.scripts.push([toolUseDone([{ id: "t2", name: "echo", input: { text: "a" } }])]);
    provider.scripts.push([toolUseDone([{ id: "t3", name: "echo", input: { text: "b" } }])]);
    provider.scripts.push([toolUseDone([{ id: "t4", name: "echo", input: { text: "b" } }])]);
    provider.scripts.push([textDone("done")]);
    const events = new Emitter();
    const errors: string[] = [];
    events.on("error", (e) => errors.push(e.error));

    const messages = [userMsg("go")];
    const { stopReason } = await runAgentLoop({
      provider, system: "s", messages, tools: [echoTool()], events, signal: freshSignal(),
    });

    expect(stopReason).toBe("end_turn");
    expect(errors).toEqual([]);
    expect(provider.calls.length).toBe(5);
  });
});
