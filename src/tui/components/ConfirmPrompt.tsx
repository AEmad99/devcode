import React from "react";
import { Box, Text, useInput } from "ink";

// Generic Yes/No modal (extension confirms, project trust). Same look as PermissionPrompt.
export function ConfirmPrompt({
  title,
  detail,
  onResolve,
}: {
  title: string;
  detail?: string;
  onResolve: (yes: boolean) => void;
}) {
  useInput((input, key) => {
    if (key.return || input === "y") onResolve(true);
    else if (input === "n" || key.escape) onResolve(false);
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold>{title}</Text>
      {detail ? (
        <Text dimColor wrap="truncate">
          {detail}
        </Text>
      ) : null}
      <Text>[Y]es / [N]o</Text>
    </Box>
  );
}
