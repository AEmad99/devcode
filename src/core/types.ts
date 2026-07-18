export type Role = "user" | "assistant";
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export interface Message {
  role: Role;
  content: ContentBlock[];
}
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "aborted" | "error";
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_delta"; id: string; partialJson: string }
  | { type: "done"; message: Message; stopReason: StopReason; usage: Usage };
export interface ToolResult {
  content: string;
  is_error?: boolean;
}
export interface ToolDef {
  name: string;
  description: string;
  schema: import("@sinclair/typebox").TObject; // JSON schema via TypeBox
  execute(id: string, input: any, signal: AbortSignal): Promise<ToolResult>;
}
export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  /** Streamed as soon as the model names a tool (args may still be incomplete). */
  | { type: "tool_use_start"; id: string; name: string }
  /** Partial JSON args while the model streams a tool call. */
  | { type: "tool_delta"; id: string; partialJson: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; result: ToolResult }
  | { type: "turn_end"; stopReason: StopReason; usage: Usage }
  | { type: "error"; error: string };
