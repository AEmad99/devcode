/**
 * Host runtime detection: OS, shell, and which tools are actually available.
 * Used by the system prompt and bash tool so the agent does not invent
 * Linux-only commands on Windows (or vice versa).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type ShellKind = "bash" | "sh" | "cmd" | "powershell" | "unknown";

export interface RuntimeEnv {
  platform: NodeJS.Platform;
  /** Human label: Windows / macOS / Linux / … */
  osLabel: string;
  arch: string;
  cwd: string;
  home: string;
  isWindows: boolean;
  isMac: boolean;
  isLinux: boolean;
  /** Resolved interactive shell path or name */
  shellPath: string;
  shellKind: ShellKind;
  /** Git for Windows install root, when detected */
  gitRoot: string | null;
  /** Absolute path to bash/sh used for POSIX agent commands, if any */
  posixShell: string | null;
  /** Bin dirs to prepend so Git coreutils (shuf, ls, …) resolve */
  pathExtras: string[];
  /** Tools we probed and found on PATH (or via Git extras) */
  available: Record<string, boolean>;
  /** Commands the model must avoid on this host */
  avoid: string[];
  /** Short preferred alternatives for common tasks */
  prefer: string[];
}

const PROBE_TOOLS = [
  "git",
  "rg",
  "node",
  "bun",
  "python",
  "python3",
  "ls",
  "cat",
  "rm",
  "cp",
  "mv",
  "shuf",
  "head",
  "tail",
  "sort",
  "find",
  "grep",
  "sed",
  "awk",
  "curl",
  "powershell",
  "pwsh",
] as const;

function which(name: string): string | null {
  try {
    const found = (Bun as { which?: (n: string) => string | null }).which?.(name);
    return typeof found === "string" && found ? found : null;
  } catch {
    return null;
  }
}

