import type { ExtensionAPI } from "devcode";

// Plan mode is also shipped as bundled `extensions/plan-mode.ts` (/plan).
// This example is the same pattern for project-local copies.
export default function (api: ExtensionAPI) {
  let planMode = false;

  api.registerCommand("plan", {
    description: "Toggle plan mode — block write/edit/bash until /plan off",
    handler: (args, ctx) => {
      const a = args.trim().toLowerCase();
      if (a === "off" || a === "false" || a === "0") planMode = false;
      else if (a === "on" || a === "true" || a === "1") planMode = true;
      else planMode = !planMode;
      ctx.ui.notify(
        planMode
          ? "Plan mode ON — write/edit/bash are blocked. Present a plan, then /plan off to execute."
          : "Plan mode OFF — execution resumed",
      );
    },
  });

  api.on("tool_call", (ev) => {
    if (!planMode) return;
    if (["write", "edit", "bash"].includes(ev.toolName)) {
      return {
        block: true,
        reason:
          "Plan mode is ON: the user wants a plan before changes. Present the plan in chat, then ask them to run /plan off when ready to execute.",
      };
    }
  });
}
