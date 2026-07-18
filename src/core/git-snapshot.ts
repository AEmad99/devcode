/**
 * Lightweight git context for the system prompt — not a repo map.
 * One spawn per field; all soft-fail outside a git repo.
 */

export interface GitSnapshot {
  branch?: string;
  /** Short porcelain status lines (capped). */
  status?: string;
  /** Most recent commit subject. */
  head?: string;
}

const STATUS_MAX_LINES = 40;
const STATUS_MAX_CHARS = 2000;

function git(cwd: string, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (r.exitCode !== 0) return null;
    return r.stdout.toString("utf8").trim();
  } catch {
    return null;
  }
}

/** Probe git for branch, dirty status, and HEAD subject. Returns {} outside a repo. */
export function captureGitSnapshot(cwd: string): GitSnapshot {
  const inside = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return {};

  const out: GitSnapshot = {};
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch) out.branch = branch;

  const head = git(cwd, ["log", "-1", "--pretty=%s"]);
  if (head) out.head = head.slice(0, 120);

  const statusRaw = git(cwd, ["status", "--porcelain"]);
  if (statusRaw) {
    const lines = statusRaw.split("\n").filter(Boolean);
    const clipped = lines.slice(0, STATUS_MAX_LINES);
    let status = clipped.join("\n");
    if (lines.length > STATUS_MAX_LINES) {
      status += `\n… +${lines.length - STATUS_MAX_LINES} more`;
    }
    if (status.length > STATUS_MAX_CHARS) {
      status = `${status.slice(0, STATUS_MAX_CHARS)}\n… (status truncated)`;
    }
    out.status = status;
  } else if (statusRaw === "") {
    out.status = "(clean)";
  }

  return out;
}

/** Format for system prompt injection. Empty string when not a git repo. */
export function formatGitSnapshot(snap: GitSnapshot): string {
  if (!snap.branch && !snap.status && !snap.head) return "";
  const lines = ["# Git (session start)"];
  if (snap.branch) lines.push(`branch: ${snap.branch}`);
  if (snap.head) lines.push(`HEAD: ${snap.head}`);
  if (snap.status) {
    lines.push("status:");
    lines.push(snap.status);
  }
  return lines.join("\n");
}
