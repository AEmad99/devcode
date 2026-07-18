/**
 * File checkpoints before write/edit; /rewind and /checkpoints to restore/list.
 * Restores overwrites to prior content; new files created after snapshot are deleted.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "devcode";

interface Snapshot {
  n: number;
  path: string;
  snap: string;
  /** true if the file existed before the mutating tool ran */
  existed: boolean;
  at: string;
}

interface Manifest {
  snaps: Snapshot[];
}

function home(): string {
  return process.env.DEVCODE_HOME ?? join(homedir(), ".devcode");
}

function checkpointsRoot(): string {
  const dir = join(home(), "checkpoints");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(p: string): string {
  return Buffer.from(p.replace(/\\/g, "/")).toString("base64url").slice(0, 80);
}

let manifest: Manifest = { snaps: [] };
let seq = 0;

function loadManifest(): void {
  const f = join(checkpointsRoot(), "current.json");
  try {
    const raw = JSON.parse(readFileSync(f, "utf8")) as Manifest;
    if (Array.isArray(raw.snaps)) {
      manifest = raw;
      seq = Math.max(0, ...raw.snaps.map((s) => s.n), 0);
    }
  } catch {
    manifest = { snaps: [] };
    seq = 0;
  }
}

function saveManifest(): void {
  writeFileSync(join(checkpointsRoot(), "current.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function pathFromInput(input: any): string | null {
  if (typeof input?.path === "string") return input.path as string;
  return null;
}

function formatList(snaps: Snapshot[], limit = 20): string {
  if (snaps.length === 0) return "(none)";
  return snaps
    .slice(-limit)
    .map((s) => `  ${s.n}. ${s.path} (${s.existed ? "overwrite" : "create"}) @ ${s.at}`)
    .join("\n");
}

function restoreSnapshot(target: Snapshot): { ok: true } | { ok: false; error: string } {
  try {
    if (target.existed) {
      if (!existsSync(target.snap)) {
        return { ok: false, error: `Snapshot file missing: ${target.snap}` };
      }
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, readFileSync(target.snap, "utf8"), "utf8");
      return { ok: true };
    }
    // File was created by the tool — restore means delete it.
    if (existsSync(target.path)) {
      try {
        unlinkSync(target.path);
      } catch (err) {
        return { ok: false, error: `Could not delete created file: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export default function (api: ExtensionAPI) {
  loadManifest();

  api.on("tool_call", async (ev) => {
    if (ev.toolName !== "write" && ev.toolName !== "edit") return;
    const path = pathFromInput(ev.input);
    if (!path) return;
    seq += 1;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(checkpointsRoot(), stamp);
    mkdirSync(dir, { recursive: true });
    const snap = join(dir, `${seq}-${safeName(path)}.bak`);
    let existed = false;
    let content = "";
    try {
      content = readFileSync(path, "utf8");
      existed = true;
    } catch {
      existed = false;
    }
    if (existed) {
      try {
        writeFileSync(snap, content, "utf8");
      } catch {
        return;
      }
    } else {
      try {
        writeFileSync(snap, "", "utf8");
        writeFileSync(`${snap}.new`, "1", "utf8");
      } catch {
        return;
      }
    }
    manifest.snaps.push({
      n: seq,
      path,
      snap,
      existed,
      at: new Date().toISOString(),
    });
    if (manifest.snaps.length > 200) manifest.snaps = manifest.snaps.slice(-200);
    saveManifest();
  });

  api.registerCommand("checkpoints", {
    description: "List file checkpoints (/checkpoints [n] to show one)",
    handler: (args, ctx) => {
      loadManifest();
      if (manifest.snaps.length === 0) {
        ctx.ui.notify("No checkpoints yet — write/edit first", "info");
        return;
      }
      const n = args.trim() ? Number.parseInt(args.trim(), 10) : NaN;
      if (!Number.isNaN(n)) {
        const s = manifest.snaps.find((x) => x.n === n);
        if (!s) {
          ctx.ui.notify(`No checkpoint #${n}`, "error");
          return;
        }
        ctx.ui.notify(
          `#${s.n} ${s.path}\n  kind: ${s.existed ? "overwrite (restore previous content)" : "create (restore deletes file)"}\n  at: ${s.at}\n  snap: ${s.snap}`,
          "info",
        );
        return;
      }
      ctx.ui.notify(`Checkpoints (${manifest.snaps.length}):\n${formatList(manifest.snaps)}`, "info");
    },
  });

  api.registerCommand("rewind", {
    description: "Restore a checkpoint (/rewind [n] — default latest)",
    handler: async (args, ctx) => {
      loadManifest();
      if (manifest.snaps.length === 0) {
        ctx.ui.notify("No checkpoints yet — write/edit first", "info");
        return;
      }
      ctx.ui.notify(`Recent checkpoints:\n${formatList(manifest.snaps, 15)}`, "info");

      let target: Snapshot | undefined;
      const n = args.trim() ? Number.parseInt(args.trim(), 10) : NaN;
      if (!Number.isNaN(n)) {
        target = manifest.snaps.find((s) => s.n === n);
        if (!target) {
          ctx.ui.notify(`No checkpoint #${n}`, "error");
          return;
        }
      } else {
        target = manifest.snaps[manifest.snaps.length - 1];
      }

      const detail = target.existed
        ? `Restore previous content of ${target.path}`
        : `Delete ${target.path} (it was created after this checkpoint)`;
      const ok = await ctx.ui.confirm(`Restore checkpoint #${target.n}?`, detail);
      if (!ok) {
        ctx.ui.notify("Rewind cancelled", "info");
        return;
      }
      const result = restoreSnapshot(target);
      if (!result.ok) {
        ctx.ui.notify(`Restore failed: ${result.error}`, "error");
        return;
      }
      ctx.ui.notify(
        target.existed
          ? `Restored #${target.n} → ${target.path}`
          : `Rewound #${target.n}: deleted created file ${target.path}`,
        "info",
      );
    },
  });
}
