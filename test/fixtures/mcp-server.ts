/**
 * Minimal MCP stdio fixture: initialize → tools/list → tools/call.
 * Run with: bun test/fixtures/mcp-server.ts
 */
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Echo a message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
    },
  },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function respond(id: number | string | null, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id: number | string | null, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "0.0.1" },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    respond(id, { tools });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (name === "echo") {
      respond(id, {
        content: [{ type: "text", text: `echo:${params?.arguments?.message ?? ""}` }],
      });
      return;
    }
    respondError(id, `Unknown tool: ${name}`);
    return;
  }
  if (id != null) respondError(id, `Unknown method: ${method}`);
});
