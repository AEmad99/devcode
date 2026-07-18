import { detectThinking, openaiEffort } from "../core/thinking.js";
import type { ContentBlock, StreamEvent, Usage } from "../core/types.js";
import { CFG } from "./config.js";
import type { Provider, StreamParams } from "./types.js";

export type FetchImpl = typeof fetch;

// Shared SSE core: yields parsed JSON payloads (handles chunking + [DONE]).
// Network drops surface as a single clean Error (not a raw stream exception).
export async function* sseJson(res: Response): AsyncGenerator<any> {
  if (!res.body) throw new Error("Response has no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Stream interrupted: ${msg}`);
      }
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = raw
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload);
        } catch {
          // keep-alive / partial payload: ignore
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released / closed
    }
  }
}

// Canonical messages → Responses API `input` items.
export function toResponsesInput(messages: StreamParams["messages"]): any[] {
  const input: any[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "text") {
        input.push({
          type: "message",
          role: m.role,
          content: [{ type: m.role === "user" ? "input_text" : "output_text", text: b.text }],
        });
      } else if (b.type === "tool_use") {
        input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
      } else if (b.type === "tool_result") {
        input.push({ type: "function_call_output", call_id: b.tool_use_id, output: b.content });
      }
    }
  }
  return input;
}

export interface ResponsesCoreOpts {
  url: string;
  headers: Record<string, string>;
  model: string;
  fetchImpl?: FetchImpl;
  errorLabel?: string;
}

export async function* streamResponses(opts: ResponsesCoreOpts, params: StreamParams): AsyncIterable<StreamEvent> {
  const cap = detectThinking(opts.model);
  const effort =
    params.thinking && params.thinking !== "off" && cap.supported ? openaiEffort(params.thinking) : null;

  const body: Record<string, unknown> = {
    model: opts.model,
    instructions: params.system,
    input: toResponsesInput(params.messages),
    tools: params.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.schema })),
    store: false,
    stream: true,
  };
  if (effort) body.reasoning = { effort };

  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(opts.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    signal: params.signal,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`${opts.errorLabel ?? "OpenAI"} API ${res.status}: ${errBody.slice(0, 500)}`);
  }

  // Live tool-call tracking for delta forwarding; final message is assembled from response.completed.
  const callIds = new Map<number, string>();
  let done: Extract<StreamEvent, { type: "done" }> | null = null;

  for await (const data of sseJson(res)) {
    switch (data?.type) {
      case "response.output_text.delta":
        yield { type: "text_delta", text: data.delta ?? "" };
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (typeof data.delta === "string" && data.delta) yield { type: "thinking_delta", text: data.delta };
        break;
      case "response.output_item.added":
        if (data.item?.type === "function_call") {
          const id = data.item.call_id ?? data.item.id ?? "";
          if (typeof data.output_index === "number") callIds.set(data.output_index, id);
          yield { type: "tool_use_start", id, name: data.item.name ?? "" };
        }
        break;
      case "response.function_call_arguments.delta":
        yield { type: "tool_use_delta", id: callIds.get(data.output_index ?? -1) ?? "", partialJson: data.delta ?? "" };
        break;
      case "response.completed": {
        const r = data.response ?? {};
        const blocks: ContentBlock[] = [];
        let hasCalls = false;
        for (const item of r.output ?? []) {
          if (item.type === "message") {
            const text = (item.content ?? [])
              .filter((c: any) => c?.type === "output_text")
              .map((c: any) => c.text ?? "")
              .join("");
            if (text) blocks.push({ type: "text", text });
          } else if (item.type === "function_call") {
            hasCalls = true;
            let input: unknown = {};
            try {
              input = item.arguments ? JSON.parse(item.arguments) : {};
            } catch {
              input = {};
            }
            blocks.push({ type: "tool_use", id: item.call_id ?? item.id ?? "", name: item.name ?? "", input });
          }
        }
        const u = r.usage ?? {};
        const usage: Usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.input_tokens_details?.cached_tokens ?? 0,
          cacheWrite: 0,
        };
        done = { type: "done", message: { role: "assistant", content: blocks }, stopReason: hasCalls ? "tool_use" : "end_turn", usage };
        break;
      }
      case "error":
      case "response.failed":
        throw new Error(`${opts.errorLabel ?? "OpenAI"} API stream error: ${JSON.stringify(data.error ?? data.response?.error ?? data)}`);
    }
  }
  yield done ?? {
    type: "done",
    message: { role: "assistant", content: [] },
    stopReason: "end_turn",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export class OpenAIProvider implements Provider {
  readonly id = "openai";
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly url: string;
  private readonly fetchImpl?: FetchImpl;

  constructor(opts: { apiKey?: string; model?: string; baseUrl?: string; fetchImpl?: FetchImpl } = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OpenAIProvider: no API key. Pass { apiKey } or set OPENAI_API_KEY.");
    this.apiKey = apiKey;
    this.defaultModel = opts.model ?? CFG.openai.defaultModel;
    this.url = opts.baseUrl ?? CFG.openai.responsesUrl;
    this.fetchImpl = opts.fetchImpl;
  }

  stream(params: StreamParams): AsyncIterable<StreamEvent> {
    return streamResponses(
      { url: this.url, headers: { authorization: `Bearer ${this.apiKey}` }, model: this.defaultModel, fetchImpl: this.fetchImpl },
      params,
    );
  }
}
