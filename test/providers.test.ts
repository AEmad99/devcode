import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { CopilotProvider } from "../src/providers/copilot.js";
import { GoogleProvider } from "../src/providers/google.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { OpenAICodexProvider } from "../src/providers/openai-codex.js";
import { ChatCompletionsProvider } from "../src/providers/generic.js";
import { PI_API_CATALOG } from "../src/providers/catalog.js";
import { REGISTRY, supportsApiKey } from "../src/providers/registry.js";
import type { OAuthCred } from "../src/providers/auth/storage.js";
import type { Message, StreamEvent, ToolDef } from "../src/core/types.js";
import type { StreamParams } from "../src/providers/types.js";

// --- helpers ---

function sseResponse(events: (object | string)[]): Response {
  const body = `${events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n")}\n\n`;
  return new Response(new TextEncoder().encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Captured {
  url: string;
  init?: RequestInit;
}

function mockFetch(responder: (url: string) => Response): { calls: Captured[]; fn: typeof fetch } {
  const calls: Captured[] = [];
  const fn = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    return responder(String(url));
  }) as typeof fetch;
  return { calls, fn };
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

function bodyOf(call: Captured): any {
  return JSON.parse(String(call.init?.body ?? "{}"));
}

const tools: ToolDef[] = [
  { name: "read", description: "read a file", schema: Type.Object({ path: Type.String() }), execute: async () => ({ content: "" }) },
];

const conversation: Message[] = [
  { role: "user", content: [{ type: "text", text: "read config" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Let me read it." },
      { type: "tool_use", id: "t1", name: "read", input: { path: "a.txt" } },
    ],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }] },
];

const params = (): StreamParams => ({
  system: "SYS",
  messages: conversation,
  tools,
  maxTokens: 1024,
  signal: new AbortController().signal,
});

const done = (events: StreamEvent[]): Extract<StreamEvent, { type: "done" }> => {
  const d = events.find((e) => e.type === "done");
  if (!d || d.type !== "done") throw new Error("no done event");
  return d;
};

// --- anthropic (regression + request shape) ---

describe("AnthropicProvider", () => {
  const fixture = [
    '{"type":"message_start","message":{"id":"m1","usage":{"input_tokens":25,"output_tokens":1,"cache_read_input_tokens":4,"cache_creation_input_tokens":6}}}',
    '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
    '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
    '{"type":"content_block_stop","index":0}',
    '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read"}}',
    '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
    '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}',
    '{"type":"content_block_stop","index":1}',
    '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}',
    '{"type":"message_stop"}',
  ];

  test("parses SSE into canonical events", async () => {
    const { calls, fn } = mockFetch(() => sseResponse(fixture));
    const provider = new AnthropicProvider({ apiKey: "sk-test", fetchImpl: fn });
    const events = await collect(provider.stream(params()));

    expect(events[0]).toEqual({ type: "text_delta", text: "Hel" });
    expect(events).toContainEqual({ type: "tool_use_start", id: "toolu_1", name: "read" });
    const d = done(events);
    expect(d.message.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.txt" } },
    ]);
    expect(d.stopReason).toBe("tool_use");
    expect(d.usage).toEqual({ input: 25, output: 12, cacheRead: 4, cacheWrite: 6 });

    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    const body = bodyOf(calls[0]);
    expect(body.system[0]).toMatchObject({ type: "text", text: "SYS", cache_control: { type: "ephemeral" } });
    expect(body.tools[0]).toMatchObject({ name: "read", input_schema: expect.anything(), cache_control: { type: "ephemeral" } });
    expect(body.stream).toBe(true);
  });

  test("mid-stream body drop surfaces Stream interrupted", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
        controller.enqueue(enc.encode('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'));
        controller.enqueue(enc.encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n'));
        controller.error(new Error("socket hang up"));
      },
    });
    const fn = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const provider = new AnthropicProvider({ apiKey: "sk-test", fetchImpl: fn });
    await expect(collect(provider.stream(params()))).rejects.toThrow(/Stream interrupted/);
  });
});

// --- openai responses ---

