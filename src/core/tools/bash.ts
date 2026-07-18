import { Type } from "@sinclair/typebox";
import { startBackground } from "../background.js";
import {
  bashToolDescriptionSuffix,
  detectRuntimeEnv,
  findPosixShell,
  shellEnv,
  type RuntimeEnv,
} from "../runtime-env.js";
import type { ToolDef } from "../types.js";

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;

// cmd.exe builtins / idioms that Git Bash mangles (e.g. `dir /b` → "cannot access '/b'").
const CMD_BUILTINS = new Set([
  "dir",
  "copy",
  "xcopy",
  "move",
  "ren",
  "rename",
  "del",
  "erase",
  "rd",
  "rmdir",
  "md",
  "mkdir",
  "type",
  "cls",
  "ver",
  "vol",
  "label",
  "attrib",
  "chkdsk",
  "fc",
  "find",
  "findstr",
  "more",
  "sort",
  "tree",
  "where",
  "set",
  "setx",
  "assoc",
  "ftype",
  "start",
  "tasklist",
  "taskkill",
  "systeminfo",
  "ipconfig",
  "netstat",
  "ping",
  "tracert",
  "nslookup",
  "wmic",
  "powershell",
  "pwsh",
  "cmd",
]);

/** True when the command is clearly meant for cmd.exe, not bash. */
export function looksLikeWindowsCmd(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Explicit shells
  if (/^(cmd(\.exe)?|powershell(\.exe)?|pwsh(\.exe)?)\b/i.test(trimmed)) return true;
  // Drive-letter path or backslash-heavy Windows path as first token
  if (/^[A-Za-z]:\\/.test(trimmed) || /^\\/.test(trimmed)) return true;
  // First token is a cmd builtin
  const first = trimmed.split(/\s+/)[0]?.toLowerCase().replace(/\.exe$/i, "") ?? "";
  if (CMD_BUILTINS.has(first)) return true;
  // cmd-style switches: " /b", " /s", " /a:", " /q" after a token (not POSIX -flags alone)
  // e.g. `dir /b`, `copy /y`, `del /f /q`
  if (/\s\/[a-zA-Z?](?:\s|$|:)/.test(` ${trimmed}`)) return true;
  return false;
}

