import type { StreamEvent } from "../core/types.js";
import type { OAuthCred } from "./auth/storage.js";
import { streamChatCompletions } from "./chatcompletions.js";
import { CFG } from "./config.js";
import type { FetchImpl } from "./openai.js";
import type { Provider, StreamParams } from "./types.js";

// GitHub Copilot chat completions (OAuth via device flow + token exchange).
export class CopilotProvider implements Provider {
  readonly id = "copilot";
  readonly defaultModel: string;
  private readonly getAuth: () => Promise<OAuthCred>;
  private readonly fetchImpl?: FetchImpl;

  constructor(opts: { getAuth: () => Promise<OAuthCred>; model?: string; fetchImpl?: FetchImpl }) {
    this.getAuth = opts.getAuth;
    this.defaultModel = opts.model ?? CFG.copilot.defaultModel;
    this.fetchImpl = opts.fetchImpl;
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const cred = await this.getAuth();
    const baseUrl = cred.baseUrl ?? CFG.copilot.defaultBaseUrl;
    const last = params.messages[params.messages.length - 1];
    const headers: Record<string, string> = {
      authorization: `Bearer ${cred.access}`,
      ...CFG.copilot.headers,
      "X-Initiator": last?.role === "user" ? "user" : "agent",
    };
    yield* streamChatCompletions(
      { url: `${baseUrl}/chat/completions`, headers, model: this.defaultModel, fetchImpl: this.fetchImpl, errorLabel: "Copilot" },
      params,
    );
  }
}
