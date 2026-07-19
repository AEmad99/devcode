import { Type } from "@sinclair/typebox";
import { clearReadOnlyNames, registerReadOnlyNames } from "../core/permissions.js";
import { loadSettings, saveSettings } from "../core/settings.js";
import type { ToolDef, ToolResult } from "../core/types.js";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolDef,
  PermissionRequestEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "./api.js";
import { discoverExtensionFiles, loadExtensions } from "./loader.js";

export interface RuntimeDeps {
  cwd: string;
  getModel: () => string;
  confirm: (title: string, detail?: string) => Promise<boolean>;
  confirmTrust?: (cwd: string) => Promise<boolean>; // defaults to `confirm`
  notify: (text: string, level?: "info" | "error") => void;
  exec: (command: string) => Promise<{ code: number; output: string }>;
  steer: (text: string) => void;
  followUp: (text: string) => void;
  isRunning: () => boolean;
}

export interface LoadError {
  path: string;
  error: string;
  stack?: string;
}

type AnyHandler = (ev: any, ctx: ExtensionContext) => any;

interface ExtCommand {
  path: string;
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const errStack = (err: unknown): string | undefined => (err instanceof Error ? err.stack : undefined);

export class ExtensionRuntime {
  private generation = 0;
  private extTools: { path: string; def: ExtensionToolDef }[] = [];
  private extCommands = new Map<string, ExtCommand>();
  private toolCallHandlers: { path: string; fn: AnyHandler }[] = [];
  private toolResultHandlers: { path: string; fn: AnyHandler }[] = [];
  private lifecycle = new Map<string, { path: string; fn: (...args: any[]) => any }[]>();
  private loadErrors: LoadError[] = [];
  private errorCbs: ((info: LoadError) => void)[] = [];
  private loadedPaths: string[] = [];

  constructor(private deps: RuntimeDeps) {}

  onError(cb: (info: LoadError) => void): void {
    this.errorCbs.push(cb);
  }

  private reportError(info: LoadError): void {
    this.loadErrors.push(info);
    for (const cb of this.errorCbs) {
      try {
        cb(info);
      } catch {
        // listener errors must not break extension loading
      }
    }
  }

  get errors(): LoadError[] {
    return this.loadErrors;
  }

  get extensionPaths(): string[] {
    return this.loadedPaths;
  }

  private checkStale(generation: number): void {
    if (generation !== this.generation) throw new Error("Extension context is stale after reload");
  }

  private makeContext(path: string, generation: number): ExtensionContext {
    const self = this;
    return {
      cwd: this.deps.cwd,
      get model() {
        self.checkStale(generation);
        return self.deps.getModel();
      },
      generation,
      ui: {
        confirm: (title, detail) => {
          self.checkStale(generation);
          return self.deps.confirm(title, detail);
        },
        notify: (text, level) => {
          self.checkStale(generation);
          self.deps.notify(text, level);
        },
      },
      exec: async (command) => {
        self.checkStale(generation);
        return self.deps.exec(command);
      },
      sendUserMessage: (text, opts) => {
        self.checkStale(generation);
        if (opts?.deliverAs === "steer") self.deps.steer(text);
        else self.deps.followUp(text);
      },
    };
  }

  commandContext(name: string): ExtensionCommandContext {
    const self = this;
    const base = this.makeContext(`command:${name}`, this.generation);
    return {
      ...base,
      reload: async () => {
        self.checkStale(base.generation);
        await self.reload();
      },
    };
  }

  private makeApi(path: string, generation: number): ExtensionAPI {
    const self = this;
    return {
      registerTool: (def) => this.extTools.push({ path, def }),
      registerCommand: (name, opts) => this.extCommands.set(name, { path, ...opts }),
      on: (event: string, handler: AnyHandler) => {
        if (event === "tool_call") self.toolCallHandlers.push({ path, fn: handler });
        else if (event === "tool_result") self.toolResultHandlers.push({ path, fn: handler });
        else {
          const list = self.lifecycle.get(event) ?? [];
          list.push({ path, fn: handler as unknown as (ctx: ExtensionContext) => any });
          self.lifecycle.set(event, list);
        }
      },
    } as ExtensionAPI;
  }

