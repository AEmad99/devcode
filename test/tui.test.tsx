import { describe, expect, test } from "bun:test";
import React from "react";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { appVersion, BRAND } from "../src/tui/brand.js";
import { Header, LOGO_LINES } from "../src/tui/components/Header.js";
import { InputBox } from "../src/tui/components/InputBox.js";
import { LoginFlow } from "../src/tui/components/LoginFlow.js";
import { ModelPicker } from "../src/tui/components/ModelPicker.js";
import { PermissionPrompt } from "../src/tui/components/PermissionPrompt.js";
import { ScrollToEnd } from "../src/tui/components/ScrollToEnd.js";
import { listForDisplay } from "../src/tui/components/MessageList.js";
import { shortPath, ToolBlock } from "../src/tui/components/ToolBlock.js";
import { initialState, reducer, type Entry, type State } from "../src/tui/store.js";
import { THEMES } from "../src/tui/theme.js";
import type { Usage } from "../src/core/types.js";
import type { ProviderSpec } from "../src/providers/registry.js";

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const theme = THEMES.claude;

describe("Header (filled block wordmark)", () => {
  test("renders centered filled blocks, name, version — no line or clutter", async () => {
    const { lastFrame, unmount } = render(<Header theme={theme} version="0.1.0" />);
    await tick(40);
    const frame = lastFrame() ?? "";
    // Filled █ style (Claude Code / Gemini CLI tradition)
    expect(frame).toContain("█");
    expect(frame).toContain(LOGO_LINES[0].trim().slice(0, 8));
    expect(frame).toContain("DevCode");
    expect(frame).toContain("v0.1.0");
    // No underline, no family strip, no shortcuts
    expect(frame).not.toMatch(/─{10,}/);
    expect(frame).not.toContain("DevTerm");
    expect(frame).not.toContain("/help");
    expect(frame).not.toContain("Ctrl+C");
    unmount();
  });

  test("appVersion reads package.json", () => {
    expect(appVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("ScrollToEnd", () => {
  test("shows jump control when visible", async () => {
    let jumped = false;
    const { lastFrame, stdin, unmount } = render(
      <ScrollToEnd theme={theme} visible unread={3} onJump={() => (jumped = true)} />,
    );
    await tick(40);
    expect(lastFrame() ?? "").toContain("Jump to latest");
    expect(lastFrame() ?? "").toContain("3 new");
    stdin.write("\r");
    await tick(40);
    expect(jumped).toBe(true);
    unmount();
  });

  test("hidden when not visible", async () => {
    const { lastFrame, unmount } = render(
      <ScrollToEnd theme={theme} visible={false} onJump={() => {}} />,
    );
    await tick(20);
    expect(lastFrame() ?? "").not.toContain("Jump to latest");
    unmount();
  });
});

describe("InputBox", () => {
  test("typing chars + Enter submits the value", async () => {
    const submitted: string[] = [];
    const { stdin } = render(<InputBox running={false} onSubmit={(t) => submitted.push(t)} />);
    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted).toEqual(["hello"]);
  });

  test("Ctrl+J inserts a newline", async () => {
    const submitted: string[] = [];
    const { stdin } = render(<InputBox running={false} onSubmit={(t) => submitted.push(t)} />);
    stdin.write("a");
    await tick();
    stdin.write("\n");
    await tick();
    stdin.write("b");
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted).toEqual(["a\nb"]);
  });

  test("Up recalls the previous submission", async () => {
    const submitted: string[] = [];
    const { stdin } = render(<InputBox running={false} onSubmit={(t) => submitted.push(t)} />);
    stdin.write("first");
    await tick();
    stdin.write("\r");
    await tick();
    stdin.write("\x1b[A");
    await tick();
    stdin.write("\r");
    await tick();
    expect(submitted).toEqual(["first", "first"]);
  });

  test("ESC fires the onEscape callback", async () => {
    let escaped = 0;
    const { stdin } = render(<InputBox running={false} onSubmit={() => {}} onEscape={() => escaped++} />);
    stdin.write("\x1b");
    await tick(100); // lone ESC is emitted after Ink's ~20ms pending-escape flush
    expect(escaped).toBe(1);
  });
});

describe("PermissionPrompt", () => {
  const request = { tool: "bash", detail: "git push", input: { command: "git push" } };

  test("Enter resolves with the default option (Yes)", async () => {
    const choices: string[] = [];
    const { stdin } = render(<PermissionPrompt request={request} onResolve={(c) => choices.push(c)} />);
    stdin.write("\r");
    await tick();
    expect(choices).toEqual(["once"]);
  });

  test("↓ navigation + Enter selects don't-ask-again (session)", async () => {
    const choices: string[] = [];
    const { stdin } = render(<PermissionPrompt request={request} onResolve={(c) => choices.push(c)} />);
    stdin.write("\x1b[B"); // down → session option
    await tick();
    stdin.write("\r");
    await tick();
    expect(choices).toEqual(["session"]);
  });

  test("number key 1 picks Yes", async () => {
    const choices: string[] = [];
    const { stdin } = render(<PermissionPrompt request={request} onResolve={(c) => choices.push(c)} />);
    stdin.write("1");
    await tick();
    expect(choices).toEqual(["once"]);
  });

  test("y/a/n shortcuts resolve directly", async () => {
    for (const [keypress, expected] of [
      ["y", "once"],
      ["a", "always"], // Claude Code: always allow → settings
      ["n", "deny"],
    ] as const) {
      const choices: string[] = [];
      const { stdin, unmount } = render(<PermissionPrompt request={request} onResolve={(c) => choices.push(c)} />);
      stdin.write(keypress);
      await tick();
      expect(choices).toEqual([expected]);
      unmount();
    }
  });
});

describe("LoginFlow", () => {
  const fakeProviders: { spec: ProviderSpec; auth: "none" | "env" }[] = [
    {
      spec: {
        id: "anthropic",
        name: "Anthropic (Claude)",
        defaultModel: "claude-sonnet-4-5",
        envKeys: ["ANTHROPIC_API_KEY"],
        apiKey: true,
        oauth: { flowId: "anthropic", tosWarning: true, label: "Claude Pro/Max (OAuth)" },
        create: () => {
          throw new Error("unused");
        },
      },
      auth: "none",
    },
    {
      spec: {
        id: "openai",
        name: "OpenAI (API key)",
        defaultModel: "gpt-5",
        envKeys: ["OPENAI_API_KEY"],
        apiKey: true,
        create: () => {
          throw new Error("unused");
        },
      },
      auth: "env",
    },
    {
      spec: {
        id: "copilot",
        name: "GitHub Copilot",
        defaultModel: "gpt-4.1",
        envKeys: [],
        apiKey: false,
        oauth: { flowId: "copilot", label: "GitHub device login (OAuth)" },
        create: () => {
          throw new Error("unused");
        },
      },
      auth: "none",
    },
  ];

  test("renders searchable providers, then method menu with OAuth first + ToS warning", async () => {
    const { lastFrame, stdin } = render(<LoginFlow providers={fakeProviders} onDone={() => {}} theme={theme} />);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("Log in to a provider");
    expect(frame).toMatch(/search|type to/i);
    expect(frame).toContain("Anthropic (Claude)");
    expect(frame).toContain("[none]");
    expect(frame).toContain("oauth+key");
    expect(frame).toContain("OpenAI (API key)");
    expect(frame).toContain("[env]");

    stdin.write("\r"); // select first provider → method menu
    await tick();
    frame = lastFrame() ?? "";
    expect(frame).toContain("Claude Pro/Max (OAuth)");
    expect(frame).toContain("Paste API key");
    expect(frame).toContain("may violate the provider's ToS");
  });

  test("type-to-search filters providers (frictionless)", async () => {
    const { lastFrame, stdin, unmount } = render(
      <LoginFlow providers={fakeProviders} onDone={() => {}} theme={theme} />,
    );
    await tick(40);
    stdin.write("copi");
    await tick(60);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("copi");
    expect(frame).toContain("GitHub Copilot");
    expect(frame).not.toContain("Anthropic (Claude)");
    unmount();
  });

  test("oauth-only provider skips method menu and starts OAuth path", async () => {
    const { lastFrame, stdin } = render(<LoginFlow providers={fakeProviders} onDone={() => {}} theme={theme} />);
    // Move to copilot (index 2)
    stdin.write("\x1b[B");
    await tick();
    stdin.write("\x1b[B");
    await tick();
    stdin.write("\r");
    await tick(80);
    const frame = lastFrame() ?? "";
    // Single-method providers jump straight into busy/OAuth
    expect(frame).toContain("GitHub Copilot");
    expect(frame).toMatch(/Starting OAuth|Go to|Login failed|device/i);
  });
});

describe("ModelPicker search", () => {
  test("type-to-search filters models and Enter picks", async () => {
    const picked: string[] = [];
    const models = [
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 1_000_000 },
      { id: "claude-opus-4-1", name: "Claude Opus 4.1", contextWindow: 200_000 },
      { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 1_000_000 },
    ];
    const { lastFrame, stdin, unmount } = render(
      <ModelPicker
        theme={theme}
        models={models}
        current="claude-opus-4-1"
        onPick={(id) => picked.push(id)}
        onCancel={() => {}}
      />,
    );
    await tick(40);
    expect(lastFrame() ?? "").toContain("Select model");
    expect(lastFrame() ?? "").toMatch(/search models/i);

    stdin.write("deep");
    await tick(60);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("deepseek-chat");
    expect(frame).not.toContain("claude-sonnet-4-6");

    stdin.write("\r");
    await tick(40);
    expect(picked).toEqual(["deepseek-chat"]);
    unmount();
  });

  test("Esc clears query first, then cancels", async () => {
    let cancelled = false;
    const models = [
      { id: "a-model", name: "A" },
      { id: "b-model", name: "B" },
    ];
    const { lastFrame, stdin, unmount } = render(
      <ModelPicker theme={theme} models={models} onPick={() => {}} onCancel={() => (cancelled = true)} />,
    );
    await tick(40);
    stdin.write("xyz-no-match");
    await tick(40);
    expect(lastFrame() ?? "").toMatch(/No models match|xyz-no-match/i);

    stdin.write("\x1b"); // Esc → clear
    await tick(40);
    expect(cancelled).toBe(false);
    expect(lastFrame() ?? "").toContain("a-model");

    stdin.write("\x1b"); // Esc → cancel
    await tick(40);
    expect(cancelled).toBe(true);
    unmount();
  });
});

describe("StreamingText tail cap", () => {
  test("long streams only paint a tail so the dynamic frame stays short", async () => {
    const { StreamingText } = await import("../src/tui/components/StreamingText.js");
    const body = Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n");
    const { lastFrame, unmount } = render(<StreamingText text={body} theme={theme} maxLines={6} />);
    await tick(40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line-40");
    expect(frame).toContain("line-35");
    expect(frame).not.toContain("line-1");
    expect(frame).toMatch(/34 earlier line/);
    unmount();
  });
});

describe("MessageList listForDisplay", () => {
  const mk = (n: number): Entry[] =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: "info" as const, text: `e${i + 1}` }));

  test("followTail returns the full append-only list (Static must not starve past windowSize)", () => {
    const committed = mk(50);
    const { display, hiddenEarlier } = listForDisplay(committed, {
      followTail: true,
      scrollOffset: 0,
      windowSize: 36,
    });
    expect(display).toHaveLength(50);
    expect(display[display.length - 1].id).toBe(50);
    expect(hiddenEarlier).toBe(0);
  });

  test("scrolled mode windows from the end and reports the hidden count", () => {
    const committed = mk(50);
    const { display, hiddenEarlier } = listForDisplay(committed, {
      followTail: false,
      scrollOffset: 5,
      windowSize: 36,
    });
    expect(display).toHaveLength(36);
    expect(display[display.length - 1].id).toBe(45);
    expect(hiddenEarlier).toBe(9);
  });

  test("jump pins the focused entry into the window", () => {
    const committed = mk(50);
    const { display } = listForDisplay(committed, {
      followTail: false,
      scrollOffset: 0,
      windowSize: 36,
      jumpFocusId: 10,
    });
    expect(display[0].id).toBe(8);
    expect(display.some((e) => e.id === 10)).toBe(true);
  });
});

