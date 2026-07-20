import { anthropicBudget, detectThinking } from "../core/thinking.js";
import type { ContentBlock, StopReason, StreamEvent, Usage } from "../core/types.js";
import type { Provider, StreamParams } from "./types.js";

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-4-5";

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly oauthToken?: string;

  private readonly fetchImpl?: typeof fetch;

  private readonly oauthBeta: boolean;

  constructor(
    opts: {
      apiKey?: string;
      oauthToken?: string;
      model?: string;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
      /** When true (default for real Anthropic OAuth), add oauth beta header. */
      oauthBeta?: boolean;
    } = {},
  ) {
    this.oauthToken = opts.oauthToken ?? process.env.ANTHROPIC_OAUTH_TOKEN;
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!this.oauthToken && !this.apiKey) {
      throw new Error(
        "AnthropicProvider: no credentials. Pass { apiKey } or { oauthToken }, or set ANTHROPIC_OAUTH_TOKEN / ANTHROPIC_API_KEY.",
      );
    }
    this.defaultModel = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl;
    // Only native Anthropic OAuth needs the beta header; compat proxies usually reject it.
    this.oauthBeta = opts.oauthBeta ?? (Boolean(this.oauthToken) && this.baseUrl.includes("anthropic.com"));
  }

  private headers(thinking: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    const betas: string[] = [];
    if (this.oauthToken) {
      headers["authorization"] = `Bearer ${this.oauthToken}`;
      if (this.oauthBeta) betas.push("oauth-2025-04-20");
    } else {
      headers["x-api-key"] = this.apiKey!;
    }
    if (thinking && this.baseUrl.includes("anthropic.com")) {
      betas.push("interleaved-thinking-2025-05-14");
    }
    if (betas.length) headers["anthropic-beta"] = betas.join(",");
    return headers;
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const cap = detectThinking(this.defaultModel, this.id);
    const budget =
      params.thinking && params.thinking !== "off" && cap.supported ? anthropicBudget(params.thinking) : null;
    const maxTokens = budget ? Math.max(params.maxTokens, budget + 4096) : params.maxTokens;

    const body: Record<string, unknown> = {
      model: this.defaultModel,
      max_tokens: maxTokens,
      system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }],
      messages: params.messages,
      tools: params.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
        ...(i === params.tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      })),
      stream: true,
    };
    if (budget) body.thinking = { type: "enabled", budget_tokens: budget };

    const res = await (this.fetchImpl ?? fetch)(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers(Boolean(budget)),
      signal: params.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 500)}`);
    }

    const blocks: ContentBlock[] = [];
    let current: { kind: "text" | "tool_use" | "thinking"; id: string; name: string; text: string; json: string } | null =
      null;
    let stopReason: StopReason = "end_turn";
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let finished = false;

    const applyUsage = (u: any): void => {
      if (!u) return;
      if (typeof u.input_tokens === "number") usage.input = u.input_tokens;
      if (typeof u.output_tokens === "number") usage.output = u.output_tokens;
      if (typeof u.cache_read_input_tokens === "number") usage.cacheRead = u.cache_read_input_tokens;
      if (typeof u.cache_creation_input_tokens === "number") usage.cacheWrite = u.cache_creation_input_tokens;
    };

    function* handle(data: any): Generator<StreamEvent> {
      switch (data?.type) {
        case "message_start":
          applyUsage(data.message?.usage);
          break;
        case "content_block_start": {
          const b = data.content_block ?? {};
          if (b.type === "tool_use") {
            current = { kind: "tool_use", id: b.id ?? "", name: b.name ?? "", text: "", json: "" };
            yield { type: "tool_use_start", id: current.id, name: current.name };
          } else if (b.type === "thinking") {
            current = { kind: "thinking", id: "", name: "", text: "", json: "" };
          } else {
            current = { kind: "text", id: "", name: "", text: "", json: "" };
          }
          break;
        }
        case "content_block_delta": {
          const d = data.delta ?? {};
          if ((d.type === "thinking_delta" || d.type === "thinking") && current?.kind === "thinking") {
            const t = d.thinking ?? d.text ?? "";
            current.text += t;
            if (t) yield { type: "thinking_delta", text: t };
          } else if (d.type === "text_delta" && current) {
            current.text += d.text ?? "";
            yield { type: "text_delta", text: d.text ?? "" };
          } else if (d.type === "input_json_delta" && current) {
            current.json += d.partial_json ?? "";
            yield { type: "tool_use_delta", id: current.id, partialJson: d.partial_json ?? "" };
          }
          break;
        }
        case "content_block_stop": {
          if (!current) break;
          if (current.kind === "tool_use") {
            let input: unknown = {};
            try {
              input = current.json ? JSON.parse(current.json) : {};
            } catch {
              input = {}; // malformed JSON: tool-side schema validation reports the error
            }
            blocks.push({ type: "tool_use", id: current.id, name: current.name, input });
          } else if (current.kind === "text" && current.text) {
            blocks.push({ type: "text", text: current.text });
          }
          // thinking blocks are UI-only — not re-sent to the model in this minimal agent
          current = null;
          break;
        }
        case "message_delta": {
          const sr = data.delta?.stop_reason;
          if (sr === "end_turn" || sr === "tool_use" || sr === "max_tokens") stopReason = sr;
          applyUsage(data.usage);
          break;
        }
        case "message_stop":
          finished = true;
          yield { type: "done", message: { role: "assistant", content: blocks }, stopReason, usage };
          break;
        case "error":
          throw new Error(`Anthropic API stream error: ${JSON.stringify(data.error ?? data)}`);
      }
    }

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
        const eof = done;
        if (eof) break;
        buffer += decoder.decode(value, { stream: true });
        // Only normalize CRLF when a CR is actually present (rare over SSE) —
        // avoids allocating a new string on every chunk in the common case.
        if (buffer.indexOf("\r") !== -1) buffer = buffer.replace(/\r\n/g, "\n");
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLines = raw
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart());
          if (dataLines.length === 0) continue;
          let data: any;
          try {
            data = JSON.parse(dataLines.join("\n"));
          } catch {
            continue; // ignore unparseable keep-alives
          }
          yield* handle(data);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released / closed
      }
    }
    if (!finished) {
      // Network drop / incomplete stream: keep whatever blocks we already assembled.
      yield { type: "done", message: { role: "assistant", content: blocks }, stopReason, usage };
    }
  }
}
