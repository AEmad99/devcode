import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import {
  PermissionEngine,
  suggestPermissionRule,
  wrapToolsWithPermissions,
} from "../src/core/permissions.js";
import type { ToolDef } from "../src/core/types.js";

const signal = () => new AbortController().signal;

describe("PermissionEngine", () => {
  test("circuit breaker denies rm -rf root/home variants", () => {
    const e = new PermissionEngine();
    for (const cmd of [
      "rm -rf /",
      "rm -rf ~",
      "rm -rf $HOME",
      "rm -fr /",
      "rm -r -f ~",
      "sudo rm -rf /",
      "cd /tmp && rm -rf ~",
      "rm -rf $HOME ",
    ]) {
      expect(e.check("bash", { command: cmd })).toBe("deny");
    }
  });

  test("circuit breaker survives session-allow-all on bash", () => {
    const e = new PermissionEngine();
    e.rememberSession("bash");
    expect(e.check("bash", { command: "git push" })).toBe("allow");
    expect(e.check("bash", { command: "rm -rf /" })).toBe("deny");
    expect(e.check("bash", { command: "rm -rf ~/" })).toBe("deny");
  });

  test("circuit breaker denies writes inside .git", () => {
    const e = new PermissionEngine();
    expect(e.check("write", { path: ".git/config" })).toBe("deny");
    expect(e.check("edit", { path: "repo/.git/HEAD" })).toBe("deny");
    expect(e.check("write", { path: "./.git/hooks/pre-commit" })).toBe("deny");
    expect(e.check("write", { path: ".gitignore" })).toBe("ask"); // .gitignore is not .git/
  });

  test("seeded bash prefixes are allowed, everything else asks", () => {
    const e = new PermissionEngine();
    expect(e.check("bash", { command: "git status" })).toBe("allow");
    expect(e.check("bash", { command: "git log --oneline -5" })).toBe("allow");
    expect(e.check("bash", { command: "ls -la" })).toBe("allow");
    expect(e.check("bash", { command: "pwd" })).toBe("allow");
    expect(e.check("bash", { command: "git push" })).toBe("ask");
    expect(e.check("bash", { command: "npm install" })).toBe("ask");
  });

  test("session remember works per first token", () => {
    const e = new PermissionEngine();
    e.rememberSession("bash", "git");
    expect(e.check("bash", { command: "git push" })).toBe("allow");
    expect(e.check("bash", { command: "npm install" })).toBe("ask");
  });

  test("read is allowed, edit asks", () => {
    const e = new PermissionEngine();
    expect(e.check("read", { path: "x" })).toBe("allow");
    expect(e.check("edit", { path: "x" })).toBe("ask");
    expect(e.check("write", { path: "x" })).toBe("ask");
  });
});

describe("PermissionEngine persistent rules", () => {
  test("deny beats allow for the same tool", () => {
    const e = new PermissionEngine({ allow: ["bash"], deny: ["bash:npm *"] });
    expect(e.check("bash", { command: "npm install" })).toBe("deny");
    expect(e.check("bash", { command: "git push" })).toBe("allow");
  });

  test("bash:git * allows git commands but not npm", () => {
    const e = new PermissionEngine({ allow: ["bash:git *"] });
    expect(e.check("bash", { command: "git status" })).toBe("allow");
    expect(e.check("bash", { command: "git push" })).toBe("allow");
    expect(e.check("bash", { command: "npm x" })).toBe("ask");
  });

  test("write:src/** matches paths under src only", () => {
    const e = new PermissionEngine({ allow: ["write:src/**"] });
    expect(e.check("write", { path: "src/index.ts" })).toBe("allow");
    expect(e.check("write", { path: "src/core/loop.ts" })).toBe("allow");
    expect(e.check("write", { path: "test/x.ts" })).toBe("ask");
  });

  test("bare bash rule matches every bash invocation", () => {
    const e = new PermissionEngine({ allow: ["bash"] });
    expect(e.check("bash", { command: "npm install" })).toBe("allow");
    expect(e.check("bash", { command: "whatever --flags" })).toBe("allow");
    expect(e.check("write", { path: "x" })).toBe("ask"); // other tools unaffected
  });

  test("headless fallback allows what would otherwise ask", () => {
    const e = new PermissionEngine(undefined, { headless: true });
    expect(e.check("bash", { command: "npm install" })).toBe("allow");
    expect(e.check("write", { path: "x" })).toBe("allow");
    expect(e.check("bash", { command: "rm -rf /" })).toBe("deny"); // breaker still wins
  });

  test("deny rule cannot be overridden by session remember", () => {
    const e = new PermissionEngine({ deny: ["bash:git *"] });
    e.rememberSession("bash"); // session allow-all
    expect(e.check("bash", { command: "git push" })).toBe("deny");
    expect(e.check("bash", { command: "npm install" })).toBe("allow"); // session remember still works
  });

  test("allow rule cannot whitelist .git/ writes", () => {
    const e = new PermissionEngine({ allow: ["write:**"] });
    expect(e.check("write", { path: ".git/config" })).toBe("deny"); // circuit breaker beats rules
    expect(e.check("write", { path: "src/x.ts" })).toBe("allow");
  });

  test("session remember still grants allows alongside allow rules", () => {
    const e = new PermissionEngine({ allow: ["bash:npm *"] });
    e.rememberSession("bash", "git");
    expect(e.check("bash", { command: "git push" })).toBe("allow"); // session remember
    expect(e.check("bash", { command: "npm test" })).toBe("allow"); // allow rule
    expect(e.check("bash", { command: "make build" })).toBe("ask");
  });

  test("rules are exposed for display", () => {
    const e = new PermissionEngine({ allow: ["bash:git *"], deny: ["write:.env*"] });
    expect(e.rules.allow).toEqual(["bash:git *"]);
    expect(e.rules.deny).toEqual(["write:.env*"]);
  });
});

