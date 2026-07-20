import React, { memo, useEffect, useState } from "react";
import { Box, Text } from "ink";
import type { Theme } from "../theme.js";

const WORDS = ["thinking", "reasoning", "analyzing", "planning", "working"];
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Slow animation (250ms) so the rest of the TUI isn't fighting 90ms repaints.
 * Body text is static; only the label spins.
 */
export const ThinkingStream = memo(function ThinkingStream({
  text,
  theme,
  active = true,
  maxLines = 6,
}: {
  text: string;
  theme: Theme;
  active?: boolean;
  /**
   * Max body lines shown. The thinking block lives in the dynamic (non-Static)
   * region; an unbounded tail can push the frame to fullscreen and trigger
   * Ink's scrollback-wiping clearTerminal. Keep it small.
   */
  maxLines?: number;
}) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [active]);

  const word = WORDS[Math.floor(tick / 4) % WORDS.length];
  const spin = SPINNER[tick % SPINNER.length];
  const lines = text ? text.split("\n") : [];
  const cap = Math.max(1, maxLines);
  const tail = lines.slice(-cap);
  const more = lines.length - tail.length;

  return (
    <Box flexDirection="column" marginLeft={2} marginY={0}>
      <Text color={theme.thinking}>
        {active ? `${spin} ${word}…` : "thought"}
        {more > 0 ? `  (+${more} lines)` : ""}
      </Text>
      {tail.map((line, i) => (
        <Text key={i} color={theme.thinking}>
          {line || " "}
        </Text>
      ))}
    </Box>
  );
});
