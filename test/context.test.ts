import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { compactMessages, pruneToolOutputs, shouldCompact, spillCap } from "../src/core/context.js";
import { defaultTools } from "../src/core/tools/index.js";
import type { Message, StreamEvent, Usage } from "../src/core/types.js";
import type { Provider, StreamParams } from "../src/providers/types.js";

let home: string;
beforeAll(() => {
  home = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-ctx-`);
  process.env.DEVCODE_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
});

const textMsg = (role: "user" | "assistant", text: string): Message => ({ role, content: [{ type: "text", text }] });
const toolResultsMsg = (contents: string[]): Message => ({
  role: "user",
  content: contents.map((content, i) => ({ type: "tool_result" as const, tool_use_id: `t${i}`, content })),
});
const toolResultText = (m: Message, i = 0): string => {
  const b = m.content[i];
  return b.type === "tool_result" ? b.content : "";
};

describe("spillCap", () => {
  test("small text passes through unchanged", () => {
    expect(spillCap("hello", 100)).toBe("hello");
  });

  test("oversized text spills to a file with head+tail+marker", () => {
    const big = "x".repeat(10000);
    const out = spillCap(big, 1000);
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain("bytes truncated; full output at");
    const m = /full output at (.+?) —/.exec(out);
    expect(m).not.toBeNull();
    expect(existsSync(m![1])).toBe(true);
    expect(readFileSync(m![1], "utf8")).toBe(big);
    expect(out.startsWith("x".repeat(600))).toBe(true);
    expect(out.endsWith("x".repeat(400))).toBe(true);
  });

  test("wrapped bash spills huge command output to disk", async () => {
    const bash = defaultTools("spill-test").find((t) => t.name === "bash")!;
    const res = await bash.execute(
      "1",
      { command: `bun -e "process.stdout.write('y'.repeat(204800))"` },
      new AbortController().signal,
    );
    expect(res.content.length).toBeLessThan(32 * 1024);
    expect(res.content).toContain("full output at");
    const m = /full output at (.+?) —/.exec(res.content);
    expect(m).not.toBeNull();
    expect(existsSync(m![1])).toBe(true);
    expect(readFileSync(m![1], "utf8").length).toBe(204800);
  }, 20000);
});

describe("pruneToolOutputs", () => {
  test("protects the recent tail, clears old big outputs, keeps small ones", () => {
    const big1 = "a".repeat(2000);
    const big2 = "b".repeat(2000);
    const small = "c".repeat(100);
    const messages: Message[] = [
      textMsg("user", "start"),
      toolResultsMsg([big1]), // 500 tokens — past the protected tail once big2 is counted
      textMsg("assistant", "mid"),
      toolResultsMsg([big2]), // 500 tokens — protected
      toolResultsMsg([small]), // 25 tokens — protected
    ];
    const pruned = pruneToolOutputs(messages, 1000);
    expect(pruned).toBe(1);
    expect(toolResultText(messages[1])).toBe("[cleared: old tool output pruned]");
    expect(toolResultText(messages[3])).toBe(big2);
    expect(toolResultText(messages[4])).toBe(small);
  });
});

describe("shouldCompact", () => {
  const u = (input: number, cacheRead: number, output: number): Usage => ({ input, cacheRead, output, cacheWrite: 0 });
  test("claude models use the 200k window", () => {
    expect(shouldCompact(u(150_000, 5_000, 1_000), "claude-sonnet-4-5")).toBe(true); // 156k > 153k
    expect(shouldCompact(u(100_000, 0, 0), "claude-sonnet-4-5")).toBe(false);
  });
  test("other models use the 128k window", () => {
    expect(shouldCompact(u(95_000, 0, 0), "some-other-model")).toBe(true); // threshold 91.8k
    expect(shouldCompact(u(50_000, 0, 0), "some-other-model")).toBe(false);
  });
});

describe("compactMessages", () => {
  class SummaryProvider implements Provider {
    id = "fake";
    defaultModel = "fake";
    lastParams?: StreamParams;
    stream(params: StreamParams): AsyncIterable<StreamEvent> {
      this.lastParams = params;
      return (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", text: "1) Did stuff 2) Doing more" };
        yield {
          type: "done",
          stopReason: "end_turn",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          message: { role: "assistant", content: [{ type: "text", text: "1) Did stuff 2) Doing more" }] },
        };
      })();
    }
  }

  test("summarizes history into a single continuation message", async () => {
    const provider = new SummaryProvider();
    const history: Message[] = [textMsg("user", "hi"), textMsg("assistant", "hello")];
    const compacted = await compactMessages(provider, history, "fake", new AbortController().signal);
    expect(compacted.length).toBe(1);
    expect(compacted[0].role).toBe("user");
    const block = compacted[0].content[0];
    const text = block.type === "text" ? block.text : "";
    expect(text).toContain("1) Did stuff");
    expect(text).toContain("Continue where you left off.");
    expect(provider.lastParams!.tools).toEqual([]);
    expect(provider.lastParams!.messages.length).toBe(3); // 2 history + compact instruction
  });
});
