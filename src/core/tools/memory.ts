import { Type } from "@sinclair/typebox";
import {
  appendLearning,
  forgetLearning,
  formatLearning,
  MEMORY_KINDS,
  memoryPath,
  updateLearning,
} from "../memory.js";
import type { ToolDef } from "../types.js";

// Self-improvement: record, revise, or remove a durable learning in persistent
// memory. Entries are injected into the system prompt at the start of future
// sessions. The agent can self-correct: when the user corrects it or a
// learning turns out to be wrong, use action=forget or action=update.
export function memoryTool(cwd: string): ToolDef {
  return {
    name: "remember",
    description:
      "Manage persistent memory (user preferences, project conventions, pitfalls, facts). " +
      "action=remember (default) appends a learning. action=forget removes the first entry " +
      "matching `find` (substring, case-insensitive). action=update replaces the entry " +
      "matching `find` with `learning`. scope: project (default) for repo-specific facts, " +
      "global for cross-project. kind tags the entry (preference|convention|pitfall|fact). " +
      "Never store secrets or transient task state.",
    schema: Type.Object({
      learning: Type.String({
        description:
          "The learning text to store (action=remember|update). For action=forget this is ignored.",
      }),
      action: Type.Optional(
        Type.Union(
          [Type.Literal("remember"), Type.Literal("forget"), Type.Literal("update")],
          {
            description: "Operation: remember (default), forget, or update",
            default: "remember",
          },
        ),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("global"), Type.Literal("project")], {
          description: "Where to store/look (default: project)",
        }),
      ),
      kind: Type.Optional(
        Type.Union(
          MEMORY_KINDS.map((k) => Type.Literal(k)),
          {
            description: "Optional classification: preference|convention|pitfall|fact (default fact)",
          },
        ),
      ),
      find: Type.Optional(
        Type.String({
          description:
            "Substring to match an existing entry (action=forget|update). Case-insensitive.",
        }),
      ),
    }),
    async execute(_id, input, _signal) {
      const {
        learning,
        action = "remember",
        scope = "project",
        kind,
        find,
      } = input as {
        learning: string;
        action?: "remember" | "forget" | "update";
        scope?: "global" | "project";
        kind?: import("../memory.js").MemoryKind;
        find?: string;
      };
      const path = memoryPath(scope, cwd);

      try {
        if (action === "forget") {
          const needle = (find ?? learning ?? "").trim();
          if (!needle) return { content: "forget needs a `find` substring to match", is_error: true };
          const removed = forgetLearning(path, needle);
          return removed
            ? { content: `Forgot matching entry (${scope}) in ${path}` }
            : { content: `No matching entry in ${path} — nothing forgotten`, is_error: true };
        }

        if (action === "update") {
          const needle = (find ?? "").trim();
          const replacement = (learning ?? "").trim();
          if (!needle || !replacement) {
            return { content: "update needs both `find` (existing substring) and `learning` (replacement)", is_error: true };
          }
          const ok = updateLearning(path, needle, formatLearning(replacement, kind));
          return ok
            ? { content: `Updated entry (${scope}) in ${path}` }
            : { content: `No matching entry for "${needle}" in ${path}`, is_error: true };
        }

        // remember (default)
        const body = (learning ?? "").trim();
        if (!body) return { content: "Nothing to remember: learning is empty", is_error: true };
        appendLearning(path, formatLearning(body, kind));
        return { content: `Remembered (${scope}) in ${path}` };
      } catch (err) {
        return { content: `Failed to update memory: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }
    },
  };
}