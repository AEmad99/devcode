import React, { memo } from "react";
import { Text } from "ink";
import { homedir } from "node:os";
import { formatContextUsage, getLimits } from "../../core/limits.js";
import type { Usage } from "../../core/types.js";
import type { Theme } from "../theme.js";

const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

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

  const parts: string[] = [];
  if (pid) parts.push(pid);
  parts.push(model);
  parts.push(shortCwd);
  parts.push(`ctx ${ctx}`);
  parts.push(`↑${fmt(usage.input)} ↓${fmt(usage.output)} $${cost.toFixed(3)}`);
  if (thinkingLabel && !thinkingLabel.endsWith(":off")) parts.push(thinkingLabel);
  if (queued > 0) parts.push(`q:${queued}`);
  if (bgRunning && bgRunning > 0) parts.push(`bg:${bgRunning}`);
  if (running) parts.push("esc interrupt");

  let line = `  ${parts.join("  ·  ")}  `;
  if (width && width > 4 && line.length > width) {
    line = `${line.slice(0, Math.max(0, width - 1))}…`;
  }

  return (
    <Text backgroundColor={theme.statusBg} color={theme.statusFg ?? "black"} bold wrap="truncate">
      {line}
    </Text>
  );
});
