import React, { memo } from "react";
import { Box, Static, Text } from "ink";
import type { Entry } from "../store.js";
import { Markdown } from "../markdown.js";
import type { Theme } from "../theme.js";
import { ToolBlock } from "./ToolBlock.js";

const EntryView = memo(function EntryView({
  entry,
  theme,
  focused,
}: {
  entry: Entry;
  theme: Theme;
  focused?: boolean;
}) {
  switch (entry.kind) {
    case "user": {
      // Strong visual block so you can always find "what I asked".
      // Phase bar on top edge + bordered box distinguishes "user turn" from
      // any system / assistant output even when scrolling fast.
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={focused ? theme.highlight : theme.user} bold>
            {"─ you ─"}
          </Text>
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={focused ? theme.highlight : theme.user}
            paddingX={1}
          >
            <Text color={theme.user} bold>
              {focused ? "▶ current jump" : "❯ you"}
            </Text>
            <Text color={theme.highlight}>{entry.text}</Text>
          </Box>
        </Box>
      );
    }
    case "assistant": {
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.accent} bold>
            {"─ DevCode ─"}
          </Text>
          <Box marginLeft={1}>
            <Markdown theme={theme}>{entry.text}</Markdown>
          </Box>
        </Box>
      );
    }
    case "thinking": {
      // Thinking phase: a sustained box at left with a header, so a long
      // reasoning trace reads as "the agent was thinking" rather than a stream
      // of cyan text bleeding into the next phase.
      const lines = entry.text.split("\n").slice(0, 10);
      return (
        <Box flexDirection="column" marginBottom={1} marginLeft={2}>
          <Text color={theme.thinking}>{"· thinking …"}</Text>
          {lines.map((line, i) => (
            <Text key={i} color={theme.thinking}>
              {"  "}
              {line || " "}
            </Text>
          ))}
        </Box>
      );
    }
    case "tool": {
      return (
        <Box marginBottom={1} marginLeft={1}>
          <ToolBlock
            name={entry.name}
            input={entry.input}
            status={entry.status}
            result={entry.result}
            theme={theme}
            partialJson={entry.partialJson}
          />
        </Box>
      );
    }
    case "info": {
      // System / informational lines: boxed so they're never confused with
      // assistant prose. Subtle border + accent-dim text.
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.accentDim}>{"─ info ─"}</Text>
          <Box marginLeft={1} flexDirection="column" borderStyle="round" borderColor={theme.accentDim} paddingX={1}>
            <Text color={theme.text}>{entry.text}</Text>
          </Box>
        </Box>
      );
    }
    case "error": {
      // Errors always visible: thin error-colored border + bold text.
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.error} bold>
            {"─ error ─"}
          </Text>
          <Box marginLeft={1} flexDirection="column" borderStyle="round" borderColor={theme.error} paddingX={1}>
            <Text color={theme.error} bold>
              ✗ {entry.text}
            </Text>
          </Box>
        </Box>
      );
    }
  }
});

/**
 * Windowing decision for the committed list.
 * followTail: hand Static the FULL append-only list — Ink's <Static> only renders
 * items past its internal rendered-count, so slicing a moving window here would
 * freeze the transcript once more than `windowSize` entries exist.
 * Scrolled / jumped: plain render of a bounded window (Static is unmounted then).
 */
export function listForDisplay(
  committed: Entry[],
  opts: { followTail: boolean; scrollOffset: number; windowSize: number; jumpFocusId?: number | null },
): { display: Entry[]; hiddenEarlier: number } {
  const { followTail, scrollOffset, windowSize, jumpFocusId } = opts;
  if (followTail) return { display: committed, hiddenEarlier: 0 };
  // When jumping to a past user message, pin that entry into the visible window.
  if (jumpFocusId != null) {
    const idx = committed.findIndex((e) => e.id === jumpFocusId);
    if (idx >= 0) {
      const start = Math.max(0, idx - 2);
      const end = Math.min(committed.length, idx + windowSize - 2);
      return { display: committed.slice(start, end), hiddenEarlier: start };
    }
  }
  const end = Math.max(0, committed.length - scrollOffset);
  const start = Math.max(0, end - windowSize);
  return { display: committed.slice(start, end), hiddenEarlier: start };
}

/**
 * Committed history via <Static> so stream ticks don't repaint the transcript.
 * When followTail is true, Static appends into the terminal scrollback permanently.
 * When jumpFocusId is set, that user turn is re-rendered live (highlighted).
 *
 * Keep Static as a shallow child of the app root (not inside a height=termRows
 * flex viewport) — Ink on Windows full-clears any frame that fills the viewport.
 */
export const MessageList = memo(function MessageList({
  entries,
  theme,
  scrollOffset = 0,
  windowSize = 40,
  jumpFocusId,
  width,
}: {
  entries: Entry[];
  theme: Theme;
  scrollOffset?: number;
  windowSize?: number;
  /** Entry id of the user message currently jumped-to */
  jumpFocusId?: number | null;
  /** Terminal columns — reflow wrapping when the window resizes. */
  width?: number;
}) {
  const committed = entries.filter((e) => e.kind !== "tool" || e.status === "done");
  const pending = entries.filter((e) => e.kind === "tool" && e.status === "running");
  const followTail = scrollOffset === 0 && jumpFocusId == null;
  const { display, hiddenEarlier } = listForDisplay(committed, { followTail, scrollOffset, windowSize, jumpFocusId });

  // followTail: Static owns the transcript (scrollback). Pending tools stay in
  // the dynamic frame so their progress can update until they complete and
  // move into Static.
  if (followTail) {
    return (
      <>
        <Static items={display}>
          {(entry) => (
            <Box key={entry.id} flexDirection="column" width={width}>
              <EntryView entry={entry} theme={theme} />
            </Box>
          )}
        </Static>
        {pending.length > 0 ? (
          <Box flexDirection="column" width={width}>
            {pending.map((entry) => (
              <EntryView key={entry.id} entry={entry} theme={theme} />
            ))}
          </Box>
        ) : null}
      </>
    );
  }

  return (
    <Box flexDirection="column" width={width}>
      {jumpFocusId == null && hiddenEarlier > 0 ? (
        <Text color={theme.accentDim}>↑ {hiddenEarlier} earlier · PageUp · [ / ] jump queries</Text>
      ) : null}

      {display.map((entry) => (
        <EntryView
          key={entry.id}
          entry={entry}
          theme={theme}
          focused={jumpFocusId != null && entry.id === jumpFocusId}
        />
      ))}

      {pending.map((entry) => (
        <EntryView key={entry.id} entry={entry} theme={theme} />
      ))}
    </Box>
  );
});

/** Indices of user messages in an entry list (for jump-to-query). */
export function userEntryIds(entries: Entry[]): number[] {
  return entries.filter((e) => e.kind === "user").map((e) => e.id);
}
