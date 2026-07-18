import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Max bytes of project instructions injected into the system prompt. */
export const PROJECT_INSTRUCTIONS_CAP = 32 * 1024;

/**
 * Candidate files at the project root (and `.devcode/`), first match wins per
 * slot; all found files are concatenated in this order.
 */
const CANDIDATES: { path: (cwd: string) => string; label: string }[] = [
  { path: (cwd) => join(cwd, "AGENTS.md"), label: "AGENTS.md" },
  { path: (cwd) => join(cwd, "Agents.md"), label: "Agents.md" },
  { path: (cwd) => join(cwd, "CLAUDE.md"), label: "CLAUDE.md" },
  { path: (cwd) => join(cwd, ".devcode", "instructions.md"), label: ".devcode/instructions.md" },
];

export interface ProjectInstructions {
  /** Combined markdown for the system prompt, or empty if none found. */
  text: string;
  /** Which files contributed (relative labels). */
  sources: string[];
}

/**
 * Load project-local instruction files (AGENTS.md / CLAUDE.md / …).
 * Soft-fails on missing or unreadable files. Caps total size.
 */
export function loadProjectInstructions(cwd: string): ProjectInstructions {
  const parts: string[] = [];
  const sources: string[] = [];
  // Prefer AGENTS.md over Agents.md (don't load both). On case-insensitive
  // filesystems both paths resolve to the same inode — track by real path.
  const seenPaths = new Set<string>();
  let sawAgents = false;
  for (const c of CANDIDATES) {
    if (c.label === "Agents.md" && sawAgents) continue;
    const full = c.path(cwd);
    if (!existsSync(full)) continue;
    const key = full.replace(/\\/g, "/").toLowerCase();
    if (seenPaths.has(key)) continue;
    let body: string;
    try {
      body = readFileSync(full, "utf8").trim();
    } catch {
      continue;
    }
    if (!body) continue;
    seenPaths.add(key);
    if (c.label === "AGENTS.md" || c.label === "Agents.md") sawAgents = true;
    sources.push(c.label);
    parts.push(`## ${c.label}\n${body}`);
  }
  let text = parts.join("\n\n");
  if (text.length > PROJECT_INSTRUCTIONS_CAP) {
    text = `${text.slice(0, PROJECT_INSTRUCTIONS_CAP)}\n… (project instructions truncated)`;
  }
  return { text, sources };
}