describe("wrapToolsWithPermissions", () => {
  const makeTool = (onExec: () => void): ToolDef => ({
    name: "bash",
    description: "fake bash",
    schema: Type.Object({ command: Type.String() }),
    execute: async () => {
      onExec();
      return { content: "ran" };
    },
  });

  test("circuit-breaker deny returns is_error without executing", async () => {
    let ran = false;
    const [wrapped] = wrapToolsWithPermissions([makeTool(() => (ran = true))], new PermissionEngine(), async () => "once");
    const res = await wrapped.execute("1", { command: "rm -rf /" }, signal());
    expect(res.is_error).toBe(true);
    expect(res.content).toContain("Permission denied");
    expect(ran).toBe(false);
  });

  test("ask → once executes; ask → deny returns is_error", async () => {
    let runs = 0;
    const engine = new PermissionEngine();
    const [onceTool] = wrapToolsWithPermissions([makeTool(() => runs++)], engine, async () => "once" as const);
    const res = await onceTool.execute("1", { command: "git push" }, signal());
    expect(res.content).toBe("ran");
    expect(runs).toBe(1);

    const [denyTool] = wrapToolsWithPermissions([makeTool(() => runs++)], engine, async () => "deny" as const);
    const res2 = await denyTool.execute("2", { command: "npm install" }, signal());
    expect(res2.is_error).toBe(true);
    expect(runs).toBe(1);
  });

  test("ask → session remembers by first token", async () => {
    const engine = new PermissionEngine();
    const asks: string[] = [];
    const [wrapped] = wrapToolsWithPermissions([makeTool(() => {})], engine, async (req) => {
      asks.push(req.detail);
      return "session" as const;
    });
    await wrapped.execute("1", { command: "git push" }, signal());
    const res = await wrapped.execute("2", { command: "git fetch" }, signal()); // same first token: no prompt
    expect(res.content).toBe("ran");
    expect(asks.length).toBe(1);
    await wrapped.execute("3", { command: "npm test" }, signal()); // different token: prompts again
    expect(asks.length).toBe(2);
  });

  test("ask → always persists allow rule and onPersist fires", async () => {
    const engine = new PermissionEngine();
    const persisted: string[][] = [];
    const [wrapped] = wrapToolsWithPermissions(
      [makeTool(() => {})],
      engine,
      async () => "always" as const,
      {
        onPersist: (r) => persisted.push([...r.allow]),
      },
    );
    await wrapped.execute("1", { command: "npm install" }, signal());
    expect(engine.rules.allow.some((r) => r.startsWith("bash:npm"))).toBe(true);
    expect(persisted.length).toBe(1);
    // second call should not ask
    let asked = false;
    const [w2] = wrapToolsWithPermissions([makeTool(() => {})], engine, async () => {
      asked = true;
      return "once";
    });
    await w2.execute("2", { command: "npm test" }, signal());
    expect(asked).toBe(false);
  });

  test("ask → always_deny blocks without executing", async () => {
    let ran = false;
    const engine = new PermissionEngine();
    const [wrapped] = wrapToolsWithPermissions([makeTool(() => (ran = true))], engine, async () => "always_deny");
    const res = await wrapped.execute("1", { command: "curl http://x" }, signal());
    expect(res.is_error).toBe(true);
    expect(ran).toBe(false);
    expect(engine.rules.deny.some((r) => r.includes("curl"))).toBe(true);
  });
});

describe("PermissionEngine modes + rules helpers", () => {
  test("suggestPermissionRule for bash uses first token + *", () => {
    expect(suggestPermissionRule("bash", { command: "npm install foo" })).toBe("bash:npm *");
    expect(suggestPermissionRule("write", { path: "src/a.ts" })).toBe("write:src/**");
  });

  test("acceptEdits mode auto-allows write/edit but still asks bash", () => {
    const e = new PermissionEngine({ defaultMode: "acceptEdits" });
    expect(e.check("write", { path: "x.ts" })).toBe("allow");
    expect(e.check("edit", { path: "x.ts" })).toBe("allow");
    expect(e.check("bash", { command: "npm install" })).toBe("ask");
  });

  test("bypassPermissions allows mutating tools (breakers still deny)", () => {
    const e = new PermissionEngine({ defaultMode: "bypassPermissions" });
    expect(e.check("bash", { command: "npm install" })).toBe("allow");
    expect(e.check("write", { path: "x.ts" })).toBe("allow");
    expect(e.check("bash", { command: "rm -rf /" })).toBe("deny");
  });

  test("acceptEditsThisSession then write is allow", () => {
    const e = new PermissionEngine();
    expect(e.check("write", { path: "x" })).toBe("ask");
    e.acceptEditsThisSession();
    expect(e.check("write", { path: "x" })).toBe("allow");
    expect(e.check("edit", { path: "y" })).toBe("allow");
    expect(e.check("bash", { command: "npm i" })).toBe("ask");
  });

  test("add/remove persistent rules", () => {
    const e = new PermissionEngine();
    e.addPersistentRule("bash:git *", "allow");
    expect(e.check("bash", { command: "git push" })).toBe("allow");
    e.removePersistentRule("bash:git *", "allow");
    expect(e.check("bash", { command: "git push" })).toBe("ask");
  });
});
