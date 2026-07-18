import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { bashTool, isMissingBinaryError } from "../src/core/tools/bash.js";
import { editTool } from "../src/core/tools/edit.js";
import { globTool } from "../src/core/tools/glob.js";
import { grepTool } from "../src/core/tools/grep.js";
import { defaultTools } from "../src/core/tools/index.js";
import { readTool } from "../src/core/tools/read.js";
import { getTodos, todoTool } from "../src/core/tools/todo.js";
import { writeTool } from "../src/core/tools/write.js";

const signal = new AbortController().signal;
let dir: string;
let devcodeHome: string;

beforeAll(() => {
  dir = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-test-`);
  devcodeHome = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-home-`);
  process.env.DEVCODE_HOME = devcodeHome; // spill files land here, not in the real home
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(devcodeHome, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
});

describe("edit tool", () => {
  test("zero matches reports 'not found'", async () => {
    const path = `${dir}/edit1.txt`;
    writeFileSync(path, "hello world hello", "utf8");
    const res = await editTool.execute("1", { path, old_string: "bye", new_string: "x" }, signal);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("not found");
  });

  test("multiple matches without replace_all is an error", async () => {
    const path = `${dir}/edit2.txt`;
    writeFileSync(path, "hello world hello", "utf8");
    const res = await editTool.execute("1", { path, old_string: "hello", new_string: "bye" }, signal);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("2 matches");
  });

  test("replace_all replaces every occurrence", async () => {
    const path = `${dir}/edit3.txt`;
    writeFileSync(path, "hello world hello", "utf8");
    const res = await editTool.execute("1", { path, old_string: "hello", new_string: "bye", replace_all: true }, signal);
    expect(res.is_error).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("bye world bye");
  });

  test("identical old and new is an error", async () => {
    const path = `${dir}/edit4.txt`;
    writeFileSync(path, "abc", "utf8");
    const res = await editTool.execute("1", { path, old_string: "a", new_string: "a" }, signal);
    expect(res.is_error).toBe(true);
  });

  test("single replace succeeds", async () => {
    const path = `${dir}/edit5.txt`;
    writeFileSync(path, "hello world hello", "utf8");
    const res = await editTool.execute("1", { path, old_string: "world", new_string: "there" }, signal);
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("replaced 1 occurrence");
    expect(readFileSync(path, "utf8")).toBe("hello there hello");
  });
});

describe("read tool", () => {
  test("missing file is an error", async () => {
    const res = await readTool.execute("1", { path: `${dir}/does-not-exist.txt` }, signal);
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/not found/i);
    expect(res.content).toMatch(/glob/i);
  });

  test("directory is an error with glob guidance", async () => {
    const res = await readTool.execute("1", { path: dir }, signal);
    expect(res.is_error).toBe(true);
    expect(res.content.toLowerCase()).toContain("directory");
    expect(res.content).toMatch(/glob/i);
  });

  test("numbers lines and appends truncation notice", async () => {
    const path = `${dir}/lines.txt`;
    writeFileSync(path, "l1\nl2\nl3\nl4\nl5\n", "utf8");
    const res = await readTool.execute("1", { path, limit: 2 }, signal);
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("1\tl1");
    expect(res.content).toContain("2\tl2");
    expect(res.content).not.toContain("3\tl3");
    expect(res.content).toContain("[truncated: showing 1-2 of 5 lines]");
  });

  test("accepts quoted paths and relative paths under bound cwd", async () => {
    const { createReadTool } = await import("../src/core/tools/read.js");
    writeFileSync(`${dir}/quoted.txt`, "hello quoted\n", "utf8");
    const tool = createReadTool(dir);
    const res = await tool.execute("1", { path: '"quoted.txt"' }, signal);
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("hello quoted");
  });
});

