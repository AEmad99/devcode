import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "devcode";

function settingsPath(): string {
  const home = process.env.DEVCODE_HOME ?? join(homedir(), ".devcode");
  return join(home, "settings.json");
}

function loadFlag(): boolean {
  try {
    const s = JSON.parse(readFileSync(settingsPath(), "utf8"));
    return s?.autoCommit === true;
  } catch {
    return false;
  }
}

function saveFlag(on: boolean): void {
  let cur: Record<string, unknown> = {};
  try {
    cur = JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    cur = {};
  }
  cur.autoCommit = on;
  writeFileSync(settingsPath(), JSON.stringify(cur, null, 2), { mode: 0o600 });
}

export default function (api: ExtensionAPI) {
  api.registerCommand("autocommit", {
    description: "Toggle auto-commit after agent turns (/autocommit on|off)",
    handler: async (args, ctx) => {
      const a = args.trim().toLowerCase();
      if (a === "on" || a === "1" || a === "true") {
        saveFlag(true);
        ctx.ui.notify("Auto-commit enabled (never pushes)", "info");
      } else if (a === "off" || a === "0" || a === "false") {
        saveFlag(false);
        ctx.ui.notify("Auto-commit disabled", "info");
      } else {
        ctx.ui.notify(`Auto-commit is ${loadFlag() ? "ON" : "OFF"}. Usage: /autocommit on|off`, "info");
      }
    },
  });

  api.on("turn_end", async (ctx) => {
    if (!loadFlag()) return;
    try {
      const inside = await ctx.exec("git rev-parse --is-inside-work-tree");
      if (inside.code !== 0 || !inside.output.includes("true")) return;
      const st = await ctx.exec("git status --porcelain");
      if (st.code !== 0 || !st.output.trim()) return;
      await ctx.exec("git add -A");
      const summary = st.output
        .trim()
        .split("\n")
        .slice(0, 5)
        .map((l) => l.trim())
        .join("; ")
        .slice(0, 120);
      const msg = `devcode: ${summary || "agent changes"}`;
      // Use a simple message; avoid user.email requirements when possible
      const commit = await ctx.exec(`git commit -m ${JSON.stringify(msg)}`);
      if (commit.code === 0) {
        ctx.ui.notify(`Auto-committed: ${msg}`, "info");
      }
    } catch {
      /* swallow */
    }
  });
}
