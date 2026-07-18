import type { TObject } from "@sinclair/typebox";
import type { ToolResult } from "../core/types.js";

export interface ExtensionToolDef {
  name: string;
  description: string;
  schema: TObject;
  // The optional 4th ctx argument lets tools send messages / confirm / exec
  // (needed by the reload-self pattern). Core ToolDef.execute has 3 params;
  // this is an additive superset.
  execute(id: string, params: any, signal: AbortSignal, ctx?: ExtensionContext): Promise<ToolResult>;
}

export type ExtensionEvent =
  | "session_start"
  | "session_shutdown"
  | "turn_start"
  | "turn_end"
  | "tool_call"
  | "tool_result"
  | "permission_requested";

export interface ToolCallEvent {
  toolName: string;
  input: any;
}
export interface ToolResultEvent {
  toolName: string;
  input: any;
  result: ToolResult;
}
export interface PermissionRequestEvent {
  tool: string;
  detail: string;
}

export interface ExtensionUI {
  confirm(title: string, detail?: string): Promise<boolean>;
  notify(text: string, level?: "info" | "error"): void;
}

export interface ExtensionContext {
  cwd: string;
  model: string;
  generation: number; // for stale checks after /reload
  ui: ExtensionUI;
  exec(command: string): Promise<{ code: number; output: string }>; // shell out via the bash tool machinery
  sendUserMessage(text: string, opts?: { deliverAs?: "steer" | "followUp" }): void;
}

export interface ExtensionCommandContext extends ExtensionContext {
  reload(): Promise<void>;
}

export interface ExtensionAPI {
  registerTool(def: ExtensionToolDef): void;
  registerCommand(
    name: string,
    opts: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void> },
  ): void;
  on(
    event: "tool_call",
    handler: (ev: ToolCallEvent, ctx: ExtensionContext) => void | { block: true; reason: string } | Promise<void | { block: true; reason: string }>,
  ): void;
  on(event: "tool_result", handler: (ev: ToolResultEvent, ctx: ExtensionContext) => void | ToolResult | Promise<void | ToolResult>): void;
  on(event: "permission_requested", handler: (ev: PermissionRequestEvent, ctx: ExtensionContext) => void | Promise<void>): void;
  on(event: "session_start" | "session_shutdown" | "turn_start" | "turn_end", handler: (ctx: ExtensionContext) => void | Promise<void>): void;
}

export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;