function osLabel(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

/** Locate Git for Windows root (parent of bin/ or cmd/). */
export function findGitRoot(): string | null {
  if (process.platform !== "win32") return null;

  const fromGit = which("git");
  if (fromGit) {
    const norm = fromGit.replace(/\\/g, "/");
    const m =
      norm.match(/^(.*)\/cmd\/git\.exe$/i) ??
      norm.match(/^(.*)\/bin\/git\.exe$/i) ??
      norm.match(/^(.*)\/mingw64\/bin\/git\.exe$/i);
    if (m) {
      const root = m[1].replace(/\//g, "\\");
      if (existsSync(root)) return root;
    }
    // generic: …/git.exe → parent may be cmd or bin
    const parent = dirname(fromGit);
    const grand = dirname(parent);
    if (/[\\/](cmd|bin|mingw64)$/i.test(parent) && existsSync(join(grand, "bin"))) {
      return grand;
    }
  }

  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"];
  const candidates = [
    join(pf, "Git"),
    join(pf86, "Git"),
    local ? join(local, "Programs", "Git") : "",
  ].filter(Boolean);

  for (const root of candidates) {
    if (existsSync(join(root, "bin", "bash.exe")) || existsSync(join(root, "cmd", "git.exe"))) {
      return root;
    }
  }
  return null;
}

/** Prefer a real POSIX shell so agent-authored quoting works. */
export function findPosixShell(gitRoot?: string | null): string | null {
  const root = gitRoot === undefined ? findGitRoot() : gitRoot;

  const candidates: string[] = [];
  for (const name of ["bash", "sh"]) {
    const w = which(name);
    if (w) candidates.push(w);
  }

  if (process.platform === "win32" && root) {
    candidates.push(
      join(root, "bin", "bash.exe"),
      join(root, "usr", "bin", "bash.exe"),
      join(root, "bin", "sh.exe"),
      join(root, "usr", "bin", "sh.exe"),
    );
  }

  if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    candidates.push(
      join(pf, "Git", "bin", "bash.exe"),
      join(pf, "Git", "usr", "bin", "bash.exe"),
      join(pf86, "Git", "bin", "bash.exe"),
      join(pf86, "Git", "usr", "bin", "bash.exe"),
    );
  }

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }

  // Last-resort probe (Unix / rare Windows sh on PATH)
  try {
    const probe = Bun.spawnSync(["sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
    if (probe.exitCode === 0) return "sh";
  } catch {
    // unavailable
  }
  return null;
}

/** Git bin dirs that ship coreutils (ls, shuf, awk, …). */
export function gitPathExtras(gitRoot: string | null = findGitRoot()): string[] {
  if (!gitRoot) return [];
  const dirs = [
    join(gitRoot, "bin"),
    join(gitRoot, "usr", "bin"),
    join(gitRoot, "mingw64", "bin"),
    join(gitRoot, "cmd"),
  ];
  return dirs.filter((d) => existsSync(d));
}

/** PATH/Path with Git coreutils prepended (Windows). Idempotent. */
export function shellEnv(extras: string[] = gitPathExtras()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (extras.length === 0) return env;
  const key = process.platform === "win32" && env.Path && !env.PATH ? "Path" : "PATH";
  const current = env.PATH ?? env.Path ?? "";
  const parts = current.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const merged = [...extras, ...parts.filter((p) => !extras.some((e) => e.toLowerCase() === p.toLowerCase()))];
  const joined = merged.join(process.platform === "win32" ? ";" : ":");
  env.PATH = joined;
  if (process.platform === "win32") env.Path = joined;
  return env;
}

function probeAvailable(extras: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const env = shellEnv(extras);
  const pathVal = env.PATH ?? env.Path ?? "";

  for (const name of PROBE_TOOLS) {
    if (which(name)) {
      out[name] = true;
      continue;
    }
    // On Windows, also check Git usr/bin directly (Bun.which often misses it)
    if (process.platform === "win32") {
      const exe = `${name}.exe`;
      const hit = extras.some((dir) => existsSync(join(dir, exe)) || existsSync(join(dir, name)));
      out[name] = hit;
      continue;
    }
    // Unix: PATH probe via which was enough; mark false
    out[name] = pathVal.split(":").some((dir) => existsSync(join(dir, name)));
  }
  return out;
}

function shellKindFromPath(shellPath: string, posix: string | null): ShellKind {
  const base = shellPath.replace(/\\/g, "/").toLowerCase();
  if (base.includes("bash")) return "bash";
  if (base.endsWith("/sh") || base.endsWith("/sh.exe")) return "sh";
  if (base.includes("powershell") || base.includes("pwsh")) return "powershell";
  if (base.includes("cmd")) return "cmd";
  if (posix) return "bash";
  return "unknown";
}

function avoidAndPrefer(isWindows: boolean, available: Record<string, boolean>, hasPosix: boolean): {
  avoid: string[];
  prefer: string[];
} {
  if (!isWindows) {
    return {
      avoid: [],
      prefer: [
        "Use read/write/edit/grep/glob tools instead of cat/sed/echo redirects when possible",
        "bash is the execution environment for shell commands",
      ],
    };
  }

  const avoid = [
    "Do not assume full GNU/Linux userspace is on PATH for cmd.exe",
    "Avoid Linux-only paths like /usr/bin/... as the only option",
  ];
  if (!available.shuf && !hasPosix) {
    avoid.push("shuf (use bun/node for random pick, or PowerShell Get-Random)");
  }
  if (!hasPosix) {
    avoid.push("Complex POSIX pipelines when only cmd.exe is available — use PowerShell or dedicated tools");
  }

  const prefer = [
    "Prefer DevCode tools: read, write, edit, grep, glob, todo — not shell cat/sed",
    hasPosix
      ? "Shell commands run via Git Bash when available (POSIX quoting works); cmd builtins (dir, copy, del) auto-route to cmd.exe"
      : "No Git Bash detected — prefer PowerShell (pwsh/powershell) or cmd-safe commands",
    "Paths: forward slashes work in Git Bash; backslashes or drive letters for cmd",
    "Random file pick: use `bun -e` or PowerShell, not bare `shuf` from cmd",
    "List files: prefer glob tool or `ls` under bash; `dir /b` is routed to cmd if needed",
  ];

  return { avoid, prefer };
}

let cached: RuntimeEnv | null = null;

/** Detect host environment once per process (cached). */
export function detectRuntimeEnv(cwd = process.cwd()): RuntimeEnv {
  if (cached && cached.cwd === cwd) return cached;

  const platform = process.platform;
  const isWindows = platform === "win32";
  const gitRoot = findGitRoot();
  const pathExtras = isWindows ? gitPathExtras(gitRoot) : [];
  const posixShell = findPosixShell(gitRoot);
  const available = probeAvailable(pathExtras);

  const comspec = process.env.COMSPEC ?? "cmd.exe";
  const shellPath =
    process.env.SHELL ??
    (isWindows ? (posixShell ?? comspec) : "/bin/sh");

  const { avoid, prefer } = avoidAndPrefer(isWindows, available, !!posixShell);

  cached = {
    platform,
    osLabel: osLabel(platform),
    arch: process.arch,
    cwd,
    home: process.env.HOME ?? process.env.USERPROFILE ?? "",
    isWindows,
    isMac: platform === "darwin",
    isLinux: platform === "linux",
    shellPath,
    shellKind: shellKindFromPath(shellPath, posixShell),
    gitRoot,
    posixShell,
    pathExtras,
    available,
    avoid,
    prefer,
  };
  return cached;
}

/** Reset cache (tests). */
export function resetRuntimeEnvCache(): void {
  cached = null;
}

/** Multi-line block for the system prompt. */
export function formatRuntimePromptBlock(env: RuntimeEnv = detectRuntimeEnv()): string {
  const avail = Object.entries(env.available)
    .filter(([, ok]) => ok)
    .map(([n]) => n)
    .sort();
  const missingCommon = ["shuf", "ls", "rg", "git"]
    .filter((n) => env.available[n] === false)
    .join(", ");

  const lines = [
    `# Host environment (authoritative — do not guess the OS)`,
    `os: ${env.osLabel} (${env.platform}/${env.arch})`,
    `cwd: ${env.cwd}`,
    `shell: ${env.shellPath} (${env.shellKind})`,
    env.posixShell ? `posix_shell: ${env.posixShell}` : `posix_shell: none`,
    env.gitRoot ? `git_for_windows: ${env.gitRoot}` : null,
    avail.length ? `available_tools: ${avail.join(", ")}` : `available_tools: (limited)`,
    missingCommon ? `not_on_path: ${missingCommon}` : null,
    ``,
    `# OS command policy`,
    `- You are running on **${env.osLabel}**. Never use commands that only exist on another OS.`,
    `- Prefer DevCode tools (read, write, edit, grep, glob) over shell for file work.`,
    `- Paths: relative to cwd; use forward slashes (src/foo.ts). Never pass a directory to read/write/edit — use glob to list files.`,
  ];

  for (const p of env.prefer) lines.push(`- ${p}`);
  for (const a of env.avoid) lines.push(`- Avoid: ${a}`);

  if (env.isWindows) {
    lines.push(
      `- Windows error text like "'X' is not recognized as an internal or external command" means X is not available — retry with an available tool (read/glob/grep, bun, powershell), do not repeat the same binary.`,
      `- Do not use macOS-only tools (pbcopy, open as mac launcher) or Linux package managers (apt, yum) on Windows.`,
    );
  } else if (env.isMac) {
    lines.push(`- Do not use Windows cmd.exe builtins (dir /b, copy, del) or PowerShell-only syntax.`);
  } else {
    lines.push(`- Do not use Windows cmd.exe builtins (dir /b, copy, del) or PowerShell-only syntax.`);
  }

  return lines.filter((l) => l !== null).join("\n");
}

/** One-line bash tool description suffix. */
export function bashToolDescriptionSuffix(env: RuntimeEnv = detectRuntimeEnv()): string {
  if (env.isWindows) {
    if (env.posixShell) {
      return (
        `Host: Windows. POSIX commands run via Git Bash; cmd builtins (dir, copy, del, …) auto-route to cmd.exe. ` +
        `Git coreutils are on PATH when present. Prefer read/write/edit/grep/glob over shell file I/O.`
      );
    }
    return (
      `Host: Windows (no Git Bash). Use PowerShell/cmd-safe commands or DevCode tools. ` +
      `Do not use Linux-only binaries.`
    );
  }
  if (env.isMac) return `Host: macOS. Use standard Unix tools; prefer DevCode file tools over cat/sed.`;
  return `Host: Linux. Use standard Unix tools; prefer DevCode file tools over cat/sed.`;
}
