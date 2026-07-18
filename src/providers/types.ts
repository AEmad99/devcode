import type { ThinkingLevel } from "../core/thinking.js";
import type { Message, StreamEvent, ToolDef } from "../core/types.js";

export interface StreamParams {
  system: string;
  messages: Message[];
  tools: ToolDef[];
  maxTokens: number;
  signal: AbortSignal;
  /** Extended thinking / reasoning effort when the model supports it. */
  thinking?: ThinkingLevel;
}

export interface Provider {
  id: string;
  defaultModel: string;
  stream(params: StreamParams): AsyncIterable<StreamEvent>;
}