describe("OpenAIProvider (Responses API)", () => {
  const fixture = [
    { type: "response.output_text.delta", delta: "Hi" },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_1", name: "read" } },
    { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":"a.txt"}' },
    {
      type: "response.completed",
      response: {
        output: [
          { type: "message", content: [{ type: "output_text", text: "Hi" }] },
          { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];

  test("maps responses SSE to canonical events and request shape", async () => {
    const { calls, fn } = mockFetch(() => sseResponse(fixture));
    const provider = new OpenAIProvider({ apiKey: "sk-openai", fetchImpl: fn });
    const events = await collect(provider.stream(params()));

    expect(events[0]).toEqual({ type: "text_delta", text: "Hi" });
    expect(events).toContainEqual({ type: "tool_use_start", id: "call_1", name: "read" });
    expect(events).toContainEqual({ type: "tool_use_delta", id: "call_1", partialJson: '{"path":"a.txt"}' });
    const d = done(events);
    expect(d.message.content).toEqual([
      { type: "text", text: "Hi" },
      { type: "tool_use", id: "call_1", name: "read", input: { path: "a.txt" } },
    ]);
    expect(d.stopReason).toBe("tool_use");
    expect(d.usage).toEqual({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });

    expect(calls[0].url).toBe("https://api.openai.com/v1/responses");
    expect((calls[0].init?.headers as any).authorization).toBe("Bearer sk-openai");
    const body = bodyOf(calls[0]);
    expect(body.instructions).toBe("SYS");
    expect(body.store).toBe(false);
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "read config" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me read it." }] },
      { type: "function_call", call_id: "t1", name: "read", arguments: '{"path":"a.txt"}' },
      { type: "function_call_output", call_id: "t1", output: "file contents" },
    ]);
    expect(body.tools[0]).toMatchObject({ type: "function", name: "read", parameters: expect.anything() });
  });

  test("mid-stream body drop surfaces Stream interrupted", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'));
        controller.error(new Error("ECONNRESET"));
      },
    });
    const fn = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: "sk-openai", fetchImpl: fn });
    await expect(collect(provider.stream(params()))).rejects.toThrow(/Stream interrupted/);
  });
});

describe("OpenAICodexProvider", () => {
  test("sends codex backend headers", async () => {
    const { calls, fn } = mockFetch(() =>
      sseResponse([
        { type: "response.output_text.delta", delta: "ok" },
        { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: {} } },
      ]),
    );
    const cred: OAuthCred = { type: "oauth", access: "codex-token", refresh: "r", expires: Date.now() + 1e6, accountId: "acct-9" };
    const provider = new OpenAICodexProvider({ getAuth: async () => cred, accountId: cred.accountId, fetchImpl: fn });
    const events = await collect(provider.stream(params()));
    expect(done(events).stopReason).toBe("end_turn");
    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/codex/responses");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer codex-token");
    expect(headers["chatgpt-account-id"]).toBe("acct-9");
    expect(headers["OpenAI-Beta"]).toBe("responses=experimental");
    expect(headers.originator).toBe("devcode");
    expect(headers.session_id).toBeTruthy();
  });
});

// --- chat completions (openrouter + copilot) ---

describe("OpenRouterProvider (chat completions)", () => {
  const fixture = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
    { choices: [{ index: 0, delta: { content: "Hi" } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"pa' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
    "[DONE]",
  ];

  test("assembles fragmented tool calls and maps request", async () => {
    const { calls, fn } = mockFetch(() => sseResponse(fixture));
    const provider = new ChatCompletionsProvider({
      id: "openrouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: "or-key",
      model: "anthropic/claude-sonnet-4.5",
      fetchImpl: fn,
      extraHeaders: { "HTTP-Referer": "https://devcode.local", "X-Title": "DevCode" },
    });
    const events = await collect(provider.stream(params()));

    expect(events).toContainEqual({ type: "text_delta", text: "Hi" });
    expect(events.filter((e) => e.type === "tool_use_start").length).toBe(1);
    expect(events.filter((e) => e.type === "tool_use_delta").length).toBe(2);
    const d = done(events);
    expect(d.message.content).toEqual([
      { type: "text", text: "Hi" },
      { type: "tool_use", id: "call_1", name: "read", input: { path: "a.txt" } },
    ]);
    expect(d.stopReason).toBe("tool_use");
    expect(d.usage).toEqual({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0 });

    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer or-key");
    expect(headers["HTTP-Referer"]).toBe("https://devcode.local");
    const body = bodyOf(calls[0]);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(body.messages[1]).toEqual({ role: "user", content: "read config" });
    expect(body.messages[2]).toEqual({
      role: "assistant",
      content: "Let me read it.",
      tool_calls: [{ id: "t1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
    });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "file contents" });
  });
});

describe("CopilotProvider", () => {
  test("sends copilot headers and initiator", async () => {
    const { calls, fn } = mockFetch(() =>
      sseResponse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }, "[DONE]"]),
    );
    const cred: OAuthCred = {
      type: "oauth",
      access: "cop-tok",
      refresh: "gh-tok",
      expires: Date.now() + 1e6,
      baseUrl: "https://api.individual.githubcopilot.com",
    };
    const provider = new CopilotProvider({ getAuth: async () => cred, fetchImpl: fn });
    const events = await collect(provider.stream(params()));
    expect(done(events).stopReason).toBe("end_turn");
    expect(calls[0].url).toBe("https://api.individual.githubcopilot.com/chat/completions");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer cop-tok");
    expect(headers["Editor-Version"]).toBeTruthy();
    expect(headers["Copilot-Integration-Id"]).toBe("vscode-chat");
    expect(headers["X-Initiator"]).toBe("user"); // last message is a user tool_result
  });
});

