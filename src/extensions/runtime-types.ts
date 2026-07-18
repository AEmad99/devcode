// Aliased as "devcode" for extensions loaded via jiti, so they can write:
//   import type { ExtensionAPI } from "devcode";
export type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
  ExtensionFactory,
  ExtensionToolDef,
  ExtensionUI,
  ToolCallEvent,
  ToolResultEvent,
} from "./api.js";
