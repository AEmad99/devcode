import type { StreamEvent } from "../core/types.js";
import type { OAuthCred } from "./auth/storage.js";
import { CFG } from "./config.js";
import { streamResponses, type FetchImpl } from "./openai.js";
import type { Provider, StreamParams } from "./types.js";

// ChatGPT-subscription Codex backend (OAuth only).
export class OpenAICodexProvider implements Provider {
  readonly id = "openai-codex";
  readonly defaultModel: string;
  private readonly getAuth: () => Promise<OAuthCred>;
  private readonly accountId?: string;
  private readonly sessionId: string;
  private readonly fetchImpl?: FetchImpl;

  constructor(opts: {
    getAuth: () => Promise<OAuthCred>;
    accountId?: string;
    model?: string;
    sessionId?: string;
    fetchImpl?: FetchImpl;
  }) {
    this.getAuth = opts.getAuth;
    this.accountId = opts.accountId;
    this.defaultModel = opts.model ?? CFG.openaiCodex.defaultModel;
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    this.fetchImpl = opts.fetchImpl;
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const cred = await this.getAuth();
    const headers: Record<string, string> = {
      authorization: `Bearer ${cred.access}`,
      "OpenAI-Beta": "responses=experimental",
      originator: "devcode",
      session_id: this.sessionId,
    };
    if (this.accountId ?? cred.accountId) headers["chatgpt-account-id"] = (this.accountId ?? cred.accountId)!;
    yield* streamResponses(
      {
        url: CFG.openaiCodex.responsesUrl,
        headers,
        model: this.defaultModel,
        fetchImpl: this.fetchImpl,
        errorLabel: "OpenAI Codex",
      },
      params,
    );
  }
}
