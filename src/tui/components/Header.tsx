import React, { memo } from "react";
import { Box, Text } from "ink";
import { appVersion, BRAND, LOGO_WORDMARK } from "../brand.js";
import type { Theme } from "../theme.js";

export const LOGO_LINES = LOGO_WORDMARK;

/**
 * Centered wordmark for the OpenCode-style welcome screen.
 * No underline, no left alignment — pure logo + quiet caption.
 */
export const Header = memo(function Header({
  theme,
  version = appVersion(),
}: {
  theme: Theme;
  version?: string;
  /** kept for API compat; welcome screen shows meta under the input instead */
  model?: string;
  thinkingLabel?: string;
  cwd?: string;
}) {
  // Measure widest logo line for consistent centering
  const logoWidth = Math.max(...LOGO_WORDMARK.map((l) => l.length));

  return (
    <Box flexDirection="column" alignItems="center" marginBottom={2}>
      <Box flexDirection="column" width={logoWidth} alignItems="flex-start">
        {LOGO_WORDMARK.map((line, i) => (
          <Text key={i} color={theme.accent} bold>
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.highlight} bold>
          {BRAND.name}
        </Text>
        <Text color={theme.accentDim}>{"  v"}{version}</Text>
      </Box>
    </Box>
  );
});
