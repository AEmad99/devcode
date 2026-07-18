import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Markdown } from "../src/tui/markdown.js";

describe("Markdown", () => {
  test("heading renders its text without the ## marks", () => {
    const { lastFrame } = render(<Markdown>{"# Hello World"}</Markdown>);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Hello World");
    expect(frame).not.toContain("# Hello");
  });

  test("bold and inline code render their content without markers", () => {
    const { lastFrame } = render(<Markdown>{"some **bold** and `code` here"}</Markdown>);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("bold");
    expect(frame).toContain("code");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("`");
  });

  test("fenced code block renders lines and the language label", () => {
    const { lastFrame } = render(<Markdown>{"```ts\nconst a = 1;\n```"}</Markdown>);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ts");
    expect(frame).toContain("const a = 1;");
  });

  test("unterminated fence renders content gracefully", () => {
    const { lastFrame } = render(<Markdown>{"before\n```\nopen code"}</Markdown>);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("before");
    expect(frame).toContain("open code");
  });

  test("bullets and quotes render with markers", () => {
    const { lastFrame } = render(<Markdown>{"- one\n- two\n> quoted line"}</Markdown>);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("•");
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    expect(frame).toContain("│");
    expect(frame).toContain("quoted line");
  });

  test("numbered list keeps the numbers", () => {
    const { lastFrame } = render(<Markdown>{"1. first\n2. second"}</Markdown>);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1. first");
    expect(frame).toContain("2. second");
  });
});
