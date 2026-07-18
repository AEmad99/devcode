import React from "react";
import { Box, Text } from "ink";
import { createTwoFilesPatch } from "diff";
import type { Theme } from "../theme.js";

export function DiffView({
  oldText,
  newText,
  maxLines = 40,
  theme,
  /** When true (new file), skip hunk headers and only show additions. */
  create = false,
}: {
  oldText: string;
  newText: string;
  maxLines?: number;
  theme?: Theme;
  create?: boolean;
}) {
  const addColor = theme?.success ?? "green";
  const delColor = theme?.error ?? "red";
  const metaColor = theme?.accentDim ?? "cyan";
  const muted = theme?.muted ?? "gray";

  if (create || !oldText) {
    const lines = newText.split("\n");
    // drop trailing empty from split
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) return <Text color={muted}>(empty file)</Text>;
    const shown = lines.slice(0, maxLines);
    const overflow = lines.length - shown.length;
    const width = String(shown.length + (lines.length > shown.length ? lines.length : 0)).length;
    return (
      <Box flexDirection="column" marginLeft={2}>
        {shown.map((line, i) => (
          <Text key={i} color={addColor}>
            {"  + "}
            <Text color={muted}>
              {String(i + 1).padStart(width, " ")}
              {" │ "}
            </Text>
            <Text color={addColor}>{line || " "}</Text>
          </Text>
        ))}
        {overflow > 0 ? (
          <Text color={muted}>
            {"  · "}… {overflow} more line{overflow === 1 ? "" : "s"}
          </Text>
        ) : null}
      </Box>
    );
  }

  const patch = createTwoFilesPatch("before", "after", oldText, newText, "", "");
  const body = patch.split("\n").slice(3); // drop === / --- / +++ header lines
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  if (body.length === 0) return <Text color={muted}>(no changes)</Text>;

  // Drop pure "No newline at end of file" noise
  const filtered = body.filter((l) => !l.startsWith("\\"));
  const shown = filtered.slice(0, maxLines);
  const overflow = filtered.length - shown.length;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((line, i) => {
        if (line.startsWith("@@")) {
          // Soften unified-diff hunk headers: "@@ -1,3 +1,4 @@" → "···"
          return (
            <Text key={i} color={metaColor} dimColor>
              {"  ···"}
            </Text>
          );
        }
        if (line.startsWith("+")) {
          return (
            <Text key={i} color={addColor}>
              {"  + "}
              {line.slice(1) || " "}
            </Text>
          );
        }
        if (line.startsWith("-")) {
          return (
            <Text key={i} color={delColor}>
              {"  − "}
              {line.slice(1) || " "}
            </Text>
          );
        }
        // context line (leading space in unified diff)
        const text = line.startsWith(" ") ? line.slice(1) : line;
        return (
          <Text key={i} color={muted}>
            {"    "}
            {text || " "}
          </Text>
        );
      })}
      {overflow > 0 ? (
        <Text color={muted}>
          {"  · "}… {overflow} more line{overflow === 1 ? "" : "s"}
        </Text>
      ) : null}
    </Box>
  );
}
