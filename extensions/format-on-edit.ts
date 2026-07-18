import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "devcode";

function prettierBin(cwd: string): string | null {
  const candidates =
    process.platform === "win32"
      ? [join(cwd, "node_modules", ".bin", "prettier.cmd"), join(cwd, "node_modules", ".bin", "prettier")]
      : [join(cwd, "node_modules", ".bin", "prettier")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function quote(p: string): string {
  if (/[\s"]/.test(p)) return `"${p.replace(/"/g, '\\"')}"`;
  return p;
}

export default function (api: ExtensionAPI) {
  api.on("tool_result", async (ev, ctx) => {
    if (ev.toolName !== "write" && ev.toolName !== "edit") return;
    if (ev.result.is_error) return;
    const path = typeof ev.input?.path === "string" ? (ev.input.path as string) : null;
    if (!path) return;
    const bin = prettierBin(ctx.cwd);
    if (!bin) return;
    try {
      // Best-effort; failures are silent (don't break the agent loop).
      await ctx.exec(`${quote(bin)} --write ${quote(path)}`);
    } catch {
      /* swallow */
    }
  });
}
