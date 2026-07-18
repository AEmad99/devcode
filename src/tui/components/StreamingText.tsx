import React, { memo } from "react";
import { Box, Text } from "ink";
import type { Theme } from "../theme.js";

/**
 * Live stream: plain text only.
 * Parsing markdown on every token is the main source of TUI lag.
 * Final markdown is applied when the turn commits into MessageList.
 */
export const StreamingText = memo(function StreamingText({
  text,
  theme,
}: {
  text: string;
  theme?: Theme;
}) {
  if (!text) return null;
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={theme?.text ?? "white"}>{text}</Text>
      <Text color={theme?.accent ?? "cyan"}>▍</Text>
    </Box>
  );
});
