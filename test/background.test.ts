import { afterEach, describe, expect, test } from "bun:test";
import { _resetBackgroundForTests, killBackground, listBackground, readBackground, startBackground } from "../src/core/background.js";
import { bashTool } from "../src/core/tools/bash.js";
import { backgroundTaskTool } from "../src/core/tools/background.js";

const sig = () => new AbortController().signal;

afterEach(() => {
  _resetBackgroundForTests();
});

async function waitDone(id: string, ms = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const r = readBackground(id);
    if (r.ok && r.done) return;
    await Bun.sleep(30);
  }
  throw new Error(`timeout waiting for ${id}`);
}

describe("background registry", () => {
  test("start echo, poll read until done", async () => {
    const t = startBackground(process.platform === "win32" ? "echo hi-bg" : "echo hi-bg");
    expect(t.id).toMatch(/^bg-\d+$/);
    await waitDone(t.id);
    const r = readBackground(t.id);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.done).toBe(true);
      expect(r.text).toContain("hi-bg");
    }
  });

  test("kill a long sleep", async () => {
    const cmd = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30";
    const t = startBackground(cmd);
    const k = killBackground(t.id);
    expect(k.ok).toBe(true);
    await waitDone(t.id, 8000);
    const r = readBackground(t.id);
    expect(r.ok && r.done).toBe(true);
  });

  test("list shows tasks", async () => {
    startBackground(process.platform === "win32" ? "echo a" : "echo a");
    const rows = listBackground();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].id).toMatch(/^bg-/);
  });
});

describe("bash run_in_background + background_task tool", () => {
  test("bash tool returns id and survives turn end", async () => {
    const res = await bashTool.execute(
      "1",
      { command: process.platform === "win32" ? "echo from-bash" : "echo from-bash", run_in_background: true },
      sig(),
    );
    expect(res.is_error).toBeFalsy();
    const m = /bg-\d+/.exec(res.content);
    expect(m).toBeTruthy();
    const id = m![0];
    await waitDone(id);
    const listed = await backgroundTaskTool.execute("2", { action: "list" }, sig());
    expect(listed.content).toContain(id);
    const read = await backgroundTaskTool.execute("3", { action: "read", id }, sig());
    expect(read.content).toContain("from-bash");
  });
});
