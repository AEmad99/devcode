import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { InputBox } from "../src/tui/components/InputBox.js";
import { SLASH_COMMANDS } from "../src/tui/slash.js";
import { THEMES } from "../src/tui/theme.js";

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

describe("slash command dropdown", () => {
  test("typing / shows the command dropdown", async () => {
    const { lastFrame, stdin, unmount } = render(
      <InputBox running={false} slashCommands={SLASH_COMMANDS} theme={THEMES.claude} onSubmit={() => {}} />,
    );
    stdin.write("/");
    await tick(40);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("help");
    expect(frame).toContain("clear");
    expect(frame).toContain("exit");
    unmount();
  });

  test("picking /thinking then a space shows the thinking-level dropdown", async () => {
    const { lastFrame, stdin, unmount } = render(
      <InputBox running={false} slashCommands={SLASH_COMMANDS} theme={THEMES.claude} onSubmit={() => {}} />,
    );
    // Type the command name + trailing space (the arg dropdown trigger).
    stdin.write("/thinking ");
    await tick(40);
    const frame = lastFrame() ?? "";
    // Argument options for /thinking appear as a dropdown, not free-form text.
    expect(frame).toContain("/thinking off");
    expect(frame).toContain("/thinking max");
    unmount();
  });

  test("typing a partial arg filters the arg dropdown", async () => {
    const { lastFrame, stdin, unmount } = render(
      <InputBox running={false} slashCommands={SLASH_COMMANDS} theme={THEMES.claude} onSubmit={() => {}} />,
    );
    stdin.write("/thinking h");
    await tick(40);
    const frame = lastFrame() ?? "";
    // "high" starts with "h"; "off"/"low"/"medium"/"max" do not start with h.
    expect(frame).toContain("/thinking high");
    expect(frame).not.toContain("/thinking off");
    unmount();
  });

  test("Enter on the highlighted arg option commits it to the buffer", async () => {
    const submitted: string[] = [];
    const { stdin, unmount } = render(
      <InputBox running={false} slashCommands={SLASH_COMMANDS} theme={THEMES.claude} onSubmit={(t) => submitted.push(t)} />,
    );
    // /thinking <space> opens the dropdown (first option highlighted = off);
    // pressing Enter selects "off" and fills the buffer. A second Enter submits.
    stdin.write("/thinking ");
    await tick(40);
    stdin.write("\r");
    await tick(40);
    // Buffer should now be "/thinking off"; submitting it should deliver that.
    stdin.write("\r");
    await tick(40);
    expect(submitted).toContain("/thinking off");
    unmount();
  });

  test("commands without an args list stay plain (no arg dropdown)", async () => {
    const { lastFrame, stdin, unmount } = render(
      <InputBox running={false} slashCommands={SLASH_COMMANDS} theme={THEMES.claude} onSubmit={() => {}} />,
    );
    stdin.write("/help x");
    await tick(40);
    const frame = lastFrame() ?? "";
    // /help has no args field, so no option dropdown (❯ marker) is rendered
    // above the input box — only the raw input line shows.
    expect(frame).not.toContain("❯ /help");
    unmount();
  });
});