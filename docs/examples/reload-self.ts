import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "devcode";

// The self-reload pattern: a slash command that reloads, plus a tool the
// agent can call after editing extension source files. The followUp message
// "/reload-self" is routed through slash handling when the run ends.
// Note: `reload_extensions` is built into DevCode — installing this
// extension shadows the built-in with this custom variant.
export default function (api: ExtensionAPI) {
  api.registerCommand("reload-self", {
    description: "Reload all extensions",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });

  api.registerTool({
    name: "reload_extensions",
    description: "Reload DevCode extensions after editing their source files",
    schema: Type.Object({}),
    async execute(_id, _params, _signal, ctx) {
      ctx?.sendUserMessage("/reload-self", { deliverAs: "followUp" });
      return { content: "Reload scheduled (runs after this turn)" };
    },
  });
}
