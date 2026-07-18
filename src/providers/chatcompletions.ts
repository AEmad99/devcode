import type { ContentBlock, Message, StreamEvent, Usage } from "../core/types.js";
import { sseJson, type FetchImpl } from "./openai.js";
import type { StreamParams } from "./types.js";

// Canonical → OpenAI chat-completions messages.
export function toChatMessages(system: string, messages: Message[]): any[] {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      if (text) out.push({ role: "user", content: text });
      for (const b of m.content) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
      }
    } else {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b) =>
          b.type === "tool_use"
            ? { id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }
            : null,
        );
      out.push({ role: "assistant", content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
    }
  }
  return out;
}

export interface ChatCompletionsCoreOpts {
  url: string;
  headers: Record<string, string>;
  model: string;
  fetchImpl?: FetchImpl;
  extraBody?: Record<string, unknown>;
  errorLabel?: string;
}

export async function* streamChatCompletions(
  opts: ChatCompletionsCoreOpts,
  params: StreamParams,
): AsyncIterable<StreamEvent> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(opts.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    signal: params.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: toChatMessages(params.system, params.messages),
      tools: params.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })),
      stream: true,
      stream_options: { include_usage: true },
      ...opts.extraBody,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${opts.errorLabel ?? "ChatCompletions"} API ${res.status}: ${body.slice(0, 500)}`);
  }

  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string | null = null;
  let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  for await (const data of sseJson(res)) {
    if (data?.error) throw new Error(`${opts.errorLabel ?? "ChatCompletions"} API stream error: ${JSON.stringify(data.error)}`);
    if (data?.usage) {
      usage = {
        input: data.usage.prompt_tokens ?? 0,
        output: data.usage.completion_tokens ?? 0,
        cacheRead: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWrite: 0,
      };
    }
    const choice = data?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      yield { type: "text_delta", text: delta.content };
    }
    for (const frag of delta.tool_calls ?? []) {
      const idx = frag.index ?? 0;
      let call = calls.get(idx);
      if (!call) {
        call = { id: frag.id ?? `call_${idx}`, name: frag.function?.name ?? "", args: "" };
        calls.set(idx, call);
        yield { type: "tool_use_start", id: call.id, name: call.name };
      }
      const argsPart = frag.function?.arguments;
      if (typeof argsPart === "string" && argsPart) {
        call.args += argsPart;
        yield { type: "tool_use_delta", id: call.id, partialJson: argsPart };
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });
  for (const call of [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)) {
    let input: unknown = {};
    try {
      input = call.args ? JSON.parse(call.args) : {};
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_use", id: call.id, name: call.name, input });
  }
  yield {
    type: "done",
    message: { role: "assistant", content: blocks },
    stopReason: finishReason === "tool_calls" || calls.size > 0 ? "tool_use" : "end_turn",
    usage,
  };
}
