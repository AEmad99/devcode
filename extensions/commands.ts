// Markdown slash commands / skills.
// Sources (project wins on name clash):
//   ~/.devcode/commands/*.md
//   ~/.devcode/skills/*/SKILL.md
//   <cwd>/.devcode/commands/*.md
//   <cwd>/.devcode/skills/*
//
// Optional YAML frontmatter:
//   ---
//   name: review
//   description: Review the current diff for bugs
//   allowed-tools: read,grep,bash
//   ---
// Body supports $ARGUMENTS substitution.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "devcode";

interface SkillMeta {
  name: string;
  description: string;
  path: string;
  body: string;
}

function home(): string {
  return process.env.DEVCODE_HOME ?? join(homedir(), ".devcode");
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
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

function discover(cwd: string): { name: string; path: string }[] {
  const found = new Map<string, string>();
  for (const e of scanDir(join(home(), "commands"))) found.set(e.name, e.path);
  for (const e of scanDir(join(home(), "skills"))) found.set(e.name, e.path);
  for (const e of scanDir(join(cwd, ".devcode", "commands"))) found.set(e.name, e.path);
  for (const e of scanDir(join(cwd, ".devcode", "skills"))) found.set(e.name, e.path);
  return [...found.entries()].map(([name, path]) => ({ name, path }));
}

function loadSkill(path: string, fallbackName: string): SkillMeta | null {
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
  return { name, description, path, body: body.trimStart() };
}

function expandBody(body: string, args: string): string {
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", args);
  if (args.trim()) return `${body.trimEnd()}\n\n${args}`;
  return body;
}

export default function (api: ExtensionAPI) {
  const cwd = process.cwd();
  const skills: SkillMeta[] = [];
  for (const f of discover(cwd)) {
    const s = loadSkill(f.path, f.name);
    if (s) skills.push(s);
  }

  for (const skill of skills) {
    api.registerCommand(skill.name, {
      description: skill.description,
      handler: async (args, ctx) => {
        let body = skill.body;
        const fresh = loadSkill(skill.path, skill.name);
        if (fresh) body = fresh.body;
        ctx.sendUserMessage(expandBody(body, args), { deliverAs: "followUp" });
      },
    });
  }

  api.registerCommand("skills", {
    description: "List available markdown skills/commands",
    handler: (_args, ctx) => {
      if (skills.length === 0) {
        ctx.ui.notify("No skills in ~/.devcode/commands|skills or .devcode/commands|skills", "info");
        return;
      }
      ctx.ui.notify(`Skills (${skills.length}):\n${skills.map((s) => `/${s.name} — ${s.description}`).join("\n")}`, "info");
    },
  });
}