describe("store reducer", () => {
  const usage: Usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };

  test("tool_start/tool_end produce committed entries", () => {
    let s = initialState;
    s = reducer(s, { type: "run_start" });
    s = reducer(s, { type: "text_delta", text: "checking " });
    s = reducer(s, { type: "tool_start", id: "t1", name: "read", input: { path: "x" } });
    expect(s.entries.map((e) => e.kind)).toEqual(["assistant", "tool"]);
    const running = s.entries[1];
    expect(running.kind === "tool" && running.status).toBe("running");
    s = reducer(s, { type: "tool_end", id: "t1", name: "read", result: { content: "data" } });
    const done = s.entries[1];
    expect(done.kind === "tool" && done.status).toBe("done");
    expect(done.kind === "tool" && done.result?.content).toBe("data");
    expect(s.streamingText).toBe("");
  });

  test("turn_end commits streaming text and accumulates usage", () => {
    let s: State = { ...initialState, running: true };
    s = reducer(s, { type: "text_delta", text: "hello" });
    expect(s.streamingText).toBe("hello");
    s = reducer(s, { type: "turn_end", stopReason: "end_turn", usage });
    expect(s.streamingText).toBe("");
    expect(s.entries.at(-1)).toMatchObject({ kind: "assistant", text: "hello" });
    expect(s.running).toBe(false);
    expect(s.usage).toEqual(usage);
  });

  test("scroll up detaches from tail; scroll_to_end reattaches", () => {
    let s = initialState;
    s = reducer(s, { type: "user_submit", text: "hi" });
    expect(s.followTail).toBe(true);
    s = reducer(s, { type: "scroll", delta: 5 });
    expect(s.followTail).toBe(false);
    expect(s.scrollOffset).toBe(5);
    s = reducer(s, { type: "scroll_to_end" });
    expect(s.followTail).toBe(true);
    expect(s.scrollOffset).toBe(0);
  });

  test("thinking_delta accumulates then commits on turn_end", () => {
    let s: State = { ...initialState, running: true };
    s = reducer(s, { type: "thinking_delta", text: "hmm " });
    s = reducer(s, { type: "thinking_delta", text: "yes" });
    expect(s.streamingThinking).toBe("hmm yes");
    s = reducer(s, { type: "turn_end", stopReason: "end_turn", usage });
    expect(s.streamingThinking).toBe("");
    expect(s.entries.some((e) => e.kind === "thinking" && e.text === "hmm yes")).toBe(true);
  });
});

