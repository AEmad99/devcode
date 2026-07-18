import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLearning, globalMemoryPath, loadMemory, projectMemoryPath } from "../src/core/memory.js";
import { buildSystemPrompt } from "../src/core/prompt.js";
import { memoryTool } from "../src/core/tools/memory.js";

let home: string;
let proj: string;

beforeAll(() => {
  home = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-mem-home-`);
  proj = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-mem-proj-`);
  process.env.DEVCODE_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
});
beforeEach(() => {
  rmSync(join(home, "memory.md"), { force: true });
  rmSync(join(proj, ".devcode"), { recursive: true, force: true });
});

const sig = () => new AbortController().signal;

describe("memory store", () => {
  test("appendLearning creates parent dirs and appends flattened bullets", () => {
    const path = projectMemoryPath(proj);
    appendLearning(path, "first learning");
    appendLearning(path, "multi\nline\nlearning");
    expect(readFileSync(path, "utf8")).toBe("- first learning\n- multi line learning\n");
  });

  test("loadMemory is empty when no memory files exist", () => {
    expect(loadMemory(proj)).toBe("");
  });

  test("loadMemory combines global and project memory under headers", () => {
    appendLearning(globalMemoryPath(), "user prefers pnpm");
    appendLearning(projectMemoryPath(proj), "repo uses bun");
    const mem = loadMemory(proj);
    expect(mem).toContain("## Global");
    expect(mem).toContain("- user prefers pnpm");
    expect(mem).toContain("## This project");
    expect(mem).toContain("- repo uses bun");
  });

  test("loadMemory truncates oversized memory with a marker", () => {
    writeFileSync(globalMemoryPath(), "x".repeat(40 * 1024), "utf8");
    const mem = loadMemory(proj);
    expect(mem.length).toBeLessThan(40 * 1024);
    expect(mem).toContain("(memory truncated)");
  });
});

describe("remember tool", () => {
  test("writes project scope by default, global on request", async () => {
    const tool = memoryTool(proj);
    const r1 = await tool.execute("1", { learning: "uses bun test" }, sig());
    expect(r1.is_error).toBeUndefined();
    expect(readFileSync(projectMemoryPath(proj), "utf8")).toContain("- uses bun test");
    expect(existsSync(globalMemoryPath())).toBe(false);

    const r2 = await tool.execute("2", { learning: "prefers dark themes", scope: "global" }, sig());
    expect(r2.is_error).toBeUndefined();
    expect(readFileSync(globalMemoryPath(), "utf8")).toContain("- prefers dark themes");

    const mem = loadMemory(proj);
    expect(mem).toContain("- uses bun test");
    expect(mem).toContain("- prefers dark themes");
  });

  test("rejects empty learnings without writing", async () => {
    const tool = memoryTool(proj);
    const res = await tool.execute("1", { learning: "   " }, sig());
    expect(res.is_error).toBe(true);
    expect(existsSync(projectMemoryPath(proj))).toBe(false);
  });
});

describe("system prompt", () => {
  const env = { cwd: proj, platform: "win32", shell: "bash", date: "2026-01-01", isGitRepo: true };

  test("always carries self-improvement instructions; memory section only when non-empty", () => {
    const bare = buildSystemPrompt(env);
    expect(bare).toContain("# Self-improvement");
    expect(bare).toContain("`remember`");
    expect(bare).not.toContain("# Memory");

    const withMem = buildSystemPrompt({ ...env, memory: "## Global\n- likes tests" });
    expect(withMem).toContain("# Memory");
    expect(withMem).toContain("- likes tests");
  });

  test("self-extension playbook names the docs, extension dirs, and reload tool", () => {
    const prompt = buildSystemPrompt({
      ...env,
      docsDir: "/docs",
      extGlobalDir: "/home/.devcode/extensions",
      extProjectDir: "/proj/.devcode/extensions",
    });
    expect(prompt).toContain("# Extending DevCode");
    expect(prompt).toContain("/docs/extensions.md");
    expect(prompt).toContain("/proj/.devcode/extensions");
    expect(prompt).toContain("/home/.devcode/extensions");
    expect(prompt).toContain("reload_extensions");
  });
});
