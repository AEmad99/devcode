import { Type } from "@sinclair/typebox";
import type { ToolDef } from "../types.js";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

const stores = new Map<string, TodoItem[]>();

// Read by the TUI to render the current checklist.
export function getTodos(sessionId: string): TodoItem[] {
  return stores.get(sessionId) ?? [];
}

const ICONS: Record<TodoItem["status"], string> = { pending: "☐", in_progress: "◐", completed: "✓" };

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "Todo list cleared.";
  return todos
    .map((t) => `${ICONS[t.status]} ${t.status === "in_progress" && t.activeForm ? t.activeForm : t.content}`)
    .join("\n");
}

export function todoTool(sessionId = "default"): ToolDef {
  return {
    name: "todo",
    description:
      "Track multi-step work as a checklist. Each call rewrites the full list; exactly one item may be in_progress.",
    schema: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({ description: "Task description (imperative form)" }),
          status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
          activeForm: Type.Optional(Type.String({ description: "Present-tense label shown while in_progress" })),
        }),
      ),
    }),
    async execute(_id, input, _signal) {
      const { todos } = input as { todos: TodoItem[] };
      if (todos.filter((t) => t.status === "in_progress").length > 1) {
        return { content: "Invalid todo list: exactly one item may be in_progress", is_error: true };
      }
      stores.set(sessionId, todos);
      return { content: renderTodos(todos) };
    },
  };
}
