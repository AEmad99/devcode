import { Type } from "@sinclair/typebox";
import { appendLearning, memoryPath } from "../memory.js";
import type { ToolDef } from "../types.js";

// Self-improvement: record a durable learning to persistent memory. Entries
// are injected into the system prompt at the start of future sessions.
export function memoryTool(cwd: string): ToolDef {
  return {
    name: "remember",
    description:
      "Record a durable learning to persistent memory (user preference, correction, project convention, pitfall). " +
      "Use scope 'project' for repo-specific facts, 'global' for cross-project ones. Injected into future sessions; never store secrets or transient task state.",
    schema: Type.Object({
      learning: Type.String({ description: "One short factual entry to remember" }),
      scope: Type.Optional(
        Type.Union([Type.Literal("global"), Type.Literal("project")], {
          description: "Where to store it (default: project)",
        }),
      ),
    }),
    async execute(_id, input, _signal) {
      const { learning, scope = "project" } = input as { learning: string; scope?: "global" | "project" };
      if (!learning.trim()) return { content: "Nothing to remember: learning is empty", is_error: true };
      const path = memoryPath(scope, cwd);
      try {
        appendLearning(path, learning);
      } catch (err) {
        return { content: `Failed to remember: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
      return { content: `Remembered (${scope}) in ${path}` };
    },
  };
}
