import type { ExtensionAPI } from "devcode";

const DEFAULT_MIN_SEC = 15;

function minSec(): number {
  const v = Number(process.env.DEVCODE_NOTIFY_MIN_SEC);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MIN_SEC;
}

function escapePs(s: string): string {
  return s.replace(/'/g, "''").replace(/[\r\n]+/g, " ").slice(0, 200);
}

function escapeSh(s: string): string {
  return s.replace(/'/g, `'\\''`).slice(0, 200);
}

async function osNotify(title: string, body: string, exec: (cmd: string) => Promise<{ code: number; output: string }>): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await exec(
        `osascript -e 'display notification "${escapeSh(body).replace(/"/g, "\\\"")}" with title "${escapeSh(title).replace(/"/g, "\\\"")}"'`,
      );
    } else if (process.platform === "linux") {
      await exec(`notify-send ${JSON.stringify(title)} ${JSON.stringify(body)}`);
    } else if (process.platform === "win32") {
      // PowerShell balloon / toast best-effort (works without extra modules on most hosts)
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$n = New-Object System.Windows.Forms.NotifyIcon",
        "$n.Icon = [System.Drawing.SystemIcons]::Information",
        "$n.Visible = $true",
        `$n.ShowBalloonTip(4000, '${escapePs(title)}', '${escapePs(body)}', 'Info')`,
        "Start-Sleep -Milliseconds 500",
        "$n.Dispose()",
      ].join("; ");
      await exec(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`);
    }
  } catch {
    /* swallow missing OS tooling */
  }
}

export default function (api: ExtensionAPI) {
  let turnStarted = 0;

  api.on("turn_start", () => {
    turnStarted = Date.now();
  });

  api.on("turn_end", async (ctx) => {
    const elapsed = (Date.now() - turnStarted) / 1000;
    if (elapsed < minSec()) return;
    await osNotify("DevCode", `Turn finished (${Math.round(elapsed)}s) · ${ctx.model}`, ctx.exec);
  });

  api.on("permission_requested", async (ev, ctx) => {
    await osNotify("DevCode permission", `${ev.tool}: ${ev.detail.slice(0, 120)}`, ctx.exec);
  });
}
