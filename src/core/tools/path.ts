/**
 * Shared path handling for file tools (read / write / edit / grep / glob).
 * Models often pass quoted paths, ~, file:// URLs, mixed separators, or
 * Windows backslashes that break JSON — we normalize before any fs call.
 */

import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

/** Strip quotes / file:// / expand ~; leave relative vs absolute as-is. */
export function cleanToolPath(raw: string): string {
  let p = String(raw ?? "").trim();
  if (!p) return "";

  // Surrounding quotes the model sometimes includes in the path value
  if (
    (p.startsWith('"') && p.endsWith('"') && p.length >= 2) ||
    (p.startsWith("'") && p.endsWith("'") && p.length >= 2)
  ) {
    p = p.slice(1, -1).trim();
  }

  // file:// and file:///C:/… URLs
  if (/^file:\/\//i.test(p)) {
    p = decodeURIComponent(p.replace(/^file:\/\//i, ""));
    // file:///C:/Users/... → /C:/Users/... → C:/Users/...
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  }

  // Home directory
  if (p === "~") {
    p = homedir();
  } else if (p.startsWith("~/") || p.startsWith("~\\")) {
    p = homedir() + p.slice(1);
  }

  // Normalize separators so resolve() is consistent (Node accepts / on Windows)
  if (sep === "\\") {
    p = p.replace(/\//g, "\\");
  }

  return p;
}

/**
 * Resolve a tool path to an absolute filesystem path against `cwd`.
 * Empty input stays empty (caller should error).
 */
export function resolveToolPath(raw: string, cwd: string = process.cwd()): string {
  const cleaned = cleanToolPath(raw);
  if (!cleaned) return "";
  const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
  return normalize(abs);
}

/** Path for tool results / model feedback: prefer cwd-relative with `/`. */
export function displayToolPath(absOrRel: string, cwd: string = process.cwd()): string {
  if (!absOrRel) return absOrRel;
  try {
    const abs = isAbsolute(absOrRel) ? absOrRel : resolve(cwd, absOrRel);
    const rel = relative(cwd, abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      return rel.replace(/\\/g, "/") || ".";
    }
    return abs.replace(/\\/g, "/");
  } catch {
    return absOrRel.replace(/\\/g, "/");
  }
}

/** Shared path-parameter description for tool schemas. */
export function pathParamDescription(kind: "file" | "dir" = "file"): string {
  if (kind === "dir") {
    return (
      "Directory to search, absolute or relative to the session working directory (cwd). " +
      "Prefer forward slashes (src/foo) even on Windows. Do not wrap in quotes."
    );
  }
  return (
    "File path, absolute or relative to the session working directory (cwd). " +
    "Prefer forward slashes (src/foo.ts) even on Windows. Do not wrap in quotes. " +
    "Must be a file, not a directory — use glob to list directory contents."
  );
}

/** Actionable error when a path points at a directory instead of a file. */
export function directoryPathError(resolved: string, cwd: string): string {
  const shown = displayToolPath(resolved, cwd);
  return (
    `${shown} is a directory, not a file. ` +
    `Do not use read/write/edit on directories. ` +
    `Use glob (pattern "**/*", path "${shown}") to list files, then read a specific file path.`
  );
}

/** Actionable error when a file path does not exist. */
export function missingPathError(resolved: string, cwd: string, what = "File"): string {
  const shown = displayToolPath(resolved, cwd);
  return (
    `${what} not found: ${shown} ` +
    `(resolved under cwd: ${cwd.replace(/\\/g, "/")}). ` +
    `Paths are relative to the working directory. Use glob to locate the correct path.`
  );
}
