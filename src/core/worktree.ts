/**
 * Isolated git worktree helpers for the `task` subagent.
 * Best-effort: fails soft when not in a git repo or git is unavailable.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { home } from "./paths.js";

export interface WorktreeHandle {
  path: string;
  /** Remove the worktree (and optional branch). */
  dispose(): void;
}

function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
  try {
    const r = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: r.exitCode ?? 1,
      out: r.stdout.toString("utf8").trim(),
      err: r.stderr.toString("utf8").trim(),
    };
  } catch (err) {
    return { code: 1, out: "", err: err instanceof Error ? err.message : String(err) };
  }
}

function worktreesRoot(): string {
  const dir = join(home(), "worktrees");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a detached worktree at a unique path under ~/.devcode/worktrees.
 * Throws on failure (caller should surface as tool is_error).
 */
export function createTaskWorktree(repoCwd: string, label = "task"): WorktreeHandle {
  const inside = git(repoCwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out !== "true") {
    throw new Error("worktree isolation requires a git repository");
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "task";
  const path = join(worktreesRoot(), `${safe}-${id}`);
  mkdirSync(worktreesRoot(), { recursive: true });

  // Detached HEAD at current commit — no branch pollution.
  const add = git(repoCwd, ["worktree", "add", "--detach", path, "HEAD"]);
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.err || add.out || `exit ${add.code}`}`);
  }

  return {
    path,
    dispose() {
      const rm = git(repoCwd, ["worktree", "remove", "--force", path]);
      if (rm.code !== 0) {
        // Fallback: prune + rm -rf
        git(repoCwd, ["worktree", "prune"]);
        try {
          if (existsSync(path)) rmSync(path, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    },
  };
}
