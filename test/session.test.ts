import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, listSessions, loadSession, projectSlug, resolveSession } from "../src/core/session.js";
import { sessionsDir } from "../src/core/paths.js";
import type { Message } from "../src/core/types.js";

let home: string;
const cwd = "D:/work/demo";
const userMsg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistantMsg = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });

beforeAll(() => {
  home = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-sess-`);
  process.env.DEVCODE_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
});

describe("sessions", () => {
  test("create/append/load roundtrip", async () => {
    const s = createSession(cwd, "claude-sonnet-4-5", "sess-001");
    s.append(userMsg("hello there"));
    s.append(assistantMsg("hi!"));
    const { meta, messages } = await loadSession(s.path);
    expect(meta.id).toBe("sess-001");
    expect(meta.cwd).toBe(cwd);
    expect(meta.model).toBe("claude-sonnet-4-5");
    expect(messages.length).toBe(2);
    expect(messages[0].content[0]).toEqual({ type: "text", text: "hello there" });
    expect(messages[1].role).toBe("assistant");
  });

  test("listSessions returns previews, newest first", async () => {
    const a = createSession(cwd, "m", "sess-list-a");
    a.append(userMsg("first session question"));
    await Bun.sleep(10);
    const b = createSession(cwd, "m", "sess-list-b");
    b.append(userMsg("second session question"));
    const list = await listSessions(cwd);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].id).toBe("sess-list-b");
    expect(list[1].id).toBe("sess-list-a");
    expect(list[0].preview).toBe("second session question");
    expect(list[0].messageCount).toBe(1);
  });

  test("cleared marker resets messages for later readers", async () => {
    const s = createSession(cwd, "m", "sess-clear");
    s.append(userMsg("before clear"));
    s.markCleared();
    s.append(userMsg("after clear"));
    const { messages } = await loadSession(s.path);
    expect(messages.length).toBe(1);
    expect(messages[0].content[0]).toEqual({ type: "text", text: "after clear" });
  });

  test("resolveSession: unique prefix, ambiguous prefix, no match", async () => {
    createSession(cwd, "m", "pref-aaa");
    createSession(cwd, "m", "pref-aab");
    const unique = await resolveSession(cwd, "pref-aaa");
    expect(unique.info?.id).toBe("pref-aaa");
    const ambiguous = await resolveSession(cwd, "pref-a");
    expect(ambiguous.info).toBeUndefined();
    expect(ambiguous.error).toContain("Ambiguous");
    expect(ambiguous.error).toContain("pref-aaa");
    expect(ambiguous.error).toContain("pref-aab");
    const none = await resolveSession(cwd, "no-such-session");
    expect(none.info).toBeUndefined();
    expect(none.error).toContain("No session matches");
  });

  test("loadSession skips a truncated last line (kill mid-write)", async () => {
    const s = createSession(cwd, "m", "sess-trunc");
    s.append(userMsg("survived"));
    appendFileSync(s.path, '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"partial', "utf8");
    const { messages } = await loadSession(s.path);
    expect(messages.length).toBe(1);
    expect(messages[0].content[0]).toEqual({ type: "text", text: "survived" });
  });

  test("listSessions ignores junk files and truncated lines", async () => {
    const dir = join(sessionsDir(), projectSlug(cwd));
    writeFileSync(join(dir, "not-json.jsonl"), "{{{{not json\n", "utf8");
    const s = createSession(cwd, "m", "sess-ok-list");
    s.append(userMsg("ok preview"));
    appendFileSync(s.path, "{truncated-no-newline", "utf8");
    const list = await listSessions(cwd);
    expect(list.some((x) => x.id === "sess-ok-list")).toBe(true);
    expect(list.find((x) => x.id === "sess-ok-list")?.preview).toBe("ok preview");
  });
});