  private async emitLifecycle(event: string, generation: number, ev?: unknown): Promise<void> {
    for (const h of this.lifecycle.get(event) ?? []) {
      const ctx = this.makeContext(h.path, generation);
      try {
        // Payload-carrying events (permission_requested) get (ev, ctx); the
        // rest keep the bare-ctx handler shape.
        if (ev === undefined) await h.fn(ctx);
        else await h.fn(ev, ctx);
      } catch (err) {
        this.reportError({ path: h.path, error: `${event} handler failed: ${errMsg(err)}`, stack: errStack(err) });
      }
    }
  }

  async emitTurnStart(): Promise<void> {
    await this.emitLifecycle("turn_start", this.generation);
  }

  async emitTurnEnd(): Promise<void> {
    await this.emitLifecycle("turn_end", this.generation);
  }

  async emitPermissionRequested(ev: PermissionRequestEvent): Promise<void> {
    await this.emitLifecycle("permission_requested", this.generation, ev);
  }

  async load(): Promise<{ loaded: number; errors: number }> {
    this.generation++;
    const gen = this.generation;
    this.extTools = [];
    this.extCommands.clear();
    this.toolCallHandlers = [];
    this.toolResultHandlers = [];
    this.lifecycle.clear();
    this.loadedPaths = [];

    // Trust gate: project extensions need an explicit yes (persisted).
    let files = discoverExtensionFiles(this.deps.cwd);
    if (files.some((f) => f.source === "project")) {
      const settings = loadSettings();
      let trusted = settings.trustedProjects?.includes(this.deps.cwd) ?? false;
      if (!trusted) {
        const ask = this.deps.confirmTrust ?? ((cwd: string) => this.deps.confirm("Trust project extensions?", cwd));
        trusted = await ask(this.deps.cwd);
        if (trusted) saveSettings({ trustedProjects: [...(settings.trustedProjects ?? []), this.deps.cwd] });
      }
      if (!trusted) files = files.filter((f) => f.source !== "project");
    }

    const { loaded, errors } = await loadExtensions(files);
    for (const e of errors) this.reportError({ path: e.path, error: e.error });
    for (const { path, factory } of loaded) {
      try {
        await factory(this.makeApi(path, gen));
        this.loadedPaths.push(path);
      } catch (err) {
        this.reportError({ path, error: errMsg(err), stack: errStack(err) });
      }
    }
    await this.emitLifecycle("session_start", gen);
    return { loaded: this.loadedPaths.length, errors: this.loadErrors.length };
  }

  async reload(): Promise<{ ok: boolean; message: string }> {
    if (this.deps.isRunning()) return { ok: false, message: "Cannot reload extensions while a run is in progress" };
    for (const h of this.lifecycle.get("session_shutdown") ?? []) {
      try {
        await h.fn(this.makeContext(h.path, this.generation));
      } catch (err) {
        this.reportError({ path: h.path, error: `session_shutdown handler failed: ${errMsg(err)}`, stack: errStack(err) });
      }
    }
    this.loadErrors = [];
    const { loaded, errors } = await this.load();
    return { ok: true, message: `Reloaded ${loaded} extension${loaded === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"})` };
  }

  // Built-in self-extension tool: schedules a /reload as a followUp, which the
  // TUI drains after the run ends and routes through slash handling (by then
  // isRunning() is false, so the reload is accepted).
  private reloadTool(): ToolDef {
    return {
      name: "reload_extensions",
      description: "Reload DevCode extensions after creating or editing extension source files",
      schema: Type.Object({}),
      execute: async (): Promise<ToolResult> => {
        this.deps.followUp("/reload");
        return { content: "Reload scheduled — new or changed extensions activate right after this turn." };
      },
    };
  }

