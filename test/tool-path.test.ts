import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  cleanToolPath,
  directoryPathError,
  displayToolPath,
  missingPathError,
  resolveToolPath,
} from "../src/core/tools/path.js";

describe("cleanToolPath", () => {
  test("strips surrounding quotes and whitespace", () => {
    expect(cleanToolPath('  "src/foo.ts"  ')).toBe(
      process.platform === "win32" ? "src\\foo.ts" : "src/foo.ts",
    );
    expect(cleanToolPath("'bar.ts'")).toBe("bar.ts");
  });

  test("expands ~ to home", () => {
    const cleaned = cleanToolPath("~/notes.md");
    expect(cleaned.startsWith(homedir())).toBe(true);
    expect(cleaned.replace(/\\/g, "/").endsWith("/notes.md")).toBe(true);
  });

  test("strips file:// prefix", () => {
    const cleaned = cleanToolPath("file:///tmp/x.txt");
    expect(cleaned.replace(/\\/g, "/")).toMatch(/\/tmp\/x\.txt$/);
  });
});

describe("resolveToolPath", () => {
  const cwd = process.platform === "win32" ? "D:\\projects\\app" : "/projects/app";

  test("resolves relative paths against cwd", () => {
    const abs = resolveToolPath("src/main.ts", cwd);
    expect(abs).toBe(resolve(cwd, "src/main.ts"));
  });

  test("keeps absolute paths", () => {
    const target = resolve(cwd, "abs.ts");
    expect(resolveToolPath(target, cwd)).toBe(target);
  });

  test("empty path stays empty", () => {
    expect(resolveToolPath("   ", cwd)).toBe("");
    expect(resolveToolPath('""', cwd)).toBe("");
  });
});

describe("displayToolPath / errors", () => {
  const cwd = process.platform === "win32" ? "D:\\projects\\app" : "/projects/app";

  test("prefers relative display under cwd", () => {
    const abs = resolve(cwd, "src/a.ts");
    expect(displayToolPath(abs, cwd)).toBe("src/a.ts");
  });

  test("directory error points at glob", () => {
    const msg = directoryPathError(resolve(cwd, "src"), cwd);
    expect(msg).toMatch(/directory/i);
    expect(msg).toMatch(/glob/i);
    expect(msg).toContain("src");
  });

  test("missing error mentions cwd and glob", () => {
    const msg = missingPathError(resolve(cwd, "nope.ts"), cwd);
    expect(msg).toMatch(/not found/i);
    expect(msg).toMatch(/glob/i);
    expect(msg.replace(/\\/g, "/")).toContain(cwd.replace(/\\/g, "/"));
  });
});