// --- google ---

describe("GoogleProvider (api key)", () => {
  const fixture = [
    { candidates: [{ content: { role: "model", parts: [{ text: "Sure" }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a.txt" } } }] } }] },
    { candidates: [{ content: { role: "model", parts: [] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } },
  ];

  test("maps parts to canonical events and request shape", async () => {
    const { calls, fn } = mockFetch(() => sseResponse(fixture));
    const provider = new GoogleProvider({ apiKey: "g-key", fetchImpl: fn });
    const events = await collect(provider.stream(params()));

    expect(events).toContainEqual({ type: "text_delta", text: "Sure" });
    expect(events).toContainEqual({ type: "tool_use_start", id: "gc-1", name: "read" });
    expect(events).toContainEqual({ type: "tool_use_delta", id: "gc-1", partialJson: '{"path":"a.txt"}' });
    const d = done(events);
    expect(d.message.content).toEqual([
      { type: "text", text: "Sure" },
      { type: "tool_use", id: "gc-1", name: "read", input: { path: "a.txt" } },
    ]);
    expect(d.stopReason).toBe("tool_use");
    expect(d.usage).toEqual({ input: 9, output: 4, cacheRead: 0, cacheWrite: 0 });

    expect(calls[0].url).toContain("generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent");
    expect(calls[0].url).toContain("key=g-key");
    const body = bodyOf(calls[0]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "SYS" }] });
    expect(body.contents[0]).toEqual({ role: "user", parts: [{ text: "read config" }] });
    expect(body.contents[1]).toEqual({
      role: "model",
      parts: [{ text: "Let me read it." }, { functionCall: { name: "read", args: { path: "a.txt" } } }],
    });
    expect(body.contents[2]).toEqual({
      role: "user",
      parts: [{ functionResponse: { name: "read", response: { result: "file contents" } } }],
    });
    expect(body.tools[0].functionDeclarations[0].name).toBe("read");
  });
});

describe("GoogleProvider (Code Assist OAuth)", () => {
  test("uses the envelope and unwraps responses", async () => {
    const { calls, fn } = mockFetch(() =>
      sseResponse([
        { response: { candidates: [{ content: { role: "model", parts: [{ text: "Ok" }] } }] } },
        { response: { candidates: [{ content: { role: "model", parts: [] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } } },
      ]),
    );
    const cred: OAuthCred = { type: "oauth", access: "ya29.tok", refresh: "r", expires: Date.now() + 1e6, projectId: "proj-1" };
    const provider = new GoogleProvider({ oauth: async () => cred, projectId: "proj-1", fetchImpl: fn });
    const events = await collect(provider.stream(params()));

    const d = done(events);
    expect(d.message.content).toEqual([{ type: "text", text: "Ok" }]);
    expect(d.stopReason).toBe("end_turn");
    expect(d.usage).toEqual({ input: 3, output: 2, cacheRead: 0, cacheWrite: 0 });

    expect(calls[0].url).toBe("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect((calls[0].init?.headers as any).authorization).toBe("Bearer ya29.tok");
    const body = bodyOf(calls[0]);
    expect(body.model).toBe("gemini-2.5-pro");
    expect(body.project).toBe("proj-1");
    expect(body.request.contents.length).toBe(3);
    expect(body.request.systemInstruction).toEqual({ parts: [{ text: "SYS" }] });
  });
});

describe("ChatCompletionsProvider (xAI / DeepSeek)", () => {
  test("xAI sends chat completions to api.x.ai", async () => {
    const { calls, fn } = mockFetch(() =>
      sseResponse([
        { choices: [{ delta: { content: "Hi" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
      ]),
    );
    const provider = new ChatCompletionsProvider({
      id: "xai",
      url: "https://api.x.ai/v1/chat/completions",
      apiKey: "xai-key",
      model: "grok-3",
      fetchImpl: fn,
    });
    const events = await collect(provider.stream(params()));
    expect(events[0]).toEqual({ type: "text_delta", text: "Hi" });
    expect(calls[0].url).toBe("https://api.x.ai/v1/chat/completions");
    expect((calls[0].init?.headers as any).authorization).toBe("Bearer xai-key");
  });

  test("DeepSeek sends chat completions to api.deepseek.com", async () => {
    const { calls, fn } = mockFetch(() =>
      sseResponse([
        { choices: [{ delta: { content: "Yo" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ]),
    );
    const provider = new ChatCompletionsProvider({
      id: "deepseek",
      url: "https://api.deepseek.com/chat/completions",
      apiKey: "ds-key",
      model: "deepseek-chat",
      fetchImpl: fn,
    });
    await collect(provider.stream(params()));
    expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect((calls[0].init?.headers as any).authorization).toBe("Bearer ds-key");
  });

  test("Ollama Cloud sends chat completions to ollama.com/v1", async () => {
    const { calls, fn } = mockFetch(() =>
      sseResponse([
        { choices: [{ delta: { content: "Cloud" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2 } },
      ]),
    );
    const provider = new ChatCompletionsProvider({
      id: "ollama-cloud",
      url: "https://ollama.com/v1/chat/completions",
      apiKey: "ollama-key",
      model: "gpt-oss:120b",
      fetchImpl: fn,
    });
    const events = await collect(provider.stream(params()));
    expect(events[0]).toEqual({ type: "text_delta", text: "Cloud" });
    expect(calls[0].url).toBe("https://ollama.com/v1/chat/completions");
    expect((calls[0].init?.headers as any).authorization).toBe("Bearer ollama-key");
    expect(bodyOf(calls[0]).model).toBe("gpt-oss:120b");
  });
});

describe("ollama-cloud catalog entry", () => {
  test("is registered with OLLAMA_API_KEY and cloud URL", () => {
    const entry = PI_API_CATALOG.find((e) => e.id === "ollama-cloud");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("Ollama Cloud");
    expect(entry!.envKeys).toContain("OLLAMA_API_KEY");
    expect(entry!.protocol).toBe("openai-completions");
    expect(entry!.url).toBe("https://ollama.com/v1/chat/completions");
    expect(entry!.defaultModel).toBe("gpt-oss:120b");
    const byId = Object.fromEntries(REGISTRY.map((s) => [s.id, s]));
    expect(byId["ollama-cloud"]).toBeDefined();
    expect(byId["ollama-cloud"].envKeys).toContain("OLLAMA_API_KEY");
    expect(supportsApiKey(byId["ollama-cloud"])).toBe(true);
  });
});

describe("REGISTRY covers pi providers", () => {
  test("oauth specials + every pi catalog id is registered", () => {
    const byId = Object.fromEntries(REGISTRY.map((s) => [s.id, s]));
    expect(byId.anthropic.oauth?.flowId).toBe("anthropic");
    expect(supportsApiKey(byId.anthropic)).toBe(true);
    expect(byId["openai-codex"].oauth?.flowId).toBe("openai");
    expect(supportsApiKey(byId["openai-codex"])).toBe(false);
    expect(byId.google.oauth?.flowId).toBe("google");
    expect(byId.copilot.oauth?.flowId).toBe("copilot");
    for (const entry of PI_API_CATALOG) {
      expect(byId[entry.id]).toBeDefined();
      expect(supportsApiKey(byId[entry.id])).toBe(true);
    }
    // Sanity: we should have well over the original 6–8 providers
    expect(REGISTRY.length).toBeGreaterThanOrEqual(30);
  });
});

