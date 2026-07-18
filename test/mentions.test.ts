import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandMentions, listFileCandidates } from "../src/core/mentions.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "devcode-mentions-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "hello.ts"), "export const n = 1;\n", "utf8");
  writeFileSync(join(dir, "README.md"), "# hi\n", "utf8");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("expandMentions", () => {
  test("expands existing relative paths", async () => {
    const out = await expandMentions("see @src/hello.ts please", dir);
    expect(out).toContain('<file path="src/hello.ts">');
    expect(out).toContain("export const n = 1;");
    expect(out).toContain("</file>");
  });

  test("missing file left as-is", async () => {
    const out = await expandMentions("look at @no/such/file.ts", dir);
    expect(out).toBe("look at @no/such/file.ts");
  });

  test("social-like @mentions without path left alone", async () => {
    const out = await expandMentions("ping @alice about this", dir);
    expect(out).toBe("ping @alice about this");
  });

  test("truncates oversized files", async () => {
    const big = join(dir, "big.txt");
    writeFileSync(big, "x".repeat(200_000), "utf8");
    const out = await expandMentions("@big.txt", dir);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(200_000);
  });
});

describe("listFileCandidates", () => {
  test("lists project files, skips node_modules", async () => {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "x.js"), "1", "utf8");
    const list = await listFileCandidates(dir);
    expect(list.some((p) => p.replace(/\\/g, "/").includes("src/hello.ts"))).toBe(true);
    expect(list.some((p) => p.includes("node_modules"))).toBe(false);
  });
});
