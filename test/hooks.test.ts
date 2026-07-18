import { describe, expect, test } from "bun:test";
import { runHooks, type HooksConfig } from "../src/core/hooks.js";

describe("declarative hooks", () => {
  test("tool_call matcher runs and can block", async () => {
    const hooks: HooksConfig = {
      tool_call: [
        {
          matcher: "^bash$",
          command: process.platform === "win32" ? "exit 1" : "exit 1",
          blockOnFailure: true,
        },
      ],
    };
    const block = await runHooks(hooks, {
      event: "tool_call",
      cwd: process.cwd(),
      toolName: "bash",
      detail: "rm -rf /",
    });
    expect(block?.block).toBe(true);
    expect(block?.reason).toContain("blocked");
  });

  test("non-matching matcher skips", async () => {
    const hooks: HooksConfig = {
      tool_call: [
        {
          matcher: "^write$",
          command: process.platform === "win32" ? "exit 1" : "exit 1",
          blockOnFailure: true,
        },
      ],
    };
    const block = await runHooks(hooks, {
      event: "tool_call",
      cwd: process.cwd(),
      toolName: "bash",
      detail: "ls",
    });
    expect(block).toBeUndefined();
  });

  test("success command does not block", async () => {
    const hooks: HooksConfig = {
      tool_call: [
        {
          command: process.platform === "win32" ? "exit 0" : "true",
          blockOnFailure: true,
        },
      ],
    };
    const block = await runHooks(hooks, {
      event: "tool_call",
      cwd: process.cwd(),
      toolName: "write",
    });
    expect(block).toBeUndefined();
  });
});