export function shellArgv(command: string, env: RuntimeEnv = detectRuntimeEnv()): string[] {
  if (process.platform !== "win32") {
    return [env.posixShell ?? "sh", "-c", command];
  }
  // Windows-native / cmd idioms must not go through Git Bash.
  if (looksLikeWindowsCmd(command)) {
    return [process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", command];
  }
  const sh = env.posixShell ?? findPosixShell(env.gitRoot);
  if (sh) return [sh, "-c", command];
  return [process.env.COMSPEC ?? "cmd.exe", "/d", "/s", "/c", command];
}

function firstCommandToken(command: string): string {
  // Strip env assigns: FOO=1 bar → bar; skip leading sudo
  let rest = command.trim();
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.test(rest)) {
    rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "");
  }
  if (/^sudo\s+/.test(rest)) rest = rest.replace(/^sudo\s+/, "");
  const tok = rest.split(/[\s|;&#]+/)[0]?.replace(/^["']|["']$/g, "") ?? "";
  return tok.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
}

/**
 * True only when the *binary itself* is missing — not when a file argument is missing.
 * Avoids false positives like: `rm gone.txt; ls gone.txt` → "No such file or directory".
 */
export function isMissingBinaryError(command: string, output: string): boolean {
  if (!output) return false;
  const base = firstCommandToken(command);
  if (!base) return false;
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Windows cmd: 'shuf' is not recognized as an internal or external command
  if (new RegExp(`['"]?${esc}['"]?\\s+is not recognized as an internal or external command`, "i").test(output)) {
    return true;
  }
  // bash/zsh: "bash: shuf: command not found" / "shuf: command not found"
  if (new RegExp(`(?:^|[\\s:\`])${esc}:\\s*command not found`, "im").test(output)) return true;
  if (new RegExp(`command not found:\\s*${esc}\\b`, "i").test(output)) return true;
  // dash: "sh: 1: shuf: not found" (binary not found — not a path argument)
  if (new RegExp(`:\\s*${esc}:\\s*not found\\s*$`, "im").test(output)) return true;
  // PowerShell: The term 'shuf' is not recognized...
  if (new RegExp(`The term ['"]${esc}['"] is not recognized`, "i").test(output)) return true;

  // Do NOT match generic "No such file or directory" / "cannot access" — those are file args.
  return false;
}

/** Hint when a binary is missing on this OS — steer the model toward correct tools. */
function missingCommandHint(command: string, output: string, env: RuntimeEnv): string {
  if (!isMissingBinaryError(command, output)) return "";
  const base = firstCommandToken(command);
  const lines = [
    "",
    `[devcode: host is ${env.osLabel}; shell=${env.shellKind}]`,
    base
      ? `Command "${base}" is not available in this environment.`
      : "Command is not available in this environment.",
  ];
  if (env.isWindows) {
    lines.push(
      "Retry with: DevCode tools (read/write/edit/grep/glob), bun/node one-liners, or PowerShell — not Linux-only binaries from cmd.",
    );
    if (env.posixShell) {
      lines.push("POSIX tools should run via Git Bash (auto-selected for non-cmd commands). Ensure the binary exists under Git usr/bin.");
    }
  } else {
    lines.push("Install the tool, use an alternative available on this OS, or prefer DevCode file tools.");
  }
  return lines.join("\n");
}

function buildDescription(): string {
  const base = `Run a shell command and return combined stdout/stderr. Default timeout ${DEFAULT_TIMEOUT_SEC}s (max ${MAX_TIMEOUT_SEC}s).`;
  return `${base} ${bashToolDescriptionSuffix()}`;
}

export function createBashTool(cwd: string = process.cwd()): ToolDef {
  return {
  name: "bash",
  description: buildDescription(),
  schema: Type.Object({
    command: Type.String({
      description:
        "Shell command to execute. Must be valid on the host OS (see system prompt Host environment). Prefer DevCode file tools over cat/sed.",
    }),
    timeout: Type.Optional(
      Type.Number({ description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC})` }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description:
          "If true, start the command in the background and return a bg-N id immediately. Use background_task to read/kill.",
      }),
    ),
  }),
  async execute(_id, input, signal) {
    const { command, timeout, run_in_background } = input as {
      command: string;
      timeout?: number;
      run_in_background?: boolean;
    };
    if (run_in_background) {
      const t = startBackground(command);
      return {
        content: `Started background task ${t.id}\nUse background_task action=read id=${t.id} to poll output.`,
      };
    }
    const timeoutSec = Math.min(Math.max(timeout ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC);
    const runtime = detectRuntimeEnv(cwd);
    const argv = shellArgv(command, runtime);
    // Always inject Git coreutils on Windows so shuf/ls/etc. resolve even under cmd fallback.
    const env = shellEnv(runtime.pathExtras);
    const proc = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      env,
      cwd,
    });

    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutSec * 1000);
    const onAbort = (): void => {
      aborted = true;
      proc.kill();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);

    try {
      const [out, err, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const combined = err ? (out ? `${out}\n${err}` : err) : out;
      const output = combined.trimEnd();
      if (timedOut) return { content: `Command timed out after ${timeoutSec}s\n${output}`, is_error: true };
      if (aborted) return { content: "Aborted by user", is_error: true };
      if (exitCode !== 0) {
        // Only add OS hints when the shell binary itself is missing — not for
        // normal failures (missing files, non-zero grep, compound cmd tails, …).
        const hint = missingCommandHint(command, output, runtime);
        return {
          content: `Exit code ${exitCode}\n${output}${hint}`,
          is_error: true,
        };
      }
      return { content: output };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  },
};
}

/** Default instance bound to process.cwd() at import time (tests / simple use). */
export const bashTool: ToolDef = createBashTool();

// Re-export for tests / callers that used to import from bash.ts
export { findPosixShell } from "../runtime-env.js";
