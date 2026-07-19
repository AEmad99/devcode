// Markdown slash commands / skills — registers every discovered skill as a
// /<name> command. Parsing, discovery, and the system-prompt index live in
// core/skills.ts (single source of truth); this extension just wires each
// skill to a slash command and provides /skills to list them.
//
// Also registers /memory — a first-class surface for inspecting and clearing
// the agent's persistent learnings (global + project). The actual writes go
// through the `remember` tool; this command is read-only / wipe-only.
//
// Sources (project wins on name clash), all discovered by core/skills.ts:
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
import { readFileSync, writeFileSync } from "node:fs";
import { expandSkillBody, loadAllSkills, loadSkill } from "../src/core/skills.js";
import { globalMemoryPath, projectMemoryPath } from "../src/core/memory.js";
import type { ExtensionAPI } from "devcode";

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export default function (api: ExtensionAPI) {
  const cwd = process.cwd();

  const reloadSkills = () => {
    // Re-read from disk so /reload picks up new skill files without a full
    // process restart. loadAllSkills is cheap (a few readdirSync calls).
    return loadAllSkills(cwd);
  };

  const skills = reloadSkills();

  for (const skill of skills) {
    api.registerCommand(skill.name, {
      description: skill.description,
      handler: async (args, ctx) => {
        // Re-read the file in case it was edited since discovery.
        const fresh = loadSkill(skill.path, skill.name);
        const body = fresh?.body ?? skill.body;
        ctx.sendUserMessage(expandSkillBody(body, args), { deliverAs: "followUp" });
      },
    });
  }

  api.registerCommand("skills", {
    description: "List available markdown skills/commands",
    handler: (_args, ctx) => {
      const list = reloadSkills();
      if (list.length === 0) {
        ctx.ui.notify("No skills in ~/.devcode/commands|skills or .devcode/commands|skills", "info");
        return;
      }
      ctx.ui.notify(
        `Skills (${list.length}):\n${list.map((s) => `/${s.name} — ${s.description}`).join("\n")}`,
        "info",
      );
    },
  });

  api.registerCommand("memory", {
    description: "Show the agent's persistent memory (/memory clear [global|project])",
    handler: (args, ctx) => {
      const a = args.trim().toLowerCase();
      const global = readFileSafe(globalMemoryPath()).trim();
      const project = readFileSafe(projectMemoryPath(cwd)).trim();

      if (a === "clear" || a.startsWith("clear")) {
        const which = a.split(/\s+/)[1] ?? "all";
        let cleared: string[] = [];
        if (which === "global" || which === "all") {
          if (global) {
            writeFileSync(globalMemoryPath(), "", "utf8");
            cleared.push("global");
          }
        }
        if (which === "project" || which === "all") {
          if (project) {
            writeFileSync(projectMemoryPath(cwd), "", "utf8");
            cleared.push("project");
          }
        }
        ctx.ui.notify(
          cleared.length
            ? `Cleared memory: ${cleared.join(", ")}`
            : "Nothing to clear (memory is empty)",
          "info",
        );
        return;
      }

      const lines: string[] = ["# Memory"];
      lines.push(
        global
          ? `## Global\n${global}`
          : "## Global\n(empty — ~/.devcode/memory.md)",
      );
      lines.push(
        project
          ? `## This project\n${project}`
          : `## This project\n(empty — .devcode/memory.md)`,
      );
      lines.push("");
      lines.push("Usage: /memory clear [global|project|all]");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // If the user edits a skill file mid-session, /reload refreshes commands by
  // re-running this factory.
}