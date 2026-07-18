import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDef } from "../types.js";
import {
  directoryPathError,
  displayToolPath,
  pathParamDescription,
  resolveToolPath,
} from "./path.js";

/** Parent dirs that need no mkdir (cwd / root / empty). */
function needsMkdir(dir: string): boolean {
  if (!dir) return false;
  // path.dirname("poem.txt") → "."  — never mkdir the cwd (Windows: EEXIST on mkdir '.')
  if (dir === "." || dir === "./" || dir === ".\\") return false;
  // Unix root / Windows drive root
  if (dir === "/" || /^[A-Za-z]:[\\/]?$/.test(dir)) return false;
  return true;
}

/**
 * @param cwd Session working directory. When omitted, uses process.cwd() on each call.
 */
export function createWriteTool(cwd?: string): ToolDef {
  const base = () => cwd ?? process.cwd();
  return {
    name: "write",
    description:
      "Create or overwrite a **file** with full contents (creates parent directories). " +
      "Paths are relative to the session working directory unless absolute. " +
      "Prefer edit for small changes to existing files. Prefer this over shell redirects (echo >, cat <<EOF). " +
      "Do not pass a directory path — path must be the target file.",
    schema: Type.Object({
      path: Type.String({ description: pathParamDescription("file") }),
      content: Type.String({ description: "Full file content to write" }),
    }),
    async execute(_id, input, _signal) {
      const root = base();
      const { path: rawPath, content } = input as { path: string; content: string };
      if (!rawPath || !String(rawPath).trim()) {
        return { content: "Failed to write: path is empty", is_error: true };
      }
      const path = resolveToolPath(rawPath, root);
      if (!path) {
        return { content: "Failed to write: path is empty", is_error: true };
      }
      const shown = displayToolPath(path, root);

      // Refuse to overwrite a directory name
      try {
        const st = await stat(path);
        if (st.isDirectory()) {
          return { content: directoryPathError(path, root), is_error: true };
        }
      } catch {
        // does not exist yet — fine for write
      }

      try {
        const dir = dirname(path);
        if (needsMkdir(dir)) {
          await mkdir(dir, { recursive: true });
        }
        await writeFile(path, content, "utf8");
      } catch (err) {
        return {
          content: `Failed to write ${shown}: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }
      return { content: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${shown}` };
    },
  };
}

/** Default instance: resolves relative paths against process.cwd() each call. */
export const writeTool: ToolDef = createWriteTool();
