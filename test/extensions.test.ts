import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Emitter } from "../src/core/events.js";
import { runAgentLoop } from "../src/core/loop.js";
import { loadSettings } from "../src/core/settings.js";
import { defaultTools } from "../src/core/tools/index.js";
import type { Message, StreamEvent, StopReason, Usage } from "../src/core/types.js";
import { discoverExtensionFiles, loadExtensions } from "../src/extensions/loader.js";
import { ExtensionRuntime, type RuntimeDeps } from "../src/extensions/runtime.js";
import type { Provider, StreamParams } from "../src/providers/types.js";

let home: string;
let proj: string;

beforeAll(() => {
  home = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-ext-home-`);
  proj = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-ext-proj-`);
  process.env.DEVCODE_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
});
beforeEach(() => {
  rmSync(join(home, "extensions"), { recursive: true, force: true });
  rmSync(join(proj, ".devcode"), { recursive: true, force: true });
  delete (globalThis as any).__ext;
});

const write = (path: string, content: string): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
};
const gext = (name: string, content: string): string => write(join(home, "extensions", name), content);
const pext = (name: string, content: string): string => write(join(proj, ".devcode", "extensions", name), content);

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

const sig = () => new AbortController().signal;

describe("discovery", () => {
  test("finds global + project files, one level of subdirs only", () => {
    gext("g1.ts", "export default function () {}");
    gext("g2.js", "export default function () {}");
    pext("p1.ts", "export default function () {}");
    gext("sub/index.ts", "export default function () {}");
    gext("deep/nested/index.ts", "export default function () {}");

    const files = discoverExtensionFiles(proj);
    const paths = files.map((f) => f.path.replace(/\\/g, "/"));
    expect(paths.some((p) => p.endsWith("extensions/g1.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("extensions/g2.js"))).toBe(true);
    expect(paths.some((p) => p.endsWith("extensions/p1.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("extensions/sub/index.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("deep/nested/index.ts"))).toBe(false);
    expect(files.find((f) => f.path.endsWith("g1.ts"))?.source).toBe("global");
    expect(files.find((f) => f.path.endsWith("p1.ts"))?.source).toBe("project");
  });
});

describe("jiti loading", () => {
  test("loads a .ts extension using typebox and the devcode alias", async () => {
    const path = gext(
      "typed.ts",
      [
        'import { Type } from "@sinclair/typebox";',
        'import type { ExtensionAPI } from "devcode";',
        "export default function (api: ExtensionAPI) {",
        '  api.registerTool({ name: "typed_tool", description: "t", schema: Type.Object({ x: Type.Number() }),',
        '    async execute() { return { content: "typed-ok" }; } });',
        "  (globalThis as any).__ext = true;",
        "}",
      ].join("\n"),
    );
    const { loaded, errors } = await loadExtensions([{ path, source: "global" }]);
    expect(errors).toEqual([]);
    expect(loaded.length).toBe(1);
    const registered: any[] = [];
    await loaded[0].factory({
      registerTool: (d: any) => registered.push(d),
      registerCommand: () => {},
      on: () => {},
    } as any);
    expect((globalThis as any).__ext).toBe(true);
    expect(registered[0].name).toBe("typed_tool");
  });

  test("broken files collect errors while others still load", async () => {
    const bad = gext("broken.ts", 'throw new Error("boom at import");\nexport default function () {}');
    const good = gext("good.ts", "export default function () { (globalThis as any).__ext = true; }");
    const { loaded, errors } = await loadExtensions([
      { path: bad, source: "global" },
      { path: good, source: "global" },
    ]);
    expect(loaded.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0].path.replace(/\\/g, "/")).toContain("broken.ts");
    expect(errors[0].error).toContain("boom at import");
    await loaded[0].factory({ registerTool: () => {}, registerCommand: () => {}, on: () => {} } as any);
    expect((globalThis as any).__ext).toBe(true);
  });
});

describe("runtime", () => {
  test("registered tools appear in tools(); extension shadows a built-in name", async () => {
    gext(
      "mytool.ts",
      [
        "export default function (api) {",
        '  api.registerTool({ name: "greet", description: "", schema: { type: "object" }, async execute() { return { content: "Hello!" }; } });',
        '  api.registerTool({ name: "read", description: "shadow", schema: { type: "object" }, async execute() { return { content: "ext-read" }; } });',
        "}",
      ].join("\n"),
    );
    const rt = new ExtensionRuntime(makeDeps());
    await rt.load();
    expect(rt.tools().map((t) => t.name)).toContain("greet");

    const merged = rt.mergedTools(defaultTools("ext-test"));
    expect(merged.filter((t) => t.name === "read").length).toBe(1);
    const read = merged.find((t) => t.name === "read")!;
    expect(await read.execute("1", { path: "x" }, sig())).toEqual({ content: "ext-read" });
  });

  test("built-in reload_extensions tool schedules /reload via followUp", async () => {
    const sent: string[] = [];
    const rt = new ExtensionRuntime(makeDeps({ followUp: (t) => sent.push(t) }));
    await rt.load();
    const tool = rt.tools().find((t) => t.name === "reload_extensions")!;
    expect(tool).toBeDefined();
    const res = await tool.execute("1", {}, sig());
    expect(res.is_error).toBeUndefined();
    expect(sent).toEqual(["/reload"]);
  });

  test("an extension registering reload_extensions shadows the built-in", async () => {
    gext(
      "custom-reload.ts",
      [
        "export default function (api) {",
        '  api.registerTool({ name: "reload_extensions", description: "custom", schema: { type: "object" }, async execute() { return { content: "custom-reload" }; } });',
        "}",
      ].join("\n"),
    );
    const rt = new ExtensionRuntime(makeDeps());
    await rt.load();
    const tools = rt.tools().filter((t) => t.name === "reload_extensions");
    expect(tools.length).toBe(1);
    expect((await tools[0].execute("1", {}, sig())).content).toBe("custom-reload");
  });

  test("middleware: block, throwing handler, and chained result modification", async () => {
    gext(
      "gate.ts",
      [
        "export default function (api) {",
        '  api.on("tool_call", (ev) => {',
        '    if (ev.toolName === "bash") return { block: true, reason: "no bash today" };',
        '    if (ev.toolName === "write") throw new Error("handler blew up");',
        "  });",
        '  api.on("tool_result", (ev) => {',
        '    if (ev.toolName === "read") return { ...ev.result, content: ev.result.content + " [first]" };',
        "  });",
        '  api.on("tool_result", (ev) => {',
        '    if (ev.toolName === "read") return { ...ev.result, content: ev.result.content + " [second]" };',
        "  });",
        "}",
      ].join("\n"),
    );
    const rt = new ExtensionRuntime(makeDeps());
    await rt.load();
    const wrapped = rt.wrapWithMiddleware(defaultTools("mw-test"));

    const bash = wrapped.find((t) => t.name === "bash")!;
    const blocked = await bash.execute("1", { command: "echo hello" }, sig());
    expect(blocked.is_error).toBe(true);
    expect(blocked.content).toBe("Blocked: no bash today");

    const write = wrapped.find((t) => t.name === "write")!;
    const thrown = await write.execute("1", { path: `${proj}/mw.txt`, content: "x" }, sig());
    expect(thrown.is_error).toBe(true);
    expect(thrown.content).toBe("Blocked: handler blew up");

    const read = wrapped.find((t) => t.name === "read")!;
    writeFileSync(`${proj}/mw-read.txt`, "body", "utf8");
    const res = await read.execute("1", { path: `${proj}/mw-read.txt` }, sig());
    expect(res.content).toContain("[first]");
    expect(res.content).toContain("[second]");
    expect(res.content.indexOf("[first]")).toBeLessThan(res.content.indexOf("[second]"));
  });

  test("reload picks up changed files, old contexts go stale, lifecycle fires", async () => {
    const v = (tag: string) =>
      [
        "export default function (api) {",
        `  api.registerTool({ name: "ver", description: "", schema: { type: "object" }, async execute() { return { content: "${tag}" }; } });`,
        '  api.registerCommand("stash", { description: "", handler: (_a, ctx) => { (globalThis as any).__ctx = ctx; } });',
        '  api.on("session_start", () => { ((globalThis as any).__lc ??= []).push("start"); });',
        '  api.on("session_shutdown", () => { ((globalThis as any).__lc ??= []).push("shutdown"); });',
        "}",
      ].join("\n");
    const path = gext("versioned.ts", v("v1"));
    delete (globalThis as any).__lc;

    const rt = new ExtensionRuntime(makeDeps());
    await rt.load();
    expect((await rt.tools().find((t) => t.name === "ver")!.execute("1", {}, sig())).content).toBe("v1");
    rt.command("stash")!.handler("", rt.commandContext("stash"));
    const oldCtx = (globalThis as any).__ctx;

    write(path, v("v2"));
    const res = await rt.reload();
    expect(res.ok).toBe(true);
    expect((await rt.tools().find((t) => t.name === "ver")!.execute("1", {}, sig())).content).toBe("v2");
    expect(() => oldCtx.sendUserMessage("hi")).toThrow("stale after reload");
    expect((globalThis as any).__lc).toEqual(["start", "shutdown", "start"]);
  });

  test("project extensions require trust; trust persists in settings", async () => {
    const iso = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-ext-iso-`);
    const savedHome = process.env.DEVCODE_HOME;
    process.env.DEVCODE_HOME = iso;
    try {
      pext("proj-tool.ts", 'export default function (api) { api.registerTool({ name: "projtool", description: "", schema: { type: "object" }, async execute() { return { content: "p" }; } }); }');
      let asked = 0;
      const deny = new ExtensionRuntime(makeDeps({ confirmTrust: async () => (asked++, false) }));
      await deny.load();
      expect(deny.tools().map((t) => t.name)).not.toContain("projtool");
      expect(asked).toBe(1);

      const allow = new ExtensionRuntime(makeDeps({ confirmTrust: async () => (asked++, true) }));
      await allow.load();
      expect(allow.tools().map((t) => t.name)).toContain("projtool");
      expect(asked).toBe(2);
      expect(loadSettings().trustedProjects).toContain(proj);

      const again = new ExtensionRuntime(makeDeps({ confirmTrust: async () => (asked++, true) }));
      await again.load();
      expect(asked).toBe(2); // persisted: no re-ask
      expect(again.tools().map((t) => t.name)).toContain("projtool");
    } finally {
      process.env.DEVCODE_HOME = savedHome;
      rmSync(iso, { recursive: true, force: true });
    }
  });
});

// --- loop integration ---

class FakeProvider implements Provider {
  id = "fake";
  defaultModel = "fake-model";
  scripts: StreamEvent[][] = [];
  stream(_params: StreamParams): AsyncIterable<StreamEvent> {
    const script = this.scripts.shift();
    if (!script) throw new Error("FakeProvider: no script queued");
    return (async function* () {
      for (const ev of script) yield ev;
    })();
  }
}

const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const toolUseDone = (id: string, name: string, input: unknown): StreamEvent => ({
  type: "done",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  stopReason: "tool_use",
  usage,
});
const textDone = (text: string, stopReason: StopReason = "end_turn"): StreamEvent => ({
  type: "done",
  message: { role: "assistant", content: [{ type: "text", text }] },
  stopReason,
  usage,
});

describe("loop integration", () => {
  test("FakeProvider calls an extension tool and the result flows back", async () => {
    gext(
      "greet.ts",
      [
        "export default function (api) {",
        '  api.registerTool({ name: "greet", description: "", schema: { type: "object", properties: { name: { type: "string" } } },',
        '    async execute(_id, params) { return { content: "Hello, " + params.name + "!" }; } });',
        "}",
      ].join("\n"),
    );
    const rt = new ExtensionRuntime(makeDeps());
    await rt.load();
    const tools = rt.wrapWithMiddleware(rt.mergedTools(defaultTools("loop-test")));

    const provider = new FakeProvider();
    provider.scripts.push([toolUseDone("t1", "greet", { name: "World" })]);
    provider.scripts.push([textDone("done")]);
    const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];
    const { stopReason } = await runAgentLoop({
      provider,
      system: "s",
      messages,
      tools,
      events: new Emitter(),
      signal: sig(),
    });
    expect(stopReason).toBe("end_turn");
    expect(messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "Hello, World!" });
  });
});
