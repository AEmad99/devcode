import { Type } from "@sinclair/typebox";
import { killBackground, listBackground, readBackground } from "../background.js";
import type { ToolDef } from "../types.js";

export const backgroundTaskTool: ToolDef = {
  name: "background_task",
  description:
    "Inspect or control background shell jobs started with bash run_in_background. " +
    "Actions: list, read (id + optional offset), kill (id).",
  schema: Type.Object({
    action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("kill")], {
      description: "list | read | kill",
    }),
    id: Type.Optional(Type.String({ description: "Background task id (bg-N) for read/kill" })),
    offset: Type.Optional(Type.Number({ description: "Byte offset into the output buffer for read" })),
  }),
  async execute(_id, input) {
    const { action, id, offset } = input as { action: string; id?: string; offset?: number };
    if (action === "list") {
      const rows = listBackground();
      if (rows.length === 0) return { content: "No background tasks." };
      return {
        content: rows
          .map(
            (r) =>
              `${r.id} ${r.done ? `done exit=${r.exitCode}` : "running"} buf=${r.bufLen}B  ${r.command.slice(0, 120)}`,
          )
          .join("\n"),
      };
    }
    if (action === "read") {
      if (!id) return { content: "id is required for read", is_error: true };
      const r = readBackground(id, offset ?? 0);
      if (!r.ok) return { content: r.error, is_error: true };
      const header = r.done ? `[done exit=${r.exitCode}]\n` : "[running]\n";
      return { content: header + (r.text || "(no output yet)") };
    }
    if (action === "kill") {
      if (!id) return { content: "id is required for kill", is_error: true };
      const r = killBackground(id);
      if (!r.ok) return { content: r.error, is_error: true };
      return { content: r.message };
    }
    return { content: `Unknown action: ${action}`, is_error: true };
  },
};
