import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type { ToolDef } from "../src/core/types.js";
import { discoverExtensionFiles } from "../src/extensions/loader.js";
import { ExtensionRuntime, type RuntimeDeps } from "../src/extensions/runtime.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const bundledDir = join(repoRoot, "extensions");

let home: string;
let proj: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "devcode-bundled-home-"));
  proj = mkdtempSync(join(tmpdir(), "devcode-bundled-proj-"));
  process.env.DEVCODE_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
  delete process.env.DEVCODE_WEB_FETCH_URL;
  delete process.env.DEVCODE_WEB_SEARCH_URL;
  delete process.env.DEVCODE_NOTIFY_MIN_SEC;
});
beforeEach(() => {
  rmSync(join(home, "extensions"), { recursive: true, force: true });
  rmSync(join(home, "commands"), { recursive: true, force: true });
  rmSync(join(home, "checkpoints"), { recursive: true, force: true });
  rmSync(join(proj, ".devcode"), { recursive: true, force: true });
  delete process.env.DEVCODE_NOTIFY_MIN_SEC;
  delete process.env.DEVCODE_WEB_FETCH_URL;
  delete process.env.DEVCODE_WEB_SEARCH_URL;
  try {
    writeFileSync(join(home, "settings.json"), "{}", "utf8");
  } catch {
    /* */
  }
});

const makeDeps = (overrides?: Partial<RuntimeDeps>): RuntimeDeps => ({
  cwd: proj,
  getModel: () => "test-model",
  confirm: async () => true,
  confirmTrust: async () => true,
  notify: () => {},
  exec: async () => ({ code: 0, output: "" }),
  steer: () => {},
  followUp: () => {},
  isRunning: () => false,
  ...overrides,
});

function installBundled(name: string): void {
  mkdirSync(join(home, "extensions"), { recursive: true });
  writeFileSync(join(home, "extensions", name), readFileSync(join(bundledDir, name), "utf8"), "utf8");
}

const sig = () => new AbortController().signal;

describe("bundled web extension", () => {
  test("web_fetch + web_search against data/env overrides", async () => {
    process.env.DEVCODE_WEB_FETCH_URL = "data:text/html,<html><body><h1>Hello</h1><p>World</p></body></html>";
    process.env.DEVCODE_WEB_SEARCH_URL =
      "data:text/html," +
      encodeURIComponent(
        `<a class="result__a" href="https://example.com">Example</a><a class="result__snippet">Snip</a>`,
      );

    installBundled("web.ts");
    const runtime = new ExtensionRuntime(makeDeps());
    const { errors } = await runtime.load();
    expect(errors).toBe(0);

    const tools = runtime.tools();
    const fetchTool = tools.find((t) => t.name === "web_fetch");
    const searchTool = tools.find((t) => t.name === "web_search");
    expect(fetchTool).toBeTruthy();
    expect(searchTool).toBeTruthy();

    const f = await fetchTool!.execute("1", { url: "https://example.com" }, sig());
    expect(f.is_error).toBeFalsy();
    expect(f.content).toContain("Hello");

    const s = await searchTool!.execute("2", { query: "test" }, sig());
    expect(s.is_error).toBeFalsy();
    expect(s.content.toLowerCase()).toMatch(/example|http/);
  });
});

describe("bundled commands extension", () => {
  test("registers markdown commands with $ARGUMENTS", async () => {
    mkdirSync(join(home, "commands"), { recursive: true });
    writeFileSync(join(home, "commands", "review.md"), "Review this: $ARGUMENTS\n", "utf8");
    installBundled("commands.ts");

    const followUps: string[] = [];
    const runtime = new ExtensionRuntime(makeDeps({ followUp: (t) => followUps.push(t) }));
    const prev = process.cwd();
    process.chdir(proj);
    try {
      await runtime.load();
      const review = runtime.command("review");
      expect(review).toBeTruthy();
      await review!.handler("src/a.ts", runtime.commandContext("review"));
      expect(followUps.some((t) => t.includes("Review this:") && t.includes("src/a.ts"))).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });
});

describe("bundled checkpoints", () => {
  test("snapshots write/edit and rewind restores", async () => {
    installBundled("checkpoints.ts");
    const target = join(proj, "watched.txt");
    writeFileSync(target, "v1\n", "utf8");

    const runtime = new ExtensionRuntime(makeDeps({ confirm: async () => true }));
    await runtime.load();

    // Fire tool_call middleware via a wrapped dummy write tool
    const dummyWrite: ToolDef = {
      name: "write",
      description: "w",
      schema: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() {
        writeFileSync(target, "v2\n", "utf8");
        return { content: "ok" };
      },
    };
    const [wrapped] = runtime.wrapWithMiddleware([dummyWrite]);
    await wrapped.execute("1", { path: target, content: "v2\n" }, sig());
    expect(readFileSync(target, "utf8")).toBe("v2\n");

    const rewind = runtime.command("rewind");
    expect(rewind).toBeTruthy();
    await rewind!.handler("", runtime.commandContext("rewind"));
    expect(readFileSync(target, "utf8")).toBe("v1\n");
  });
});

describe("format-on-edit / notify / auto-commit", () => {
  test("format-on-edit no-ops without prettier", async () => {
    installBundled("format-on-edit.ts");
    let execs = 0;
    const runtime = new ExtensionRuntime(
      makeDeps({
        exec: async () => {
          execs++;
          return { code: 0, output: "" };
        },
      }),
    );
    await runtime.load();
    const dummy: ToolDef = {
      name: "write",
      description: "w",
      schema: Type.Object({ path: Type.String() }),
      async execute() {
        return { content: "ok" };
      },
    };
    const [wrapped] = runtime.wrapWithMiddleware([dummy]);
    await wrapped.execute("1", { path: "x.ts" }, sig());
    expect(execs).toBe(0);
  });

  test("notify swallows missing OS tools", async () => {
    process.env.DEVCODE_NOTIFY_MIN_SEC = "0";
    installBundled("notify.ts");
    const runtime = new ExtensionRuntime(
      makeDeps({
        exec: async () => ({ code: 127, output: "not found" }),
      }),
    );
    await runtime.load();
    await runtime.emitTurnStart();
    await runtime.emitTurnEnd();
    await runtime.emitPermissionRequested({ tool: "bash", detail: "npm i" });
  });

  test("auto-commit no-ops when disabled", async () => {
    // Keep notify from firing OS exec during this test (bundled notify may also load).
    process.env.DEVCODE_NOTIFY_MIN_SEC = "99999";
    installBundled("auto-commit.ts");
    const gitCalls: string[] = [];
    const runtime = new ExtensionRuntime(
      makeDeps({
        exec: async (cmd) => {
          if (/\bgit\b/.test(cmd)) gitCalls.push(cmd);
          return { code: 0, output: "true" };
        },
      }),
    );
    await runtime.load();
    await runtime.emitTurnEnd();
    // Flag off → must not run git status / commit.
    expect(gitCalls).toEqual([]);
  });
});

describe("bundled discovery", () => {
  test("repo extensions/ files exist for packaging", () => {
    expect(readFileSync(join(bundledDir, "web.ts"), "utf8")).toContain("web_fetch");
    expect(readFileSync(join(bundledDir, "mcp.ts"), "utf8")).toContain("mcpServers");
    // discover may include bundled when loader resolves repo root
    void discoverExtensionFiles(proj);
  });
});