  // Extension tools as core ToolDefs. Errors become is_error results.
  tools(): ToolDef[] {
    const gen = this.generation;
    // Dedupe by name, last registration wins: with load order bundled →
    // global → project, a user extension shadows a bundled tool of the same name.
    const byName = new Map<string, { path: string; def: ExtensionToolDef }>();
    for (const t of this.extTools) byName.set(t.def.name, t);
    const ext: ToolDef[] = [...byName.values()].map(({ path, def }) => ({
      name: def.name,
      description: def.description,
      schema: def.schema,
      // Pass capability hints through so the permission engine can auto-allow
      // a read-only extension tool and the loop can batch a parallelSafe one.
      // parallelSafe implies readOnly (a mutating parallel tool would be unsafe).
      readOnly: def.parallelSafe ? true : def.readOnly,
      parallelSafe: def.parallelSafe,
      execute: async (id, input, signal): Promise<ToolResult> => {
        try {
          return await def.execute(id, input, signal, this.makeContext(path, gen));
        } catch (err) {
          return { content: errMsg(err), is_error: true };
        }
      },
    }));
    // The built-in reload tool yields to an extension with the same name.
    if (this.extTools.some(({ def }) => def.name === "reload_extensions")) return ext;
    return [this.reloadTool(), ...ext];
  }

  commands(): { name: string; description: string }[] {
    return [...this.extCommands.entries()].map(([name, c]) => ({ name, description: c.description }));
  }

  command(name: string): ExtCommand | undefined {
    return this.extCommands.get(name);
  }

  // Extension tools shadow built-ins with the same name.
  mergedTools(defaults: ToolDef[]): ToolDef[] {
    const ext = this.tools();
    const extNames = new Set(ext.map((t) => t.name));
    return [...ext, ...defaults.filter((t) => !extNames.has(t.name))];
  }

  /**
   * Seed the permission engine's read-only registry with every tool (built-in
   * or extension) that declared `readOnly: true` on its def. Must be called
   * after `mergedTools` whenever the tool set changes (initial load, /reload,
   * provider/model switch). Idempotent: clears + repopulates so stale names
   * from a reloaded extension don't linger.
   */
  syncReadOnlyNames(tools: ToolDef[]): void {
    clearReadOnlyNames();
    for (const t of tools) {
      if (t.readOnly) registerReadOnlyNames([t.name]);
    }
  }

  // Wrap every tool with tool_call / tool_result middleware.
  // tool_call: any {block, reason} or a thrown handler blocks execution (fail-safe).
  // tool_result: a returned ToolResult replaces the result (chained); throws are
  // reported but the result passes through unchanged.
  wrapWithMiddleware(tools: ToolDef[]): ToolDef[] {
    const self = this;
    const gen = this.generation;
    return tools.map((tool) => ({
      ...tool,
      execute: async (id, input, signal): Promise<ToolResult> => {
        for (const h of self.toolCallHandlers) {
          try {
            const res = await h.fn({ toolName: tool.name, input } satisfies ToolCallEvent, self.makeContext(h.path, gen));
            if (res && typeof res === "object" && res.block === true) {
              return { content: `Blocked: ${String(res.reason)}`, is_error: true };
            }
          } catch (err) {
            return { content: `Blocked: ${errMsg(err)}`, is_error: true };
          }
        }
        let result: ToolResult;
        try {
          result = await tool.execute(id, input, signal);
        } catch (err) {
          result = { content: errMsg(err), is_error: true };
        }
        for (const h of self.toolResultHandlers) {
          try {
            const res = await h.fn({ toolName: tool.name, input, result } satisfies ToolResultEvent, self.makeContext(h.path, gen));
            if (res && typeof res === "object" && typeof res.content === "string") result = res;
          } catch (err) {
            self.reportError({ path: h.path, error: `tool_result handler failed: ${errMsg(err)}`, stack: errStack(err) });
          }
        }
        return result;
      },
    }));
  }
}
