import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Theme } from "../theme.js";

/**
 * Grok Build–style "jump to latest" affordance when the user has scrolled up.
 * Click isn't available in pure Ink without mouse; End / Ctrl+End / Enter also jump.
 */
export function ScrollToEnd({
  theme,
  visible,
  unread = 0,
  onJump,
}: {
  theme: Theme;
  visible: boolean;
  unread?: number;
  onJump: () => void;
}) {
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setPulse((p) => p + 1), 400);
    return () => clearInterval(id);
  }, [visible]);

  useInput(
    (input, key) => {
      if (!visible) return;
      if (key.return || key.end || (key.ctrl && input === "e")) {
        onJump();
      }
    },
    { isActive: visible },
  );

  if (!visible) return null;

  const arrow = pulse % 2 === 0 ? "↓" : "⬇";
  return (
    <Box borderStyle="round" borderColor={theme.accent} paddingX={1} justifyContent="center">
      <Text color={theme.accent} bold>
        {arrow} Jump to latest
        {unread > 0 ? ` · ${unread} new` : ""}
        <Text color={theme.muted} dimColor>
          {"  "}[Enter / End]
        </Text>
      </Text>
    </Box>
  );
}
