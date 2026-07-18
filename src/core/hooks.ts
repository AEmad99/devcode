/**
 * Declarative lifecycle hooks from settings.json — for users who won't write
 * TypeScript extensions. Mirrors Claude Code's lightweight hook idea:
 * shell commands on tool_call / tool_result / turn_start / turn_end.
 *
 * Config shape (settings.json):
 * {
 *   "hooks": {
 *     "tool_call": [{ "matcher": "bash|write", "command": "echo $TOOL" }],
 *     "tool_result": [{ "command": "…" }],
 *     "turn_start": [{ "command": "…" }],
 *     "turn_end": [{ "command": "…" }]
 *   }
 * }
 *
 * Env vars for commands: DEVCODE_HOOK_EVENT, DEVCODE_HOOK_TOOL, DEVCODE_HOOK_CWD,
 * DEVCODE_HOOK_DETAIL (truncated JSON). tool_call may block when the command
 * exits non-zero and `blockOnFailure` is true.
 */

import { spawn } from "node:child_process";
import type { Settings } from "./settings.js";

export type HookEventName = "tool_call" | "tool_result" | "turn_start" | "turn_end";

export interface HookRule {
  /** Optional regex matched against tool name (tool_* events only). */
  matcher?: string;
  /** Shell command to run. */
  command: string;
  /** When true (tool_call only), non-zero exit blocks the tool. Default false. */
  blockOnFailure?: boolean;
  /** Timeout ms (default 15000). */
  timeoutMs?: number;
}

export type HooksConfig = Partial<Record<HookEventName, HookRule[]>>;

export interface HookRunContext {
  cwd: string;
  event: HookEventName;
  toolName?: string;
  detail?: string;
}

export interface HookBlockResult {
  block: true;
  reason: string;
}

function matchTool(rule: HookRule, toolName?: string): boolean {
  if (!rule.matcher) return true;
  if (!toolName) return false;
  try {
    return new RegExp(rule.matcher).test(toolName);
  } catch {
    return rule.matcher === toolName;
  }
}

function runCommand(
  command: string,
  ctx: HookRunContext,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DEVCODE_HOOK_EVENT: ctx.event,
      DEVCODE_HOOK_CWD: ctx.cwd,
      DEVCODE_HOOK_TOOL: ctx.toolName ?? "",
      DEVCODE_HOOK_DETAIL: (ctx.detail ?? "").slice(0, 4000),
    };
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? (process.env.COMSPEC ?? "cmd.exe") : "sh", isWin ? ["/d", "/s", "/c", command] : ["-c", command], {
      cwd: ctx.cwd,
      env,
      windowsHide: true,
    });
    let output = "";
    const onData = (buf: Buffer): void => {
      output += buf.toString("utf8");
      if (output.length > 8000) output = output.slice(0, 8000);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* */
      }
      resolve({ code: 124, output: output || `hook timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

/** Run all matching hooks for an event. Returns a block result if any tool_call hook blocks. */
export async function runHooks(
  hooks: HooksConfig | undefined,
  ctx: HookRunContext,
): Promise<HookBlockResult | void> {
  if (!hooks) return;
  const rules = hooks[ctx.event];
  if (!rules?.length) return;

  for (const rule of rules) {
    if (!rule.command?.trim()) continue;
    if (!matchTool(rule, ctx.toolName)) continue;
    const timeout = Math.min(Math.max(rule.timeoutMs ?? 15_000, 1000), 120_000);
    const { code, output } = await runCommand(rule.command, ctx, timeout);
    if (ctx.event === "tool_call" && rule.blockOnFailure && code !== 0) {
      return {
        block: true,
        reason: `settings hook blocked ${ctx.toolName ?? "tool"} (exit ${code}): ${output.trim().slice(0, 500) || "no output"}`,
      };
    }
  }
}

export function hooksFromSettings(settings: Settings): HooksConfig | undefined {
  return settings.hooks;
}
