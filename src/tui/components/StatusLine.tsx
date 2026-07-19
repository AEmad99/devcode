import React, { memo } from "react";
import { Text } from "ink";
import { homedir } from "node:os";
import { formatContextUsage, getLimits } from "../../core/limits.js";
import type { Usage } from "../../core/types.js";
import type { Theme } from "../theme.js";

const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const DOT = "  ·  ";

/**
 * Render one colored segment of the status bar. Passing the whole status bar
 * as a single <Text> with manual escapes fights Ink's per-segment styling;
 * emitting one <Text> per segment keeps the background fill continuous while
 * letting ink apply per-segment foreground colors.
 */
function seg(value: string, color: string): React.ReactNode {
  return (
    <Text key={value} color={color}>
      {value}
    </Text>
  );
}

export const StatusLine = memo(function StatusLine({
  theme,
  model,
  cwd,
  usage,
  cost,
  queued,
  bgRunning,
  running,
  thinkingLabel,
  providerId,
  contextUsed,
  width,
}: {
  theme: Theme;
  model: string;
  cwd: string;
  usage: Usage;
  cost: number;
  queued: number;
  /** Number of still-running background bash jobs */
  bgRunning?: number;
  running: boolean;
  thinkingLabel?: string;
  providerId?: string;
  /** Estimated tokens currently in the conversation context */
  contextUsed?: number;
  /** Terminal columns — truncate status bar to fit on resize. */
  width?: number;
}) {
  const home = homedir().replace(/\\/g, "/");
  const normCwd = cwd.replace(/\\/g, "/");
  let shortCwd = home && normCwd.startsWith(home) ? `~${normCwd.slice(home.length)}` : normCwd;
  const pid = providerId && providerId !== "fake" ? providerId : undefined;
  const lim = getLimits(pid ?? "unknown", model);
  const used = contextUsed ?? usage.input + usage.cacheRead + usage.output;
  const ctx = formatContextUsage(used, lim.contextWindow);

  // Narrow terminals: shorten cwd first so cost/ctx stay visible.
  if (width && width < 100 && shortCwd.length > 28) {
    shortCwd = `…${shortCwd.slice(-24)}`;
  }

  // Build a flat list of (text, color) so the visual order is obvious and a
  // truncation pass can keep segments intact rather than slicing mid-token.
  type Col = { text: string; color: string };
  const cols: Col[] = [];
  if (pid) cols.push({ text: pid, color: theme.statusFg ?? "black" }); // bg = statusBg
  cols.push({ text: model, color: theme.statusFg ?? "black" });
  cols.push({ text: shortCwd, color: theme.statusFg ?? "black" });
  // ctx meter: color shifts from base → warn → error as it fills up.
  const ctxColor = ctx.endsWith("%")
    ? Number(ctx.slice(0, -1)) >= 90
      ? theme.error
      : Number(ctx.slice(0, -1)) >= 70
        ? theme.warn
        : theme.statusFg ?? "black"
    : theme.statusFg ?? "black";
  cols.push({ text: `ctx ${ctx}`, color: ctxColor });
  cols.push({ text: `↑${fmt(usage.input)} ↓${fmt(usage.output)}`, color: theme.statusFg ?? "black" });
  cols.push({ text: `$${cost.toFixed(3)}`, color: theme.statusFg ?? "black" });
  if (thinkingLabel && !thinkingLabel.endsWith(":off")) {
    cols.push({ text: thinkingLabel, color: theme.statusFg ?? "black" });
  }
  if (queued > 0) cols.push({ text: `q:${queued}`, color: theme.warn });
  if (bgRunning && bgRunning > 0) cols.push({ text: `bg:${bgRunning}`, color: theme.warn });
  if (running) cols.push({ text: "esc interrupt", color: theme.error });

  // Reassemble, then truncate to width if needed. We slice from the tail so
  // the most time-sensitive flags (esc, bg) survive a narrow terminal.
  const sepColor = theme.statusFg ?? "black";
  const flat: Col[] = [];
  cols.forEach((c, i) => {
    if (i > 0) flat.push({ text: DOT, color: sepColor });
    flat.push(c);
  });
  // Estimate total visible width — each segment is the length of its text.
  let totalLen = flat.reduce((n, c) => n + c.text.length, 0);
  if (width && width > 4 && totalLen + 4 > width) {
    // Drop from the head (provider → cwd) until it fits, but keep at least
    // ctx meter + usage + flags.
    while (flat.length > 6 && totalLen + 4 > width) {
      const dropped = flat.shift();
      if (dropped) totalLen -= dropped.text.length;
    }
    flat.unshift({ text: "… ", color: sepColor });
  }

  const padded = [{ text: "  ", color: theme.statusFg ?? "black" }, ...flat, { text: "  ", color: theme.statusFg ?? "black" }];

  return (
    <Text backgroundColor={theme.statusBg} bold wrap="truncate">
      {padded.map((c, i) => (
        <Text key={`${i}:${c.text}`} color={c.color}>
          {c.text}
        </Text>
      ))}
    </Text>
  );
});
