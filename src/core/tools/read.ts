import { readFile, stat } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import type { ToolDef } from "../types.js";
import {
  directoryPathError,
  displayToolPath,
  missingPathError,
  pathParamDescription,
  resolveToolPath,
} from "./path.js";

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;

/**
 * @param cwd Session working directory. When omitted, uses process.cwd() on each call.
 */
export function createReadTool(cwd?: string): ToolDef {
  const base = () => cwd ?? process.cwd();
  return {
    name: "read",
    description:
      "Read a UTF-8 text **file** (not a directory). Returns lines numbered `N\\t<line>`. " +
      "Paths are relative to the session working directory unless absolute. " +
      "Use offset/limit to page large files. Prefer this over shell cat/type/Get-Content. " +
      "To list a directory, use glob — never pass a directory path here.",
    schema: Type.Object({
      path: Type.String({ description: pathParamDescription("file") }),
      offset: Type.Optional(Type.Number({ description: "1-based line number to start reading from" })),
      limit: Type.Optional(Type.Number({ description: `Max lines to return (default ${DEFAULT_LIMIT})` })),
    }),
    async execute(_id, input, _signal) {
      const root = base();
      const { path: rawPath, offset, limit } = input as { path: string; offset?: number; limit?: number };
      if (!rawPath || !String(rawPath).trim()) {
        return { content: "Failed to read: path is empty", is_error: true };
      }
      const path = resolveToolPath(rawPath, root);
      if (!path) {
        return { content: "Failed to read: path is empty", is_error: true };
      }
      const shown = displayToolPath(path, root);

      try {
        const st = await stat(path);
        if (st.isDirectory()) {
          return { content: directoryPathError(path, root), is_error: true };
        }
      } catch {
        return { content: missingPathError(path, root), is_error: true };
      }

      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (err) {
        return {
          content: `Failed to read ${shown}: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }

      const lines = text.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const total = lines.length;

      const start = Math.max(1, Math.floor(offset ?? 1));
      const maxLines = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
      const slice = lines.slice(start - 1, start - 1 + maxLines);
      const numbered = slice.map(
        (line, i) => `${start + i}\t${line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line}`,
      );

      let out = numbered.join("\n");
      const end = start + slice.length - 1;
      if (slice.length > 0 && (start > 1 || end < total)) {
        out += `\n[truncated: showing ${start}-${end} of ${total} lines]`;
      }
      return { content: out };
    },
  };
}

/** Default instance: resolves relative paths against process.cwd() each call. */
export const readTool: ToolDef = createReadTool();
