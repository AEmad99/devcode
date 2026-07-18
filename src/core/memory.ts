import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { home } from "./paths.js";

// Persistent curated memory: the agent records durable learnings with the
// `remember` tool; loadMemory() injects them into the system prompt at
// session start (self-improvement loop).
const MEMORY_CAP = 32 * 1024;

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

export function appendLearning(path: string, learning: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = `- ${learning.replace(/\s*\n\s*/g, " ").trim()}\n`;
  appendFileSync(path, line, "utf8");
}
