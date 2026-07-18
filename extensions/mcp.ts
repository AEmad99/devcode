/**
 * Bundled MCP client: stdio + SSE/HTTP streamable transports.
 * Config: ~/.devcode/mcp.json and/or <cwd>/.devcode/mcp.json
 *
 * Shape (Claude Code compatible + remote):
 * {
 *   "mcpServers": {
 *     "local": { "command": "npx", "args": ["-y", "…"], "env": {} },
 *     "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer …" } },
 *     "sse": { "url": "https://example.com/sse", "transport": "sse" }
 *   }
 * }
 *
 * Commands: /mcp [status|restart [name]|list]
 */
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolDef } from "devcode";

interface ServerCfg {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Remote MCP endpoint (SSE or streamable HTTP). */
  url?: string;
  headers?: Record<string, string>;
  /** "stdio" | "sse" | "http" — default stdio if command, http if url. */
  transport?: "stdio" | "sse" | "http";
}

interface McpConfig {
  mcpServers?: Record<string, ServerCfg>;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function home(): string {
  return process.env.DEVCODE_HOME ?? join(homedir(), ".devcode");
}

function readConfig(path: string): McpConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as McpConfig;
  } catch {
    return {};
  }
}

function mergeConfigs(globalCfg: McpConfig, projectCfg: McpConfig): Record<string, ServerCfg> {
  return { ...(globalCfg.mcpServers ?? {}), ...(projectCfg.mcpServers ?? {}) };
}

function toolName(server: string, tool: string): string {
  const s = server.replace(/[^a-zA-Z0-9_]/g, "_");
  const t = tool.replace(/[^a-zA-Z0-9_]/g, "_");
  return `mcp_${s}_${t}`;
}

function formatMcpContent(result: any): string {
  const parts = result?.content ?? [];
  if (Array.isArray(parts)) {
    return (
      parts
        .map((p: any) => {
          if (p?.type === "text") return String(p.text ?? "");
          return JSON.stringify(p);
        })
        .join("\n") || "(empty MCP result)"
    );
  }
  return JSON.stringify(result);
}

/** Shared JSON-RPC client surface for stdio and HTTP. */
abstract class McpTransport {
  abstract readonly kind: string;
  abstract start(): Promise<void>;
  abstract request(method: string, params: unknown, timeoutMs?: number): Promise<any>;
  abstract kill(): void;
  abstract get running(): boolean;

  async ensureRunning(): Promise<void> {
    if (this.running) return;
    await this.start();
  }
}

class StdioMcp extends McpTransport {
  readonly kind = "stdio";
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private crashed = false;

  constructor(
    readonly name: string,
    private cfg: ServerCfg,
  ) {
    super();
  }

  get running(): boolean {
    return !!this.proc && !this.crashed;
  }

