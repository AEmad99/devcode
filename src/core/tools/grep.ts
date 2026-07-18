import { relative } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDef } from "../types.js";
import { displayToolPath, pathParamDescription, resolveToolPath } from "./path.js";

const DEFAULT_IGNORES = new Set(["node_modules", ".git", "dist", "build"]);
const MAX_MATCHES = 100;

function isIgnored(relPath: string): boolean {
  return relPath.split("/").some((seg) => DEFAULT_IGNORES.has(seg));
}

/**
 * @param cwd Session working directory. When omitted, uses process.cwd() on each call.
 */
export function createGrepTool(cwd?: string): ToolDef {
  const base = () => cwd ?? process.cwd();
  return {
    name: "grep",
    description:
      "Search file contents with a regular expression under a directory (default: session working directory). " +
      "Returns `path:line:content` matches. Prefer this over shell grep/rg/findstr for code search.",
    schema: Type.Object({
      pattern: Type.String({ description: "Regular expression to search for" }),
      path: Type.Optional(Type.String({ description: pathParamDescription("dir") })),
      glob: Type.Optional(Type.String({ description: "Only search files matching this glob, e.g. *.ts" })),
      ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive matching (default false)" })),
    }),
    async execute(_id, input, _signal) {
      const root = base();
      const { pattern, path: rawPath, glob, ignore_case } = input as {
        pattern: string;
        path?: string;
        glob?: string;
        ignore_case?: boolean;
      };
      let re: RegExp;
      try {
        re = new RegExp(pattern, ignore_case ? "i" : "");
      } catch (err) {
        return { content: `Invalid regex: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
      }

      const searchRoot = rawPath ? resolveToolPath(rawPath, root) : root;
      if (!searchRoot) {
        return { content: "grep failed: path is empty", is_error: true };
      }
      const matches: string[] = [];
      let hitCap = false;
      try {
        outer: for await (const file of new Bun.Glob(glob ?? "**/*").scan({
          cwd: searchRoot,
          absolute: true,
          onlyFiles: true,
        })) {
          const rel = relative(searchRoot, file).replace(/\\/g, "/");
          if (isIgnored(rel)) continue;
          let text: string;
          try {
            text = await Bun.file(file).text();
          } catch {
            continue; // unreadable file: skip
          }
          if (text.includes("\0")) continue; // binary file: skip
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              matches.push(`${rel}:${i + 1}:${lines[i]}`);
              if (matches.length >= MAX_MATCHES) {
                hitCap = true;
                break outer;
              }
            }
          }
        }
      } catch (err) {
        return {
          content: `grep failed under ${displayToolPath(searchRoot, root)}: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }

      if (matches.length === 0) {
        return {
          content: `No matches found under ${displayToolPath(searchRoot, root)}`,
        };
      }
      let out = matches.join("\n");
      if (hitCap) out += `\n[truncated: first ${MAX_MATCHES} matches shown]`;
      return { content: out };
    },
  };
}

/** Default instance: resolves relative paths against process.cwd() each call. */
export const grepTool: ToolDef = createGrepTool();
