import { stat } from "node:fs/promises";
import { relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDef } from "../types.js";
import { displayToolPath, pathParamDescription, resolveToolPath } from "./path.js";

const MAX_FILES = 200;

/**
 * @param cwd Session working directory. When omitted, uses process.cwd() on each call.
 */
export function createGlobTool(cwd?: string): ToolDef {
  const base = () => cwd ?? process.cwd();
  return {
    name: "glob",
    description:
      "Find files matching a glob pattern under a directory (default: session working directory). " +
      "Returns paths sorted by modification time, newest first. " +
      "Use this to explore directories — never use read on a directory. Prefer this over shell find/ls for discovery.",
    schema: Type.Object({
      pattern: Type.String({
        description: 'Glob pattern relative to path, e.g. "**/*.ts" or "src/**/*.tsx"',
      }),
      path: Type.Optional(Type.String({ description: pathParamDescription("dir") })),
    }),
    async execute(_id, input, _signal) {
      const root = base();
      const { pattern, path: rawPath } = input as { pattern: string; path?: string };
      if (!pattern || !String(pattern).trim()) {
        return { content: "glob failed: pattern is empty", is_error: true };
      }
      const searchRoot = rawPath ? resolveToolPath(rawPath, root) : root;
      if (!searchRoot) {
        return { content: "glob failed: path is empty", is_error: true };
      }
      const found: { rel: string; mtime: number }[] = [];
      try {
        for await (const file of new Bun.Glob(pattern).scan({
          cwd: searchRoot,
          absolute: true,
          onlyFiles: true,
        })) {
          let mtime = 0;
          try {
            mtime = (await stat(file)).mtimeMs;
          } catch {
            continue;
          }
          found.push({ rel: relative(searchRoot, file).replace(/\\/g, "/"), mtime });
        }
      } catch (err) {
        return {
          content: `glob failed under ${displayToolPath(searchRoot, root)}: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }
      if (found.length === 0) {
        return {
          content: `No files matched pattern "${pattern}" under ${displayToolPath(searchRoot, root)}`,
        };
      }
      found.sort((a, b) => b.mtime - a.mtime);
      const shown = found.slice(0, MAX_FILES);
      let out = shown.map((f) => f.rel).join("\n");
      if (found.length > MAX_FILES) out += `\n[truncated: showing ${MAX_FILES} of ${found.length} files]`;
      return { content: out };
    },
  };
}

/** Default instance: resolves relative paths against process.cwd() each call. */
export const globTool: ToolDef = createGlobTool();
