import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { home } from "./paths.js";

// Persistent curated memory: the agent records durable learnings with the
// `remember` tool; loadMemory() injects them into the system prompt at
// session start (self-improvement loop).
const MEMORY_CAP = 32 * 1024;

/**
 * Optional classification tag for a learning. Surfaced in the system prompt so
 * the model can weight pitfalls higher than generic facts. Purely advisory —
 * no schema enforcement on the stored markdown.
 */
export type MemoryKind = "preference" | "convention" | "pitfall" | "fact";

export const MEMORY_KINDS: MemoryKind[] = ["preference", "convention", "pitfall", "fact"];

export function globalMemoryPath(): string {
  return join(home(), "memory.md");
}

export function projectMemoryPath(cwd: string): string {
  return join(cwd, ".devcode", "memory.md");
}

export function memoryPath(scope: "global" | "project", cwd: string): string {
  return scope === "global" ? globalMemoryPath() : projectMemoryPath(cwd);
}

export function loadMemory(cwd: string): string {
  const parts: string[] = [];
  const read = (path: string, label: string): void => {
    let text: string;
    try {
      text = readFileSync(path, "utf8").trim();
    } catch {
      return; // missing/unreadable memory is fine
    }
    if (text) parts.push(`## ${label}\n${text}`);
  };
  read(globalMemoryPath(), "Global");
  read(projectMemoryPath(cwd), "This project");
  const joined = parts.join("\n\n");
  return joined.length > MEMORY_CAP ? `${joined.slice(0, MEMORY_CAP)}\n… (memory truncated)` : joined;
}

/** Append a durable learning as a single bullet line. */
export function appendLearning(path: string, learning: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = `- ${learning.replace(/\s*\n\s*/g, " ").trim()}\n`;
  appendFileSync(path, line, "utf8");
}

/**
 * Remove the first learning whose text contains the given substring. Returns
 * true when a line was removed. Keeps the file's ordering and other entries
 * intact. The match is case-insensitive on the substring.
 */
export function forgetLearning(path: string, needle: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const lines = raw.split("\n");
  const lower = needle.toLowerCase();
  let removed = false;
  const next = lines.filter((line) => {
    if (removed) return true;
    const trimmed = line.trim();
    // Only match bullet lines that contain the needle.
    if (trimmed.startsWith("- ") && trimmed.toLowerCase().includes(lower)) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) return false;
  writeFileSync(path, next.join("\n").replace(/\n{3,}/g, "\n\n"), "utf8");
  return true;
}

/**
 * Replace the first learning whose text contains `find` with `replacement`.
 * Useful for self-correcting an outdated entry without wipe+reappend. Returns
 * true on a successful replacement, false when no match was found.
 */
export function updateLearning(path: string, find: string, replacement: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const lines = raw.split("\n");
  const lower = find.toLowerCase();
  let done = false;
  const next = lines.map((line) => {
    if (done) return line;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") && trimmed.toLowerCase().includes(lower)) {
      done = true;
      return `- ${replacement.replace(/\s*\n\s*/g, " ").trim()}`;
    }
    return line;
  });
  if (!done) return false;
  writeFileSync(path, next.join("\n"), "utf8");
  return true;
}

/** Format a learning line with an optional `[kind]` prefix. */
export function formatLearning(learning: string, kind?: MemoryKind): string {
  const body = learning.replace(/\s*\n\s*/g, " ").trim();
  if (kind && MEMORY_KINDS.includes(kind) && kind !== "fact") {
    return `[${kind}] ${body}`;
  }
  return body;
}
