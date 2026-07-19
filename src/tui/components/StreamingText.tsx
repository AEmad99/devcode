import React, { memo, useMemo } from "react";
import { Box, Text } from "ink";
import { Markdown } from "../markdown.js";
import type { Theme } from "../theme.js";

/**
 * Live-stream render of the model's assistant text.
 *
 * Design rule: the streamed view must produce the same character-for-character
 * output as the committed view. We achieve this by running the identical
 * <Markdown> renderer on the partial text. The markdown parser is incremental:
 *
 *   "**bo"        → plain "**bo"   (incomplete bold span)
 *   "**bold**"    → "bold"         (bold)
 *   "```ts\nfoo"  → "ts", "foo"    (partial code block, language label visible)
 *
 * The streamed view never has raw fence markers visible mid-stream because the
 * parser sees the same partial string the final view will see if the stream
 * were to terminate right now. There is no "preview → final correction" jump.
 *
 * Performance:
 *   - parseBlocks / renderInline are pure over the input string
 *   - useMemo keyed on `text` so parent re-renders don't re-parse unchanged text
 *   - Cap visible lines so the dynamic Ink frame stays shorter than the
 *     terminal viewport. On Windows, Ink clears the whole screen for fullscreen
 *     frames; overflowing dynamic output also forces a full clear.
 *   - The full text is kept in state and committed into <Static> when the turn
 *     ends, where it stays in scrollback.
 */
export const StreamingText = memo(function StreamingText({
  text,
  theme,
  maxLines = 24,
  width,
}: {
  text: string;
  theme?: Theme;
  /** Max lines shown while streaming (tail). Default 24. */
  maxLines?: number;
  /**
   * Terminal columns to wrap to. Defaults to undefined (Ink wraps to parent
   * width). Pass the parent column width so streaming wrap matches the
   * committed message width — they read as the same line.
   */
  width?: number;
}) {
  const { body, hidden } = useMemo(() => {
    if (!text) return { body: "", hidden: 0 };
    const lines = text.split("\n");
    if (lines.length <= maxLines) return { body: text, hidden: 0 };
    return {
      body: lines.slice(-maxLines).join("\n"),
      hidden: lines.length - maxLines,
    };
  }, [text, maxLines]);

  if (!text) return null;

  // Render markdown inline so partial bold/code/headings/fences appear the
  // moment the closing delimiter lands. The trailing cursor marks the active
  // stream so the eye knows more text may arrive.
  return (
    <Box flexDirection="column" width={width}>
      {hidden > 0 ? (
        <Text color={theme?.muted ?? "gray"} dimColor>
          … {hidden} earlier line{hidden === 1 ? "" : "s"}
        </Text>
      ) : null}
      <Markdown theme={theme}>{body}</Markdown>
      <Text color={theme?.accent ?? "cyan"}>▍</Text>
    </Box>
  );
});
