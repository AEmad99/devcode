/**
 * Markdown skills / custom commands with optional YAML frontmatter.
 * Progressive disclosure: short descriptions go into the system prompt;
 * full body is injected only when the user runs /name.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { home } from "./paths.js";

export interface SkillMeta {
  name: string;
  description: string;
  /** Absolute path to the markdown file. */
  path: string;
  /** Full body without frontmatter. */
  body: string;
  /** Optional allow-tools hint from frontmatter (informational). */
  allowedTools?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Minimal YAML-ish frontmatter: key: value lines only. */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    let val = line.slice(colon + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) meta[key] = val;
  }
  return { meta, body: m[2] };
}

function scanDir(dir: string): { name: string; path: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { name: string; path: string }[] = [];
  for (const n of names) {
    const full = join(dir, n);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isFile() && n.endsWith(".md")) {
      const name = n.replace(/\.md$/i, "").toLowerCase();
      if (/^[a-z0-9][a-z0-9_-]*$/.test(name)) out.push({ name, path: full });
    } else if (st.isDirectory()) {
      // SKILL.md folder layout
      for (const idx of ["SKILL.md", "skill.md"]) {
        const skillPath = join(full, idx);
        if (existsSync(skillPath)) {
          const name = n.toLowerCase();
          if (/^[a-z0-9][a-z0-9_-]*$/.test(name)) out.push({ name, path: skillPath });
          break;
        }
      }
    }
  }
  return out;
}

export function discoverSkillFiles(cwd: string): { name: string; path: string }[] {
  const found = new Map<string, string>(); // name → path; project wins
  for (const e of scanDir(join(home(), "commands"))) found.set(e.name, e.path);
  for (const e of scanDir(join(home(), "skills"))) found.set(e.name, e.path);
  for (const e of scanDir(join(cwd, ".devcode", "commands"))) found.set(e.name, e.path);
  for (const e of scanDir(join(cwd, ".devcode", "skills"))) found.set(e.name, e.path);
  return [...found.entries()].map(([name, path]) => ({ name, path }));
}

export function loadSkill(path: string, fallbackName: string): SkillMeta | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  const name = (meta.name ?? fallbackName).toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!name) return null;
  const description =
    meta.description?.trim() ||
    body
      .trim()
      .split(/\r?\n/)
      .find((l) => l.trim().length > 0)
      ?.replace(/^#+\s*/, "")
      .slice(0, 120) ||
    `Custom command from ${path.replace(/\\/g, "/")}`;
  return {
    name,
    description,
    path,
    body: body.trimStart(),
    allowedTools: meta["allowed-tools"] ?? meta.allowedtools,
  };
}

export function loadAllSkills(cwd: string): SkillMeta[] {
  const skills: SkillMeta[] = [];
  for (const f of discoverSkillFiles(cwd)) {
    const s = loadSkill(f.path, f.name);
    if (s) skills.push(s);
  }
  return skills;
}

/** Compact system-prompt section so the model knows which /skills exist. */
export function formatSkillsIndex(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";
  const lines = [
    "# Available skills (user slash commands)",
    "The user can invoke these with /name. When relevant, suggest the matching skill.",
  ];
  for (const s of skills) {
    lines.push(`- /${s.name} — ${s.description}`);
  }
  return lines.join("\n");
}

export function expandSkillBody(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", args);
  if (args.trim()) return `${body.trimEnd()}\n\n${args}`;
  return body;
}
