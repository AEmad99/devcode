import React, { memo, useMemo } from "react";
import { Box, Text } from "ink";
import type { Theme } from "../theme.js";

/**
 * Live stream: plain text only.
 * Parsing markdown on every token is the main source of TUI lag.
 * Final markdown is applied when the turn commits into MessageList.
 *
 * Cap visible lines so the dynamic Ink frame stays shorter than the terminal
 * viewport. On Windows, Ink clears the whole screen for fullscreen frames;
 * overflowing dynamic output also forces a full clear. The full text is still
 * kept in state and committed to <Static> when the turn ends.
 */
export const StreamingText = memo(function StreamingText({
  text,
  theme,
  maxLines = 24,
}: {
  text: string;
  theme?: Theme;
  /** Max lines shown while streaming (tail). Default 24. */
  maxLines?: number;
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
  return (
    <Box flexDirection="column" marginLeft={2}>
      {hidden > 0 ? (
        <Text color={theme?.muted ?? "gray"} dimColor>
          … {hidden} earlier line{hidden === 1 ? "" : "s"}
        </Text>
      ) : null}
      <Text color={theme?.text ?? "white"}>{body}</Text>
      <Text color={theme?.accent ?? "cyan"}>▍</Text>
    </Box>
  );
});