describe("ToolBlock read/write presentation", () => {
  test("shortPath relativizes to cwd with forward slashes", () => {
    const abs = join(process.cwd(), "src", "core", "tools", "index.ts");
    expect(shortPath(abs)).toBe("src/core/tools/index.ts");
    expect(shortPath(abs)).not.toContain("\\");
  });

  test("read shows gutter line numbers, not raw D:\\ paths or @@ headers", async () => {
    const abs = join(process.cwd(), "src", "core", "tools", "index.ts");
    const content = ["1\timport type { TSchema } from \"x\";", "2\timport { foo } from \"./bar\";", "3\t"].join("\n");
    const { lastFrame, unmount } = render(
      <ToolBlock
        name="read"
        input={{ path: abs }}
        status="done"
        result={{ content }}
        theme={theme}
      />,
    );
    await tick(40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("read");
    expect(frame).toContain("src/core/tools/index.ts");
    expect(frame).toContain("│");
    expect(frame).toContain("import type");
    expect(frame).not.toMatch(/D:\\projects/i);
    expect(frame).not.toContain("@@");
    unmount();
  });

  test("write shows create preview without unified-diff @@ header", async () => {
    const abs = join(process.cwd(), "src", "__scratch.ts");
    const { lastFrame, unmount } = render(
      <ToolBlock
        name="write"
        input={{ path: abs, content: 'export const greeting = "hello";\n' }}
        status="done"
        result={{ content: `Wrote 32 bytes to ${abs}` }}
        theme={theme}
      />,
    );
    await tick(40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("write");
    expect(frame).toContain("src/__scratch.ts");
    expect(frame).toContain("export const greeting");
    expect(frame).toMatch(/\+|wrote/i);
    expect(frame).not.toContain("@@");
    expect(frame).not.toContain("Wrote 32 bytes"); // compact summary instead of raw tool string
    unmount();
  });

  test("edit shows soft diff markers and summary, not raw result dump", async () => {
    const { lastFrame, unmount } = render(
      <ToolBlock
        name="edit"
        input={{ path: "src/foo.ts", old_string: "const a = 1;", new_string: "const a = 2;" }}
        status="done"
        result={{ content: "Edited src/foo.ts: replaced 1 occurrence(s)" }}
        theme={theme}
      />,
    );
    await tick(40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("edit");
    expect(frame).toContain("const a = 1");
    expect(frame).toContain("const a = 2");
    expect(frame).toMatch(/replaced 1/i);
    expect(frame).not.toContain("@@ -");
    unmount();
  });
});
