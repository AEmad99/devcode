import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Emitter } from "../src/core/events.js";
import { runAgentLoop } from "../src/core/loop.js";
import {
  clearReadOnlyNames,
  PermissionEngine,
  readOnlyToolNames,
  registerReadOnlyNames,
  wrapToolsWithPermissions,
} from "../src/core/permissions.js";
import {
  appendLearning,
  forgetLearning,
  globalMemoryPath,
  loadMemory,
  projectMemoryPath,
  updateLearning,
} from "../src/core/memory.js";
import { formatSkillsIndex, SKILLS_INDEX_CAP } from "../src/core/skills.js";
import { memoryTool } from "../src/core/tools/memory.js";
import {
  isParallelSafeToolName,
  isReadOnlyToolName,
  READ_ONLY_TOOL_NAMES,
} from "../src/core/tools/index.js";
import {
  isParallelSafeTool,
} from "../src/core/loop.js";
import type { Message, StreamEvent, ToolDef, Usage } from "../src/core/types.js";
import type { Provider } from "../src/providers/types.js";

// ---------------------------------------------------------------------------
// #1: unified read-only / parallel-safe classification
// ---------------------------------------------------------------------------

describe("unified tool classification", () => {
  test("single source of truth: built-in read-only names include reload_extensions", () => {
    expect(READ_ONLY_TOOL_NAMES.has("reload_extensions")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("read")).toBe(true);
    expect(READ_ONLY_TOOL_NAMES.has("write")).toBe(false);
    expect(READ_ONLY_TOOL_NAMES.has("bash")).toBe(false);
  });

  test("isReadOnlyToolName agrees with the canonical set", () => {
    for (const name of ["read", "grep", "glob", "todo", "remember", "web_search"]) {
      expect(isReadOnlyToolName(name)).toBe(true);
    }
    for (const name of ["bash", "write", "edit", "task"]) {
      expect(isReadOnlyToolName(name)).toBe(false);
    }
  });

  test("isParallelSafeToolName: read/grep/glob/web are batchable; todo/remember are not", () => {
    for (const name of ["read", "grep", "glob", "web_search", "web_fetch"]) {
      expect(isParallelSafeToolName(name)).toBe(true);
    }
    for (const name of ["todo", "remember", "background_task", "bash", "write"]) {
      expect(isParallelSafeToolName(name)).toBe(false);
    }
  });

  test("permission engine auto-allows built-in read-only tools", () => {
    clearReadOnlyNames();
    const e = new PermissionEngine({ defaultMode: "default" });
    for (const name of ["read", "grep", "glob", "todo", "remember", "reload_extensions"]) {
      expect(e.check(name, { path: "x" })).toBe("allow");
    }
    expect(e.check("bash", { command: "npm install" })).toBe("ask");
    expect(e.check("write", { path: "x" })).toBe("ask");
  });

  test("permission engine respects runtime-registered read-only names (extension opt-in)", () => {
    clearReadOnlyNames();
    try {
      registerReadOnlyNames(["ripgrep"]);
      const e = new PermissionEngine();
      expect(readOnlyToolNames().has("ripgrep")).toBe(true);
      expect(e.check("ripgrep", { pattern: "x" })).toBe("allow");
    } finally {
      clearReadOnlyNames();
    }
  });

  test("permission engine: persistent deny beats read-only auto-allow", () => {
    clearReadOnlyNames();
    const e = new PermissionEngine({ deny: ["ripgrep"] });
    registerReadOnlyNames(["ripgrep"]);
    try {
      expect(e.check("ripgrep", { pattern: "x" })).toBe("deny");
    } finally {
      clearReadOnlyNames();
    }
  });
});

