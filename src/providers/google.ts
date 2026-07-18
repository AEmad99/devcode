import type { ContentBlock, Message, StreamEvent, Usage } from "../core/types.js";
import type { OAuthCred } from "./auth/storage.js";
import { CFG } from "./config.js";
import { sseJson, type FetchImpl } from "./openai.js";
import type { Provider, StreamParams } from "./types.js";

// Canonical → Gemini contents. functionResponse needs the function name,
// so a first pass builds tool_use_id → name from assistant tool_use blocks.
function toGeminiContents(messages: Message[]): any[] {
  const names = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") names.set(b.id, b.name);
    }
  }
  const contents: any[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const parts: any[] = [];
      for (const b of m.content) {
        if (b.type === "text") parts.push({ text: b.text });
        else if (b.type === "tool_result") {
          parts.push({
            functionResponse: { name: names.get(b.tool_use_id) ?? "unknown", response: { result: b.content } },
          });
        }
      }
      if (parts.length > 0) contents.push({ role: "user", parts });
    } else {
      const parts: any[] = [];
      for (const b of m.content) {
        if (b.type === "text") parts.push({ text: b.text });
        else if (b.type === "tool_use") parts.push({ functionCall: { name: b.name, args: b.input } });
      }
      contents.push({ role: "model", parts });
    }
  }
  return contents;
}

function geminiRequest(params: StreamParams): Record<string, unknown> {
  return {
    contents: toGeminiContents(params.messages),
    systemInstruction: { parts: [{ text: params.system }] },
    tools:
      params.tools.length > 0
        ? [{ functionDeclarations: params.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.schema })) }]
        : undefined,
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
  };
}

export class GoogleProvider implements Provider {
  readonly id = "google";
  readonly defaultModel: string;
  private readonly apiKey?: string;
  private readonly getAuth?: () => Promise<OAuthCred>;
  private readonly projectId?: string;
  private readonly fetchImpl?: FetchImpl;

  constructor(
    opts: (
      | { apiKey?: string; oauth?: undefined }
      | { oauth: () => Promise<OAuthCred>; projectId?: string; apiKey?: undefined }
    ) & { model?: string; fetchImpl?: FetchImpl },
  ) {
    this.defaultModel = opts.model ?? CFG.google.defaultModel;
    this.fetchImpl = opts.fetchImpl;
    if ("oauth" in opts && opts.oauth) {
      this.getAuth = opts.oauth;
      this.projectId = opts.projectId;
    } else {
      const key = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
      if (!key) throw new Error("GoogleProvider: no credentials. Pass { apiKey }, set GEMINI_API_KEY, or /login google.");
      this.apiKey = key;
    }
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const doFetch = this.fetchImpl ?? fetch;
    let url: string;
    let headers: Record<string, string> = { "content-type": "application/json" };
    let body: Record<string, unknown>;
    let wrapped = false;
    if (this.getAuth) {
      const cred = await this.getAuth();
      url = `${CFG.google.codeAssistUrl}:streamGenerateContent?alt=sse`;
      headers.authorization = `Bearer ${cred.access}`;
      body = { model: this.defaultModel, project: this.projectId ?? cred.projectId, request: geminiRequest(params) };
      wrapped = true;
    } else {
      url = `${CFG.google.apiBaseUrl}/${this.defaultModel}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
      body = geminiRequest(params);
    }

    const res = await doFetch(url, { method: "POST", headers, signal: params.signal, body: JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Google API ${res.status}: ${text.slice(0, 500)}`);
    }

    const blocks: ContentBlock[] = [];
    let hasCalls = false;
    let text = "";
    let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let callCount = 0;

    for await (const raw of sseJson(res)) {
      const data = wrapped ? (raw?.response ?? raw) : raw;
      if (data?.error) throw new Error(`Google API stream error: ${JSON.stringify(data.error)}`);
      const u = data?.usageMetadata;
      if (u) {
        usage = {
          input: u.promptTokenCount ?? 0,
          output: u.candidatesTokenCount ?? 0,
          cacheRead: u.cachedContentTokenCount ?? 0,
          cacheWrite: 0,
        };
      }
      for (const part of data?.candidates?.[0]?.content?.parts ?? []) {
        if (typeof part.text === "string" && part.text) {
          text += part.text;
          yield { type: "text_delta", text: part.text };
        } else if (part.functionCall) {
          hasCalls = true;
          const id = `gc-${++callCount}`;
          const args = part.functionCall.args ?? {};
          yield { type: "tool_use_start", id, name: part.functionCall.name ?? "" };
          yield { type: "tool_use_delta", id, partialJson: JSON.stringify(args) };
          blocks.push({ type: "tool_use", id, name: part.functionCall.name ?? "", input: args });
        }
      }
    }

    const content: ContentBlock[] = [];
    if (text) content.push({ type: "text", text });
    content.push(...blocks);
    yield { type: "done", message: { role: "assistant", content }, stopReason: hasCalls ? "tool_use" : "end_turn", usage };
  }
}
