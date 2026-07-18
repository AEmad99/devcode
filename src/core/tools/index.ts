import type { TSchema } from "@sinclair/typebox";
import { TypeCompiler, type TypeCheck } from "@sinclair/typebox/compiler";
import { Value } from "@sinclair/typebox/value";
import { spillCap } from "../context.js";
import type { ToolDef } from "../types.js";
import { backgroundTaskTool } from "./background.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createGlobTool } from "./glob.js";
import { createGrepTool } from "./grep.js";
import { memoryTool } from "./memory.js";
import { createReadTool } from "./read.js";
import { todoTool } from "./todo.js";
import { createWriteTool } from "./write.js";

const SPILL_CAPS: Record<string, number> = {
  bash: 30 * 1024,
  read: 100 * 1024,
  grep: 20 * 1024,
  background_task: 30 * 1024,
};
const DEFAULT_SPILL_CAP = 30 * 1024;

// Post-process: oversized tool output spills to a file instead of flooding the context.
function withSpill(tool: ToolDef): ToolDef {
  const cap = SPILL_CAPS[tool.name] ?? DEFAULT_SPILL_CAP;
  return {
    ...tool,
    execute: async (id, input, signal) => {
      const result = await tool.execute(id, input, signal);
      return { ...result, content: spillCap(result.content, cap) };
    },
  };
}

/**
 * Built-in tools bound to a session working directory.
 * Relative paths in read/write/edit/grep/glob resolve against `cwd`.
 */
export function defaultTools(sessionId = "default", cwd = process.cwd()): ToolDef[] {
  return [
    createReadTool(cwd),
    createWriteTool(cwd),
    createEditTool(cwd),
    createBashTool(cwd),
    backgroundTaskTool,
    createGrepTool(cwd),
    createGlobTool(cwd),
    todoTool(sessionId),
    memoryTool(cwd),
  ].map(withSpill);
}

/** Read-only tool subset for explore-mode subagents. */
export const READ_ONLY_TOOL_NAMES = new Set([
  "read",
  "grep",
  "glob",
  "todo",
  "remember",
  "background_task",
  "web_search",
  "web_fetch",
]);

export function filterToolsByMode(tools: ToolDef[], mode: "explore" | "all"): ToolDef[] {
  if (mode === "all") return tools;
  // Explore: only known read-only built-ins (no write/edit/bash, no MCP side effects).
  return tools.filter((t) => READ_ONLY_TOOL_NAMES.has(t.name));
}

const compiled = new WeakMap<TSchema, TypeCheck<TSchema>>();

// Returns null when the input is valid, otherwise a human-readable validation message.
export function validateToolInput(tool: ToolDef, input: unknown): string | null {
  try {
    let check = compiled.get(tool.schema);
    if (!check) {
      check = TypeCompiler.Compile(tool.schema);
      compiled.set(tool.schema, check);
    }
    if (check.Check(input)) return null;
    const first = [...Value.Errors(tool.schema, input)][0];
    const detail = first ? `${first.path || "/"}: ${first.message}` : "does not match schema";
    return `Invalid input for tool ${tool.name}: ${detail}`;
  } catch {
    return null; // uncompilable schema: don't block execution
  }
}
