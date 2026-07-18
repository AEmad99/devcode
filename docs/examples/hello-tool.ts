import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "devcode";

export default function (api: ExtensionAPI) {
  api.registerTool({
    name: "greet",
    description: "Greet someone by name",
    schema: Type.Object({
      name: Type.String({ description: "Who to greet" }),
    }),
    async execute(_id, params) {
      return { content: `Hello, ${params.name}!` };
    },
  });
}