describe("bash tool", () => {
  test("echo roundtrip works", async () => {
    const res = await bashTool.execute("1", { command: "echo hello" }, signal);
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("hello");
  });

  test("non-zero exit reports the exit code", async () => {
    const res = await bashTool.execute("1", { command: "exit 7" }, signal);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("7");
  });

  test("huge output is capped with a truncation marker (via the spill wrapper)", async () => {
    const bash = defaultTools("tools-test").find((t) => t.name === "bash")!;
    const res = await bash.execute("1", { command: `bun -e "process.stdout.write('x'.repeat(204800))"` }, signal);
    expect(res.is_error).toBeUndefined();
    expect(res.content.length).toBeLessThan(32 * 1024);
    expect(res.content).toContain("bytes truncated");
  }, 20000);

  test("missing file is not reported as missing binary (false-positive fix)", async () => {
    // Reproduce screenshot: rm succeeds, trailing ls fails with "No such file"
    const path = `${dir}/tmp-rm-me.txt`;
    writeFileSync(path, "x", "utf8");
    const res = await bashTool.execute(
      "1",
      {
        command: `rm "${path}" && echo removed; ls "${path}" 2>&1`,
      },
      signal,
    );
    // exit non-zero from ls is fine, but must NOT claim rm is unavailable
    expect(res.content).not.toMatch(/Command "rm" is not available/i);
    expect(res.content).not.toMatch(/not Linux-only binaries/i);
  });
});

describe("isMissingBinaryError", () => {
  test("detects Windows not-recognized and bash command-not-found", () => {
    expect(
      isMissingBinaryError("shuf -n 1", "'shuf' is not recognized as an internal or external command,\noperable program or batch file."),
    ).toBe(true);
    expect(isMissingBinaryError("shuf -n 1", "bash: shuf: command not found")).toBe(true);
    expect(isMissingBinaryError("nope", "sh: 1: nope: not found")).toBe(true);
  });

  test("does not treat missing file args as missing binaries", () => {
    expect(
      isMissingBinaryError(
        "rm poem.txt && echo removed; ls poem.txt",
        "removed\nls: cannot access 'poem.txt': No such file or directory",
      ),
    ).toBe(false);
    expect(isMissingBinaryError("cat poem.txt", "cat: poem.txt: No such file or directory")).toBe(false);
    expect(isMissingBinaryError("ls -la poem.txt", "ls: cannot access 'poem.txt': No such file or directory")).toBe(false);
  });
});

describe("write tool", () => {
  test("creates nested directories", async () => {
    const path = `${dir}/nested/a/b/c.txt`;
    const res = await writeTool.execute("1", { path, content: "nested" }, signal);
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("Wrote 6 bytes");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("nested");
  });

  test("writes basename path without mkdir('.') (Windows EEXIST regression)", async () => {
    // path.dirname("poem.txt") === "." — must not call mkdir('.') which fails on Windows
    const prev = process.cwd();
    try {
      process.chdir(dir);
      const res = await writeTool.execute(
        "1",
        { path: "poem.txt", content: "Roses are red,\nViolets are blue,\n" },
        signal,
      );
      expect(res.is_error).toBeUndefined();
      expect(res.content).toMatch(/Wrote \d+ bytes/);
      expect(readFileSync("poem.txt", "utf8")).toContain("Roses are red");

      // overwrite existing file (write tool promises overwrite)
      const res2 = await writeTool.execute("1", { path: "poem.txt", content: "rewritten\n" }, signal);
      expect(res2.is_error).toBeUndefined();
      expect(readFileSync("poem.txt", "utf8")).toBe("rewritten\n");

      const read = await readTool.execute("1", { path: "poem.txt" }, signal);
      expect(read.is_error).toBeUndefined();
      expect(read.content).toContain("rewritten");
    } finally {
      process.chdir(prev);
    }
  });

  test("bound cwd resolves relative nested paths", async () => {
    const { createWriteTool } = await import("../src/core/tools/write.js");
    const { createReadTool } = await import("../src/core/tools/read.js");
    const writer = createWriteTool(dir);
    const reader = createReadTool(dir);
    const res = await writer.execute("1", { path: "bound/rel.txt", content: "via-cwd" }, signal);
    expect(res.is_error).toBeUndefined();
    expect(existsSync(`${dir}/bound/rel.txt`)).toBe(true);
    const read = await reader.execute("1", { path: "bound/rel.txt" }, signal);
    expect(read.content).toContain("via-cwd");
  });

  test("refuses to write onto a directory path", async () => {
    const res = await writeTool.execute("1", { path: dir, content: "nope" }, signal);
    expect(res.is_error).toBe(true);
    expect(res.content.toLowerCase()).toContain("directory");
  });
});