  async start(): Promise<void> {
    if (!this.cfg.command) throw new Error(`MCP ${this.name}: stdio requires command`);
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      shell: false,
    });
    this.crashed = false;
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.stderr.on("data", () => {});
    this.proc.on("exit", () => {
      this.crashed = true;
      this.proc = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP server ${this.name} exited`));
      }
      this.pending.clear();
    });

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "devcode", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  private notify(method: string, params: unknown): void {
    if (!this.proc?.stdin.writable) return;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (!this.proc?.stdin.writable) return Promise.reject(new Error(`MCP server ${this.name} not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  kill(): void {
    try {
      this.proc?.kill();
    } catch {
      /* */
    }
    this.proc = null;
  }
}

/**
 * Streamable HTTP / simple POST JSON-RPC client.
 * Many remote MCP servers accept POST {jsonrpc} and return JSON result.
 * SSE: GET url for event stream is optional; we use POST for requests.
 */
class HttpMcp extends McpTransport {
  readonly kind: string;
  private nextId = 1;
  private sessionId: string | undefined;
  private _running = false;

  constructor(
    readonly name: string,
    private cfg: ServerCfg,
    kind: "http" | "sse" = "http",
  ) {
    super();
    this.kind = kind;
  }

  get running(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    if (!this.cfg.url) throw new Error(`MCP ${this.name}: remote requires url`);
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "devcode", version: "0.1.0" },
    });
    // notifications/initialized — fire-and-forget
    try {
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
    } catch {
      /* optional */
    }
    this._running = true;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.cfg.headers ?? {}),
    };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  private async post(body: unknown, expectResult: boolean): Promise<any> {
    const res = await fetch(this.cfg.url!, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 300)}`);
    if (!expectResult) return undefined;
    // SSE response: data: {...}
    if (text.includes("data:")) {
      const dataLines = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      for (const line of dataLines) {
        if (!line || line === "[DONE]") continue;
        try {
          const msg = JSON.parse(line);
          if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
          if (msg.result !== undefined) return msg.result;
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("MCP")) throw e;
        }
      }
    }
    try {
      const msg = JSON.parse(text);
      if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
      return msg.result;
    } catch (e) {
      if (e instanceof Error && !e.message.includes("JSON")) throw e;
      throw new Error(`MCP ${this.name}: unparseable response: ${text.slice(0, 200)}`);
    }
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    const body = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      this.post(body, true)
        .then((r) => {
          clearTimeout(timer);
          resolve(r);
        })
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  kill(): void {
    this._running = false;
    this.sessionId = undefined;
  }
}

interface LiveServer {
  name: string;
  transport: McpTransport;
  toolCount: number;
  status: "ready" | "error";
  error?: string;
}

function makeTransport(name: string, cfg: ServerCfg): McpTransport {
  if (cfg.url) {
    const kind = cfg.transport === "sse" ? "sse" : "http";
    return new HttpMcp(name, cfg, kind);
  }
  return new StdioMcp(name, cfg);
}

export default async function (api: ExtensionAPI) {
  const servers: LiveServer[] = [];
  let started = false;
  let lastCfg: Record<string, ServerCfg> = {};
  let toolNames: string[] = [];

  const registerTools = async (client: McpTransport, name: string): Promise<number> => {
    const listed = await client.request("tools/list", {});
    const tools = (listed?.tools ?? []) as Array<{ name: string; description?: string; inputSchema?: any }>;
    for (const tool of tools) {
      const regName = toolName(name, tool.name);
      toolNames.push(regName);
      const def: ExtensionToolDef = {
        name: regName,
        description: tool.description ?? `MCP tool ${name}/${tool.name}`,
        schema: Type.Unsafe(tool.inputSchema ?? { type: "object", properties: {} }) as any,
        async execute(_id, params, signal) {
          try {
            await client.ensureRunning();
            if (signal.aborted) return { content: "Aborted", is_error: true };
            const result = await client.request("tools/call", { name: tool.name, arguments: params ?? {} });
            return { content: formatMcpContent(result), is_error: result?.isError === true };
          } catch {
            try {
              await client.start();
              const result = await client.request("tools/call", { name: tool.name, arguments: params ?? {} });
              return { content: formatMcpContent(result), is_error: result?.isError === true };
            } catch (err2) {
              return {
                content: err2 instanceof Error ? err2.message : String(err2),
                is_error: true,
              };
            }
          }
        },
      };
      api.registerTool(def);
    }
    return tools.length;
  };

  const boot = async (ctx: {
    cwd: string;
    ui: {
      confirm: (t: string, d?: string) => Promise<boolean>;
      notify: (t: string, l?: "info" | "error") => void;
    };
  }) => {
    if (started) return;
    started = true;

    const globalPath = join(home(), "mcp.json");
    const projectPath = join(ctx.cwd, ".devcode", "mcp.json");
    const globalCfg = readConfig(globalPath);
    let projectCfg: McpConfig = {};
    if (existsSync(projectPath)) {
      let trusted = false;
      try {
        const settings = JSON.parse(readFileSync(join(home(), "settings.json"), "utf8"));
        trusted = Array.isArray(settings.trustedProjects) && settings.trustedProjects.includes(ctx.cwd);
      } catch {
        trusted = false;
      }
      if (!trusted) {
        const ok = await ctx.ui.confirm(
          "Trust project MCP servers?",
          `Load ${projectPath}?\n(This can run arbitrary local commands or call remote URLs.)`,
        );
        if (ok) {
          try {
            const sp = join(home(), "settings.json");
            let s: Record<string, unknown> = {};
            try {
              s = JSON.parse(readFileSync(sp, "utf8"));
            } catch {
              s = {};
            }
            const list: string[] = Array.isArray(s.trustedProjects) ? (s.trustedProjects as string[]) : [];
            if (!list.includes(ctx.cwd)) list.push(ctx.cwd);
            s.trustedProjects = list;
            writeFileSync(sp, JSON.stringify(s, null, 2), { mode: 0o600 });
          } catch {
            /* */
          }
          projectCfg = readConfig(projectPath);
        }
      } else {
        projectCfg = readConfig(projectPath);
      }
    }

    lastCfg = mergeConfigs(globalCfg, projectCfg);
    for (const [name, cfg] of Object.entries(lastCfg)) {
      if (!cfg?.command && !cfg?.url) continue;
      const transport = makeTransport(name, cfg);
      try {
        await transport.start();
        const n = await registerTools(transport, name);
        servers.push({ name, transport, toolCount: n, status: "ready" });
        ctx.ui.notify(`MCP: ${name} ready (${transport.kind}, ${n} tool${n === 1 ? "" : "s"})`, "info");
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        servers.push({ name, transport, toolCount: 0, status: "error", error });
        ctx.ui.notify(`MCP: failed to start ${name}: ${error}`, "error");
      }
    }
  };

  const statusText = (): string => {
    if (servers.length === 0) return "No MCP servers configured (see ~/.devcode/mcp.json)";
    return servers
      .map((s) => {
        const run = s.transport.running ? "up" : "down";
        const base = `${s.name}: ${s.status}/${run} (${s.transport.kind}, ${s.toolCount} tools)`;
        return s.error ? `${base} — ${s.error}` : base;
      })
      .join("\n");
  };

  api.registerCommand("mcp", {
    description: "MCP servers: /mcp [status|list|restart [name]]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "status").toLowerCase();
      if (sub === "status" || sub === "list") {
        ctx.ui.notify(statusText(), "info");
        return;
      }
      if (sub === "restart") {
        const only = parts[1];
        const targets = only ? servers.filter((s) => s.name === only) : servers;
        if (targets.length === 0) {
          ctx.ui.notify(only ? `No MCP server named "${only}"` : "No MCP servers to restart", "error");
          return;
        }
        for (const s of targets) {
          try {
            s.transport.kill();
            await s.transport.start();
            s.status = "ready";
            s.error = undefined;
            ctx.ui.notify(`MCP: restarted ${s.name}`, "info");
          } catch (err) {
            s.status = "error";
            s.error = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`MCP: restart failed for ${s.name}: ${s.error}`, "error");
          }
        }
        ctx.ui.notify("Note: tool registrations refresh on /reload", "info");
        return;
      }
      ctx.ui.notify("Usage: /mcp status | /mcp list | /mcp restart [name]", "info");
    },
  });

  api.on("session_start", async (ctx) => {
    await boot(ctx);
  });

  api.on("session_shutdown", () => {
    for (const s of servers) s.transport.kill();
    servers.length = 0;
    toolNames = [];
    started = false;
  });
}
