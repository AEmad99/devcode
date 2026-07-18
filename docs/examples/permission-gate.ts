import type { ExtensionAPI } from "devcode";

// Ask the user before any `rm -rf`-looking bash command runs.
export default function (api: ExtensionAPI) {
  api.on("tool_call", async (ev, ctx) => {
    if (ev.toolName !== "bash") return;
    const command = String(ev.input?.command ?? "");
    if (!/\brm\s+-[a-z]*r[a-z]*f/i.test(command)) return;
    const ok = await ctx.ui.confirm("Allow destructive rm?", command);
    if (!ok) return { block: true, reason: "User declined destructive rm via permission-gate" };
  });
}
