import type { StreamEvent } from "../core/types.js";
import { AnthropicProvider } from "./anthropic.js";
import { streamChatCompletions } from "./chatcompletions.js";
import { streamResponses, type FetchImpl } from "./openai.js";
import type { Provider, StreamParams } from "./types.js";

/** Thin OpenAI Chat Completions adapter — covers most pi API-key providers. */
export class ChatCompletionsProvider implements Provider {
  readonly id: string;
  readonly defaultModel: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl?: FetchImpl;
  private readonly extraBody?: Record<string, unknown>;

  constructor(opts: {
    id: string;
    url: string;
    apiKey: string;
    model: string;
    /** How to send the key. Default: Authorization Bearer. */
    authHeader?: "bearer" | "api-key" | "x-api-key" | "cf-aig";
    fetchImpl?: FetchImpl;
    extraBody?: Record<string, unknown>;
    extraHeaders?: Record<string, string>;
  }) {
    this.id = opts.id;
    this.defaultModel = opts.model;
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl;
    this.extraBody = opts.extraBody;
    const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
    switch (opts.authHeader ?? "bearer") {
      case "api-key":
        headers["api-key"] = opts.apiKey;
        break;
      case "x-api-key":
        headers["x-api-key"] = opts.apiKey;
        break;
      case "cf-aig":
        headers["cf-aig-authorization"] = `Bearer ${opts.apiKey}`;
        break;
      default:
        headers.authorization = `Bearer ${opts.apiKey}`;
    }
    this.headers = headers;
  }

  stream(params: StreamParams): AsyncIterable<StreamEvent> {
    return streamChatCompletions(
      {
        url: this.url,
        headers: this.headers,
        model: this.defaultModel,
        fetchImpl: this.fetchImpl,
        errorLabel: this.id,
        extraBody: this.extraBody,
      },
      params,
    );
  }
}

/** Anthropic Messages API on a non-Anthropic host (Kimi Coding, MiniMax, …). */
export class AnthropicCompatProvider implements Provider {
  readonly id: string;
  readonly defaultModel: string;
  private readonly inner: AnthropicProvider;

  constructor(opts: {
    id: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    /** Prefer Bearer (common for proxies) vs x-api-key (native Anthropic). */
    authStyle?: "bearer" | "x-api-key";
    fetchImpl?: FetchImpl;
  }) {
    this.id = opts.id;
    this.defaultModel = opts.model;
    this.inner = new AnthropicProvider({
      ...(opts.authStyle === "x-api-key" ? { apiKey: opts.apiKey } : { oauthToken: opts.apiKey }),
      model: opts.model,
      baseUrl: opts.baseUrl.replace(/\/$/, ""),
      fetchImpl: opts.fetchImpl as typeof fetch | undefined,
      oauthBeta: false,
    });
  }

  stream(params: StreamParams): AsyncIterable<StreamEvent> {
    return this.inner.stream(params);
  }
}

/** OpenAI Responses API on a custom host (Azure, …). */
export class ResponsesCompatProvider implements Provider {
  readonly id: string;
  readonly defaultModel: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl?: FetchImpl;

  constructor(opts: {
    id: string;
    url: string;
    apiKey: string;
    model: string;
    authHeader?: "bearer" | "api-key";
    fetchImpl?: FetchImpl;
  }) {
    this.id = opts.id;
    this.defaultModel = opts.model;
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl;
    this.headers =
      opts.authHeader === "api-key"
        ? { "api-key": opts.apiKey }
        : { authorization: `Bearer ${opts.apiKey}` };
  }

  stream(params: StreamParams): AsyncIterable<StreamEvent> {
    return streamResponses(
      {
        url: this.url,
        headers: this.headers,
        model: this.defaultModel,
        fetchImpl: this.fetchImpl,
        errorLabel: this.id,
      },
      params,
    );
  }
}
