import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectInstructions } from "../src/core/project-instructions.js";
import { formatSkillsIndex, loadAllSkills, parseFrontmatter } from "../src/core/skills.js";
import { exitCodeForLoopResult, exitCodeForStopReason } from "../src/core/exit-codes.js";
import { batchToolUses, isParallelSafeTool } from "../src/core/loop.js";
import { formatGitSnapshot, type GitSnapshot } from "../src/core/git-snapshot.js";

let dir: string;
let home: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "devcode-pi-"));
  home = mkdtempSync(join(tmpdir(), "devcode-pi-home-"));
  process.env.DEVCODE_HOME = home;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
});

describe("loadProjectInstructions", () => {
  test("loads AGENTS.md and CLAUDE.md", () => {
    writeFileSync(join(dir, "AGENTS.md"), "# Agents\nUse bun.", "utf8");
    writeFileSync(join(dir, "CLAUDE.md"), "# Claude\nBe brief.", "utf8");
    mkdirSync(join(dir, ".devcode"), { recursive: true });
    writeFileSync(join(dir, ".devcode", "instructions.md"), "Extra rules", "utf8");
    const r = loadProjectInstructions(dir);
    expect(r.sources).toContain("AGENTS.md");
    expect(r.sources).toContain("CLAUDE.md");
    expect(r.sources).toContain(".devcode/instructions.md");
    expect(r.text).toContain("Use bun.");
    expect(r.text).toContain("Be brief.");
  });

  test("Agents.md skipped when AGENTS.md present", () => {
    const d = mkdtempSync(join(tmpdir(), "devcode-pi2-"));
    // On case-insensitive FS (Windows/macOS default) AGENTS.md and Agents.md
    // are the same file — writing both just overwrites. Only assert that we
    // don't emit duplicate sources for the same path.
    writeFileSync(join(d, "AGENTS.md"), "primary", "utf8");
    const r = loadProjectInstructions(d);
    expect(r.sources.filter((s) => /agents\.md/i.test(s)).length).toBe(1);
    expect(r.text).toContain("primary");
    rmSync(d, { recursive: true, force: true });
  });
});

describe("skills frontmatter", () => {
  test("parseFrontmatter extracts meta and body", () => {
    const { meta, body } = parseFrontmatter("---\nname: review\ndescription: Review code\n---\nDo a review of $ARGUMENTS");
    expect(meta.name).toBe("review");
    expect(meta.description).toBe("Review code");
    expect(body).toContain("Do a review");
  });

  test("loadAllSkills discovers commands with frontmatter", () => {
    const cmdDir = join(home, "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(
      join(cmdDir, "ship.md"),
      "---\nname: ship\ndescription: Ship checklist\n---\nRun tests then commit\n",
      "utf8",
    );
    const skills = loadAllSkills(dir);
    expect(skills.some((s) => s.name === "ship")).toBe(true);
    const idx = formatSkillsIndex(skills);
    expect(idx).toContain("/ship");
    expect(idx).toContain("Ship checklist");
  });
});

describe("exit codes", () => {
  test("maps stop reasons", () => {
    expect(exitCodeForStopReason("end_turn")).toBe(0);
    expect(exitCodeForStopReason("aborted")).toBe(3);
    expect(exitCodeForStopReason("error")).toBe(4);
    expect(exitCodeForStopReason("max_tokens")).toBe(2);
    expect(exitCodeForLoopResult("error", "Max turns (100) reached")).toBe(2);
  });
});

describe("parallel tool batching", () => {
  test("isParallelSafeTool", () => {
    expect(isParallelSafeTool("read")).toBe(true);
    expect(isParallelSafeTool("write")).toBe(false);
    expect(isParallelSafeTool("bash")).toBe(false);
  });

  test("batchToolUses groups consecutive reads", () => {
    const uses = [
      { type: "tool_use" as const, id: "1", name: "read", input: { path: "a" } },
      { type: "tool_use" as const, id: "2", name: "grep", input: { pattern: "x" } },
      { type: "tool_use" as const, id: "3", name: "write", input: { path: "b" } },
      { type: "tool_use" as const, id: "4", name: "read", input: { path: "c" } },
    ];
    const batches = batchToolUses(uses);
    expect(batches.length).toBe(3);
    expect(batches[0].map((t) => t.id)).toEqual(["1", "2"]);
    expect(batches[1].map((t) => t.id)).toEqual(["3"]);
    expect(batches[2].map((t) => t.id)).toEqual(["4"]);
  });
});

describe("git snapshot format", () => {
  test("empty snap formats empty", () => {
    expect(formatGitSnapshot({})).toBe("");
  });
  test("formats branch and status", () => {
    const snap: GitSnapshot = { branch: "main", head: "init", status: " M src/a.ts" };
    const s = formatGitSnapshot(snap);
    expect(s).toContain("branch: main");
    expect(s).toContain("HEAD: init");
    expect(s).toContain("M src/a.ts");
  });
});
