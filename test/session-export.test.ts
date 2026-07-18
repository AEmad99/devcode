import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  exportSessionMarkdown,
  listSessions,
  loadSession,
  renameSession,
} from "../src/core/session.js";
import type { Message } from "../src/core/types.js";

let home: string;
const cwd = "D:/work/export-demo";

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "devcode-export-"));
  process.env.DEVCODE_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
});

describe("named sessions + export", () => {
  test("create with name and rename", async () => {
    const s = createSession(cwd, "m", "named-001", "spike");
    const { meta } = await loadSession(s.path);
    expect(meta.name).toBe("spike");
    renameSession(s.path, "shipped");
    const { meta: m2 } = await loadSession(s.path);
    expect(m2.name).toBe("shipped");
    const list = await listSessions(cwd);
    const hit = list.find((x) => x.id === "named-001");
    expect(hit?.name).toBe("shipped");
  });

  test("exportSessionMarkdown writes transcript", async () => {
    const s = createSession(cwd, "m", "exp-001", "export-me");
    const user: Message = { role: "user", content: [{ type: "text", text: "hello export" }] };
    const asst: Message = { role: "assistant", content: [{ type: "text", text: "hi there" }] };
    s.append(user);
    s.append(asst);
    const out = exportSessionMarkdown(s.path);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("export-me");
    expect(md).toContain("hello export");
    expect(md).toContain("hi there");
    expect(md).toContain("## user");
  });
});