describe("grep tool", () => {
  test("finds matches in path:line:content format", async () => {
    const sub = `${dir}/grep1`;
    mkdirSync(sub, { recursive: true });
    writeFileSync(`${sub}/a.ts`, "const x = 1;\nhello world\n", "utf8");
    writeFileSync(`${sub}/b.md`, "hello again\n", "utf8");
    const res = await grepTool.execute("1", { pattern: "hello", path: sub }, signal);
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("a.ts:2:hello world");
    expect(res.content).toContain("b.md:1:hello again");
  });

  test("respects the glob filter and the default ignore set", async () => {
    const sub = `${dir}/grep2`;
    mkdirSync(`${sub}/node_modules`, { recursive: true });
    writeFileSync(`${sub}/a.ts`, "hello ts\n", "utf8");
    writeFileSync(`${sub}/b.md`, "hello md\n", "utf8");
    writeFileSync(`${sub}/node_modules/ignored.ts`, "hello ignored\n", "utf8");
    const res = await grepTool.execute("1", { pattern: "hello", path: sub, glob: "**/*.ts" }, signal);
    expect(res.content).toContain("a.ts:1:hello ts");
    expect(res.content).not.toContain("b.md");
    expect(res.content).not.toContain("ignored");
  });

  test("invalid regex is an error", async () => {
    const res = await grepTool.execute("1", { pattern: "(", path: dir }, signal);
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("Invalid regex");
  });

  test("caps at 100 matches with a notice", async () => {
    const sub = `${dir}/grep3`;
    mkdirSync(sub, { recursive: true });
    writeFileSync(`${sub}/big.txt`, Array.from({ length: 150 }, (_, i) => `match line ${i}`).join("\n"), "utf8");
    const res = await grepTool.execute("1", { pattern: "match", path: sub }, signal);
    expect(res.content).toContain("big.txt:1:match line 0");
    expect(res.content).toContain("big.txt:100:match line 99");
    expect(res.content).not.toContain("match line 100");
    expect(res.content).toContain("[truncated: first 100 matches shown]");
  });
});

describe("glob tool", () => {
  test("finds files sorted by mtime, newest first", async () => {
    const sub = `${dir}/glob1`;
    mkdirSync(sub, { recursive: true });
    const older = `${sub}/old.ts`;
    const newer = `${sub}/recent.ts`;
    writeFileSync(older, "a", "utf8");
    writeFileSync(newer, "b", "utf8");
    utimesSync(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(newer, new Date(2023, 0, 1), new Date(2023, 0, 1));
    const res = await globTool.execute("1", { pattern: "**/*.ts", path: sub }, signal);
    const lines = res.content.split("\n");
    expect(lines[0]).toBe("recent.ts");
    expect(lines[1]).toBe("old.ts");
  });

  test("caps at 200 files with a notice", async () => {
    const sub = `${dir}/glob2`;
    mkdirSync(sub, { recursive: true });
    for (let i = 0; i < 205; i++) writeFileSync(`${sub}/f${String(i).padStart(3, "0")}.txt`, "x", "utf8");
    const res = await globTool.execute("1", { pattern: "**/*.txt", path: sub }, signal);
    expect(res.content).toContain("[truncated: showing 200 of 205 files]");
  }, 15000);
});

describe("todo tool", () => {
  test("rewrites the list, renders the checklist, stores it", async () => {
    const tool = todoTool("s-tools-1");
    const res = await tool.execute(
      "1",
      {
        todos: [
          { content: "do a thing", status: "completed" },
          { content: "doing another", status: "in_progress", activeForm: "doing another now" },
          { content: "later", status: "pending" },
        ],
      },
      signal,
    );
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("✓ do a thing");
    expect(res.content).toContain("◐ doing another now");
    expect(res.content).toContain("☐ later");
    expect(getTodos("s-tools-1").length).toBe(3);
  });

  test("rejects more than one in_progress item", async () => {
    const tool = todoTool("s-tools-2");
    const res = await tool.execute(
      "1",
      {
        todos: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "in_progress" },
        ],
      },
      signal,
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("exactly one");
  });
});
