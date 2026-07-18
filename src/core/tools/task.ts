import { Type } from "@sinclair/typebox";
import type { Provider } from "../../providers/types.js";
import { Emitter } from "../events.js";
import { runAgentLoop } from "../loop.js";
import type { AgentEvent, Message, ToolDef, Usage } from "../types.js";
import { createTaskWorktree } from "../worktree.js";
export type TaskMode = "explore" | "all";

const EXPLORE_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "todo",
  "remember",
  "background_task",
  "web_search",
  "web_fetch",
]);

function filterByMode(tools: ToolDef[], mode: TaskMode): ToolDef[] {
  if (mode === "all") return tools;
  return tools.filter((t) => EXPLORE_TOOLS.has(t.name));
}

export interface TaskToolDeps {
  provider: Provider;
  system: string;
  /** Tools available to the subagent (must not include `task` itself). */
  subTools: (cwd?: string) => ToolDef[];
  maxTurns?: number;
  thinking?: import("../thinking.js").ThinkingLevel;
  /**
   * Resolve a provider for an optional model override.
   * When omitted, model overrides are ignored (same provider/model as parent).
   */
  resolveProvider?: (model: string) => Provider;
  /** Parent event sink for live subagent progress (tool_start/end, text). */
  onEvent?: (ev: AgentEvent) => void;
  /** Parent working directory (default process.cwd()). */
  cwd?: string;
}

/**
 * Nested agent loop tool. Runs a fresh message history so the outer loop
 * control flow stays untouched (AGENTS.md invariant 3).
 */
export function taskTool(deps: TaskToolDeps): ToolDef {
  return {
    name: "task",
    description:
      "Delegate a sub-task to a nested agent. " +
      'mode "explore" (default for research) is read-only; mode "all" allows writes. ' +
      "Optional model override, worktree isolation, and live progress in the parent UI. " +
      "Returns the subagent's final text.",
    schema: Type.Object({
      prompt: Type.String({ description: "Instructions for the subagent" }),
      description: Type.Optional(Type.String({ description: "Short label for the task (UI only)" })),
      mode: Type.Optional(
        Type.Union([Type.Literal("explore"), Type.Literal("all")], {
          description: 'Tool profile: "explore" = read-only (default), "all" = full tools except nested task',
        }),
      ),
      model: Type.Optional(Type.String({ description: "Optional model id override for this subagent" })),
      worktree: Type.Optional(
        Type.Boolean({
          description: "Run in an isolated git worktree (edits stay out of the main tree)",
        }),
      ),
    }),
    async execute(_id, input, signal) {
      const {
        prompt,
        description,
        mode: modeRaw,
        model: modelOverride,
        worktree: useWorktree,
      } = input as {
        prompt: string;
        description?: string;
        mode?: string;
        model?: string;
        worktree?: boolean;
      };
      if (!prompt?.trim()) return { content: "prompt is required", is_error: true };

      const mode: TaskMode = modeRaw === "all" ? "all" : "explore";
      const label = description?.trim() ? description.trim() : "task";
      const parentCwd = deps.cwd ?? process.cwd();

      let worktreePath: string | undefined;
      let disposeWorktree: (() => void) | undefined;
      if (useWorktree) {
        try {
          const wt = createTaskWorktree(parentCwd, label);
          worktreePath = wt.path;
          disposeWorktree = () => wt.dispose();
        } catch (err) {
          return {
            content: `Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          };
        }
      }

      const cwd = worktreePath ?? parentCwd;
      let provider = deps.provider;
      if (modelOverride?.trim()) {
        if (!deps.resolveProvider) {
          if (disposeWorktree) disposeWorktree();
          return {
            content: "model override requested but no resolveProvider is configured",
            is_error: true,
          };
        }
        try {
          provider = deps.resolveProvider(modelOverride.trim());
        } catch (err) {
          if (disposeWorktree) disposeWorktree();
          return {
            content: `Failed to resolve model "${modelOverride}": ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          };
        }
      }

      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }] }];
      const events = new Emitter();
      let lastUsage: Usage | undefined;
      events.on("turn_end", (e) => {
        lastUsage = e.usage;
      });

      // Forward progress to parent UI with a task: prefix on tool names.
      const prefix = `task:${label}`;
      const forward = (ev: AgentEvent): void => {
        if (!deps.onEvent) return;
        if (ev.type === "tool_start") {
          deps.onEvent({ ...ev, name: `${prefix}/${ev.name}` });
        } else if (ev.type === "tool_end") {
          deps.onEvent({ ...ev, name: `${prefix}/${ev.name}` });
        } else if (ev.type === "tool_use_start") {
          deps.onEvent({ ...ev, name: `${prefix}/${ev.name}` });
        } else if (ev.type === "text_delta") {
          // Keep parent transcript quiet; optional brief progress via tool events only.
        } else if (ev.type === "error") {
          deps.onEvent(ev);
        }
      };
      events.on("tool_start", forward);
      events.on("tool_end", forward);
      events.on("tool_use_start", forward);
      events.on("error", forward);

      // Exclude task to prevent unbounded recursion; apply mode filter.
      let tools = deps.subTools(cwd).filter((t) => t.name !== "task");
      tools = filterByMode(tools, mode);

      const modeNote =
        mode === "explore"
          ? "\n\n[subagent mode=explore: read-only tools only]"
          : "\n\n[subagent mode=all]";
      const system = deps.system + modeNote + (worktreePath ? `\n[worktree cwd: ${worktreePath}]` : "");

      try {
        const { stopReason } = await runAgentLoop({
          provider,
          system,
          messages,
          tools,
          events,
          signal,
          maxTurns: deps.maxTurns ?? 40,
          thinking: deps.thinking,
        });

        // Collect final assistant text from the nested history.
        let finalText = "";
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role !== "assistant") continue;
          const parts = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
          if (parts.length) {
            finalText = parts.join("");
            break;
          }
        }
        if (!finalText.trim()) finalText = `(subagent finished with stopReason=${stopReason}, no text)`;

        const u = lastUsage;
        const usage = u
          ? `\n\n[subagent (${label}) mode=${mode}${worktreePath ? " worktree" : ""} usage: in=${u.input} out=${u.output} stop=${stopReason}]`
          : `\n\n[subagent (${label}) mode=${mode}${worktreePath ? " worktree" : ""} stop=${stopReason}]`;

        if (worktreePath) {
          finalText += `\n\n[worktree path: ${worktreePath} — still present until disposed; inspect or merge manually if needed]`;
        }

        if (stopReason === "error" || stopReason === "aborted") {
          return { content: finalText + usage, is_error: true };
        }
        return { content: finalText + usage };
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          is_error: true,
        };
      } finally {
        // Keep worktree for inspect unless aborted; dispose on abort only.
        // Caller can re-run with worktree:false to edit main tree after reading results.
        if (signal.aborted && disposeWorktree) {
          try {
            disposeWorktree();
          } catch {
            /* */
          }
        }
      }
    },
  };
}
