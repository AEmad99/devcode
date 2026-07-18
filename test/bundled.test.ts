import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bundledExtensionsDir, discoverExtensionFiles } from "../src/extensions/loader.js";
import { ExtensionRuntime, type RuntimeDeps } from "../src/extensions/runtime.js";

let home: string;
let proj: string;

beforeAll(() => {
  home = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-bundled-home-`);
  proj = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-bundled-proj-`);
  process.env.DEVCODE_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
});
beforeEach(() => {
  rmSync(join(home, "extensions"), { recursive: true, force: true });
  rmSync(join(home, "settings.json"), { force: true }); // drop persisted trustedProjects
  rmSync(join(proj, ".devcode"), { recursive: true, force: true });
  rmSync(join(proj, "extensions"), { recursive: true, force: true });
  delete (globalThis as any).__ext;
  delete (globalThis as any).__perm;
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

describe("bundled discovery", () => {
  test("bundledExtensionsDir returns a shipped extensions dir or undefined, never cwd-based", () => {
    const dir = bundledExtensionsDir();
    // The repo extensions/ dir is added by a later phase; until then this is undefined.
    expect(dir === undefined || basename(dir) === "extensions").toBe(true);
    if (dir) {
      expect(statSync(dir).isDirectory()).toBe(true);
      // Never inside an arbitrary project dir (probes are module/execPath-based only).
      expect(dir.replace(/\\/g, "/").startsWith(proj.replace(/\\/g, "/"))).toBe(false);
    }
    // Discovery works whether or not the bundled dir exists yet.
    expect(() => discoverExtensionFiles(proj)).not.toThrow();
    if (dir) {
      for (const f of discoverExtensionFiles(proj).filter((f) => f.path.startsWith(dir))) {
        expect(f.source).toBe("bundled");
      }
    }
  });

  test("a top-level extensions/ dir inside a project is not discovered", () => {
    write(join(proj, "extensions", "sneaky.ts"), "export default function () {}");
    const files = discoverExtensionFiles(proj);
    expect(files.some((f) => f.path.includes("sneaky"))).toBe(false);
  });

  test("discoverExtensionFiles tags global/project sources and orders global before project", () => {
    gext("g1.ts", "export default function () {}");
    pext("p1.ts", "export default function () {}");
    const files = discoverExtensionFiles(proj);
    const g = files.find((f) => f.path.endsWith("g1.ts"));
    const p = files.find((f) => f.path.endsWith("p1.ts"));
    expect(g?.source).toBe("global");
    expect(p?.source).toBe("project");
    expect(files.indexOf(g!)).toBeLessThan(files.indexOf(p!));
    // Bundled (when present) precedes both.
    const firstNonBundled = files.findIndex((f) => f.source !== "bundled");
    const seenNonBundled = firstNonBundled !== -1;
    for (const [i, f] of files.entries()) {
      if (f.source === "bundled") expect(seenNonBundled ? i < firstNonBundled : true).toBe(true);
    }
  });
});

describe("tool shadowing", () => {
  test("duplicate tool names: last registration wins (project shadows global)", async () => {
    gext(
      "foo-global.ts",
      [
        "export default function (api) {",
        '  api.registerTool({ name: "foo", description: "global", schema: { type: "object" }, async execute() { return { content: "global-foo" }; } });',
        "}",
      ].join("\n"),
    );
    pext(
      "foo-project.ts",
      [
        "export default function (api) {",
        '  api.registerTool({ name: "foo", description: "project", schema: { type: "object" }, async execute() { return { content: "project-foo" }; } });',
        "}",
      ].join("\n"),
    );
    const rt = new ExtensionRuntime(makeDeps()); // confirmTrust stubbed → true
    await rt.load();
    const foos = rt.tools().filter((t) => t.name === "foo");
    expect(foos.length).toBe(1);
    expect((await foos[0].execute("1", {}, sig())).content).toBe("project-foo");
  });
});

describe("permission_requested event", () => {
  test("emitPermissionRequested reaches extension handlers with (ev, ctx)", async () => {
    gext(
      "perm-watcher.ts",
      [
        "export default function (api) {",
        '  api.on("permission_requested", (ev, ctx) => {',
        "    ((globalThis as any).__perm ??= []).push({ tool: ev.tool, detail: ev.detail, cwd: ctx.cwd });",
        "  });",
        "}",
      ].join("\n"),
    );
    const rt = new ExtensionRuntime(makeDeps());
    await rt.load();
    await rt.emitPermissionRequested({ tool: "bash", detail: "ls" });
    expect((globalThis as any).__perm).toEqual([{ tool: "bash", detail: "ls", cwd: proj }]);
  });

  test("emitPermissionRequested resolves with no handlers registered", async () => {
    const rt = new ExtensionRuntime(makeDeps());
    await rt.load();
    await expect(rt.emitPermissionRequested({ tool: "bash", detail: "ls" })).resolves.toBeUndefined();
  });
});

describe("trust gate", () => {
  test("only project files prompt; global (and bundled, when present) load silently", async () => {
    let asked = 0;
    const deps = () => makeDeps({ confirmTrust: async () => (asked++, true) });

    gext("plain-global.ts", "export default function () { (globalThis as any).__ext = true; }");
    const rt1 = new ExtensionRuntime(deps());
    await rt1.load();
    expect(asked).toBe(0); // no project files → no prompt, even if bundled files exist
    expect((globalThis as any).__ext).toBe(true);

    pext("plain-project.ts", "export default function () {}");
    const rt2 = new ExtensionRuntime(deps());
    await rt2.load();
    expect(asked).toBe(1); // project files still gate exactly once
  });
});