describe("extension tool hints propagate through merge", () => {
  const signal = () => new AbortController().signal;

  test("extension tool with readOnly: true is auto-allowed by the engine", async () => {
    clearReadOnlyNames();
    const extDef: ToolDef = {
      name: "ripgrep",
      description: "rg",
      schema: Type.Object({ pattern: Type.String() }),
      readOnly: true,
      execute: async () => ({ content: "matched" }),
    };
    const merged: ToolDef[] = [extDef];
    // Host simulates syncReadOnlyNames: seed the registry from the merged defs.
    registerReadOnlyNames(merged.filter((t) => t.readOnly).map((t) => t.name));
    try {
      const e = new PermissionEngine();
      let asked = false;
      const wrapped = wrapToolsWithPermissions(merged, e, async () => {
        asked = true;
        return "once";
      });
      const res = await wrapped[0].execute("1", { pattern: "x" }, signal());
      expect(res.content).toBe("matched");
      expect(asked).toBe(false); // never asked
    } finally {
      clearReadOnlyNames();
    }
  });

  test("parallelSafe hint on a tool def batches it with other reads", async () => {
    // parallelSafe extension tool, alongside built-in read, in one turn.
    let ripgrepStarted = false;
    let readStarted = false;
    let order: string[] = [];

    const ripgrepTool: ToolDef = {
      name: "ripgrep",
      description: "rg",
      schema: Type.Object({ pattern: Type.String() }),
      parallelSafe: true,
      readOnly: true,
      async execute() {
        ripgrepStarted = true;
        order.push("ripgrep-start");
        await new Promise((r) => setTimeout(r, 10));
        order.push("ripgrep-end");
        return { content: "rg" };
      },
    };
    const readTool: ToolDef = {
      name: "read",
      description: "read",
      schema: Type.Object({ path: Type.String() }),
      async execute() {
        readStarted = true;
        order.push("read-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("read-end");
        return { content: "r" };
      },
    };

    const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    // Scripted provider: turn 1 returns parallel tool_uses; turn 2 ends.
    const scripts: StreamEvent[][] = [
      [
        {
          type: "done",
          stopReason: "tool_use",
          usage,
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "a", name: "read", input: { path: "x" } },
              { type: "tool_use", id: "b", name: "ripgrep", input: { pattern: "p" } },
            ],
          },
        },
      ],
      [
        {
          type: "done",
          stopReason: "end_turn",
          usage,
          message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        },
      ],
    ];
    const provider: Provider = {
      id: "fake",
      defaultModel: "fake",
      stream() {
        return (async function* () {
          for (const ev of scripts.shift() ?? []) yield ev;
        })();
      },
    };

    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const { stopReason } = await runAgentLoop({
      provider,
      system: "s",
      messages,
      tools: [readTool, ripgrepTool],
      events: new Emitter(),
      signal: signal(),
    });
    void order;
    expect(stopReason).toBe("end_turn");
    // ripgrep (extension, marked parallelSafe) must start before read ends,
    // proving the parallelSafe opt-in batches the custom tool with read.
    expect(ripgrepStarted).toBe(true);
    expect(readStarted).toBe(true);
    expect(order.indexOf("ripgrep-start")).toBeLessThan(order.indexOf("read-end"));
  });

  test("isParallelSafeTool loop helper honors the parallelSafe flag", () => {
    expect(isParallelSafeTool("read")).toBe(true); // built-in
    expect(isParallelSafeTool("bash")).toBe(false); // built-in non-safe
    expect(
      isParallelSafeTool({ name: "x", description: "", schema: Type.Object({}), execute: async () => ({ content: "" }) } as ToolDef),
    ).toBe(false); // no flag
    expect(
      isParallelSafeTool({
        name: "x",
        description: "",
        schema: Type.Object({}),
        parallelSafe: true,
        execute: async () => ({ content: "" }),
      } as ToolDef),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #3: memory layer — forget / update / categories
// ---------------------------------------------------------------------------

let home: string;
let proj: string;

beforeAll(() => {
  home = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-mem2-home-`);
  proj = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-mem2-proj-`);
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

describe("memory store edits", () => {
  test("forgetLearning removes a matching bullet", () => {
    const path = projectMemoryPath(proj);
    appendLearning(path, "first learning");
    appendLearning(path, "second learning");
    expect(forgetLearning(path, "first")).toBe(true);
    const after = readFileSync(path, "utf8");
    expect(after).not.toContain("first learning");
    expect(after).toContain("second learning");
  });

  test("forgetLearning returns false on no match (no rewrite)", () => {
    const path = projectMemoryPath(proj);
    appendLearning(path, "keep me");
    expect(forgetLearning(path, "never-written")).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("keep me");
  });

  test("updateLearning replaces the matching bullet in place", () => {
    const path = projectMemoryPath(proj);
    appendLearning(path, "uses tabs");
    appendLearning(path, "uses jest");
    expect(updateLearning(path, "tabs", "uses spaces (corrected)")).toBe(true);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("uses spaces (corrected)");
    expect(after).not.toContain("uses tabs");
    expect(after).toContain("uses jest");
  });
});

describe("remember tool actions", () => {
  test("action=remember appends a bullet with an optional [kind] tag", async () => {
    const tool = memoryTool(proj);
    const r = await tool.execute(
      "1",
      { learning: "prefers tabs over spaces", scope: "project", kind: "preference" },
      new AbortController().signal,
    );
    expect(r.is_error).toBeUndefined();
    expect(readFileSync(projectMemoryPath(proj), "utf8")).toBe("- [preference] prefers tabs over spaces\n");
  });

  test("action=forget drops the matching entry", async () => {
    const path = projectMemoryPath(proj);
    appendLearning(path, "dead entry");
    appendLearning(path, "keep this");
    const tool = memoryTool(proj);
    const r = await tool.execute(
      "1",
      { learning: "ignored", action: "forget", find: "dead", scope: "project" },
      new AbortController().signal,
    );
    expect(r.is_error).toBeUndefined();
    const after = readFileSync(path, "utf8");
    expect(after).not.toContain("dead entry");
    expect(after).toContain("keep this");
  });

  test("action=update rewrites the matching entry", async () => {
    const path = projectMemoryPath(proj);
    appendLearning(path, "outdated info");
    const tool = memoryTool(proj);
    const r = await tool.execute(
      "1",
      { learning: "corrected info", action: "update", find: "outdated", scope: "project" },
      new AbortController().signal,
    );
    expect(r.is_error).toBeUndefined();
    expect(readFileSync(path, "utf8")).toContain("- corrected info");
    expect(readFileSync(path, "utf8")).not.toContain("outdated");
  });

  test("action=forget with no match is an error (no rewrite)", async () => {
    appendLearning(projectMemoryPath(proj), "still here");
    const tool = memoryTool(proj);
    const r = await tool.execute(
      "1",
      { learning: "", action: "forget", find: "missing", scope: "project" },
      new AbortController().signal,
    );
    expect(r.is_error).toBe(true);
    expect(existsSync(projectMemoryPath(proj))).toBe(true);
  });

  test("fact kind writes a plain bullet (no tag)", async () => {
    const tool = memoryTool(proj);
    await tool.execute(
      "1",
      { learning: "plain fact", scope: "project", kind: "fact" },
      new AbortController().signal,
    );
    expect(readFileSync(projectMemoryPath(proj), "utf8")).toBe("- plain fact\n");
  });

  test("loadMemory still surfaces global + project after edits", () => {
    appendLearning(globalMemoryPath(), "global one");
    appendLearning(projectMemoryPath(proj), "proj one");
    appendLearning(projectMemoryPath(proj), "proj two");
    expect(forgetLearning(projectMemoryPath(proj), "proj one")).toBe(true);
    const m = loadMemory(proj);
    expect(m).toContain("## Global");
    expect(m).toContain("- global one");
    expect(m).toContain("## This project");
    expect(m).toContain("- proj two");
    expect(m).not.toContain("proj one");
    void globalMemoryPath;
  });
});

// ---------------------------------------------------------------------------
// #6: progressive disclosure for skills
// ---------------------------------------------------------------------------

describe("formatSkillsIndex progressive disclosure", () => {
  test("empty list returns empty string", () => {
    expect(formatSkillsIndex([])).toBe("");
  });

  test("small list lists every skill", () => {
    const skills = Array.from({ length: 5 }, (_, i) => ({
      name: `s${i}`,
      description: `D${i}`,
      path: `/tmp/s${i}.md`,
      body: "",
    }));
    const out = formatSkillsIndex(skills);
    for (const s of skills) {
      expect(out).toContain(`/${s.name}`);
      expect(out).toContain(s.description);
    }
    expect(out).not.toContain("… and");
  });

  test("large list caps at the threshold with an overflow hint", () => {
    const count = SKILLS_INDEX_CAP + 5;
    const skills = Array.from({ length: count }, (_, i) => ({
      name: `s${i}`,
      description: `D${i}`,
      path: `/tmp/s${i}.md`,
      body: "",
    }));
    const out = formatSkillsIndex(skills);
    // First SKILLS_INDEX_CAP entries present:
    for (let i = 0; i < SKILLS_INDEX_CAP; i++) {
      expect(out).toContain(`/s${i}`);
    }
    // Overflow entries not present:
    expect(out).not.toContain(`/s${SKILLS_INDEX_CAP}`);
    // Hint pointing to /skills:
    expect(out).toContain(`/skills to list all`);
    expect(out).toMatch(/and \d+ more/);
  });
});
