import { readFile, stat, writeFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import type { ToolDef } from "../types.js";
import {
  directoryPathError,
  displayToolPath,
  missingPathError,
  pathParamDescription,
  resolveToolPath,
} from "./path.js";

/**
 * @param cwd Session working directory. When omitted, uses process.cwd() on each call.
 */
export function createEditTool(cwd?: string): ToolDef {
  const base = () => cwd ?? process.cwd();
  return {
    name: "edit",
    description:
      "Replace an exact string in an existing **file**. old_string must match exactly once unless replace_all is set. " +
      "Always read the file first and copy the exact text (including indentation). " +
      "Paths are relative to the session working directory unless absolute. Prefer this over shell sed.",
    schema: Type.Object({
      path: Type.String({ description: pathParamDescription("file") }),
      old_string: Type.String({ description: "Exact text to replace (must match the file byte-for-byte)" }),
      new_string: Type.String({ description: "Replacement text" }),
      replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence (default false)" })),
    }),
    async execute(_id, input, _signal) {
      const root = base();
      const { path: rawPath, old_string, new_string, replace_all } = input as {
        path: string;
        old_string: string;
        new_string: string;
        replace_all?: boolean;
      };
      if (!rawPath || !String(rawPath).trim()) {
        return { content: "Failed to edit: path is empty", is_error: true };
      }
      if (old_string.length === 0) {
        return { content: "old_string must not be empty", is_error: true };
      }
      if (old_string === new_string) {
        return { content: "old_string and new_string are identical; nothing to change", is_error: true };
      }

      const path = resolveToolPath(rawPath, root);
      if (!path) {
        return { content: "Failed to edit: path is empty", is_error: true };
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

      const count = text.split(old_string).length - 1;
      if (count === 0) {
        return {
          content: `String not found in ${shown}. Re-read the file and copy the exact text including indentation.`,
          is_error: true,
        };
      }
      if (count > 1 && !replace_all) {
        return {
          content: `Found ${count} matches for old_string in ${shown}. Provide more surrounding context or set replace_all to true.`,
          is_error: true,
        };
      }

      const replaced = replace_all ? count : 1;
      const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, new_string);
      await writeFile(path, next, "utf8");
      return { content: `Edited ${shown}: replaced ${replaced} occurrence(s)` };
    },
  };
}

/** Default instance: resolves relative paths against process.cwd() each call. */
export const editTool: ToolDef = createEditTool();
