import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionRuntime, type RuntimeDeps } from "../src/extensions/runtime.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const fixture = join(repoRoot, "test", "fixtures", "mcp-server.ts");

let home: string;
let proj: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "devcode-mcp-home-"));
  proj = mkdtempSync(join(tmpdir(), "devcode-mcp-proj-"));
  process.env.DEVCODE_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
});
beforeEach(() => {
  rmSync(join(home, "extensions"), { recursive: true, force: true });
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

describe("MCP bundled extension", () => {
  test("handshake, tool registration, call roundtrip", async () => {
    mkdirSync(join(home, "extensions"), { recursive: true });
    writeFileSync(
      join(home, "extensions", "mcp.ts"),
      readFileSync(join(repoRoot, "extensions", "mcp.ts"), "utf8"),
      "utf8",
    );

    // Point MCP config at the fixture server via bun
    writeFileSync(
      join(home, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            args: [fixture],
          },
        },
      }),
      "utf8",
    );

    const notes: string[] = [];
    const runtime = new ExtensionRuntime(
      makeDeps({
        notify: (t) => notes.push(t),
      }),
    );
    const { errors } = await runtime.load();
    expect(errors).toBe(0);

    const tools = runtime.tools();
    const echo = tools.find((t) => t.name === "mcp_fixture_echo");
    expect(echo).toBeTruthy();

    const res = await echo!.execute("1", { message: "hello" }, new AbortController().signal);
    expect(res.is_error).toBeFalsy();
    expect(res.content).toContain("echo:hello");

    await runtime.reload(); // session_shutdown kills servers
  }, 20_000);
});
