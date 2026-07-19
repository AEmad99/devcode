# DevCode extensions

Extensions are plain TypeScript (or JavaScript) files that add tools, slash
commands, and event handlers to DevCode — no build step, no packaging. They
are loaded with jiti directly from `.ts` source and hot-reloaded with `/reload`.

## Where extensions live

| Location | Scope | Trust |
|---|---|---|
| package `extensions/` (bundled) | shipped with DevCode | always trusted |
| `~/.devcode/extensions/` | global, all projects | always trusted |
| `<project>/.devcode/extensions/` | per-project | must be trusted once per project (persisted in `settings.json`) |

Load order is **bundled → global → project**. Later registrations win for the
same tool name (project can shadow a bundled tool). Each location accepts flat
`*.ts` / `*.js` files, or one level of subdirectories containing an
`index.ts` / `index.js`.

### Bundled extensions

| File | What it adds |
|---|---|
| `web.ts` | `web_fetch`, `web_search` tools |
| `commands.ts` | Markdown skills/commands (`commands/` + `skills/`, YAML frontmatter); `/skills` |
| `checkpoints.ts` | Snapshots before `write`/`edit`; `/rewind`, `/checkpoints` |
| `format-on-edit.ts` | Runs project Prettier after successful edits |
| `notify.ts` | OS toast on long turns + permission waits |
| `auto-commit.ts` | Opt-in `/autocommit on` → git commit at turn end |
| `mcp.ts` | MCP client (stdio + HTTP/SSE) from `mcp.json`; `/mcp status\|restart` |
| `plan-mode.ts` | `/plan` — block write/edit/bash until a plan is approved |

### Lifecycle events

In addition to `tool_call` / `tool_result` / `turn_*` / `session_*`:

- **`permission_requested`** — fired when the TUI is about to show a permission
  prompt (`{ tool, detail }`). Useful for notifications while waiting.

## The factory

Each extension default-exports a factory that receives the extension API:

```ts
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "devcode";

export default function (api: ExtensionAPI) {
  api.registerTool({
    name: "greet",
    description: "Greet someone by name",
    schema: Type.Object({ name: Type.String() }),
    async execute(_id, params) {
      return { content: `Hello, ${params.name}!` };
    },
  });
}
```

The factory may be `async`. Errors thrown while loading or running a factory
are collected and shown in the chat — including to the agent, so you can ask
it to fix its own broken extension.

## API reference

### `registerTool(def)`

- `name`, `description`, `schema` (a TypeBox `TObject` — JSON schema).
- `execute(id, params, signal, ctx?)` — returns `{ content: string, is_error? }`.
- Throws become `is_error` results automatically.
- Extension tools shadow built-in tools with the same name.
- Extension tools are not on the permission allow-list by default: the user
  is asked before they run (like `bash`/`write`).

#### Capability hints — opt in to read-only / parallel-safe

Pass these optional fields on the tool def to declare that the tool has no
side effects / can run concurrently:

- `readOnly: true` — skip permission prompts (auto-allowed) AND make the tool
  available in explore-mode subagents.
- `parallelSafe: true` — implied `readOnly: true`; also lets the loop batch
  the tool with other `parallelSafe` calls in the same turn. Only declare
  this when concurrent execution is genuinely safe — the default is `false`.

```ts
api.registerTool({
  name: "ripgrep",
  description: "Search files via rg",
  schema: Type.Object({ pattern: Type.String() }),
  readOnly: true,
  parallelSafe: true,
  async execute(_id, params, signal) { /* … */ },
});
```

### `registerCommand(name, { description, handler })`

Adds a `/<name>` slash command. `handler(args, ctx)` gets the rest of the
line as `args`. `ctx.reload()` reloads all extensions.

### `on(event, handler)`

- `"tool_call"` — runs before every tool execution (built-in and extension).
  Return `{ block: true, reason }` to stop the call; the model sees
  `Blocked: <reason>` as an `is_error` tool result. A throwing handler blocks
  too (fail-safe).
  **Timing**: synchronous and blocks the tool call by design — a slow
  `tool_call` handler stalls the agent loop. Keep them fast (shell out async
  if needed, but don't `await` heavy work in `tool_call`).
- `"tool_result"` — runs after every execution. Return a `ToolResult` to
  replace the result (handlers chain). Throws are logged, result passes through.
- `"turn_start"` / `"turn_end"` — around each agent run.
- `"session_start"` — after extensions load. `"session_shutdown"` — on `/reload`
  before state is torn down.
- `"permission_requested"` — fires in both TUI and `-p` modes whenever a
  permission prompt would appear. Fire-and-forget; you cannot resolve the
  prompt from here (the host's `ask` function owns the resolution).

### Context (`ctx`) available in handlers, commands, and as the optional 4th tool argument

- `ctx.cwd`, `ctx.model`, `ctx.generation`
- `ctx.ui.confirm(title, detail?)` — modal Yes/No prompt
- `ctx.ui.notify(text, level?)` — info/error entry in the chat
- `ctx.exec(command)` — run a shell command, returns `{ code, output }`
- `ctx.sendUserMessage(text, { deliverAs })`:
  - `"steer"` — injected between tools/turns of the current run
  - `"followUp"` — delivered after the current run finishes (default)
- Texts starting with `/` are routed through slash handling — this is how an
  extension reloads itself (see below).

After `/reload`, contexts from the old generation throw
`Extension context is stale after reload` when used.

## Self-extension and reloading

`reload_extensions` is a built-in tool: after writing or editing extension
source, the agent calls it and a `/reload` is scheduled as a follow-up
message — routed through slash handling when the run ends (never mid-run).

The agent's flow for self-extension: write/edit a file in
`~/.devcode/extensions/` or `.devcode/extensions/`, call the
`reload_extensions` tool, then use the new tool/command.

An extension that registers its own `reload_extensions` tool shadows the
built-in. The pattern (used by `docs/examples/reload-self.ts`) is a slash
command that reloads, plus a tool that schedules it via a follow-up message:

```ts
api.registerCommand("reload-self", {
  description: "Reload all extensions",
  handler: async (_args, ctx) => ctx.reload(),
});

api.registerTool({
  name: "reload_extensions",
  description: "Reload extensions after editing their source",
  schema: Type.Object({}),
  async execute(_id, _p, _s, ctx) {
    ctx?.sendUserMessage("/reload-self", { deliverAs: "followUp" });
    return { content: "Reload scheduled for after this turn" };
  },
});
```

## Debugging

- Load errors (syntax, missing imports, factory throws) appear in the chat as
  `[extension] <path>: <message>` entries at startup and after `/reload`.
- Runtime handler errors appear the same way. Point the agent at the
  transcript and it can fix the file and reload.

## Notes

- Tool schemas are TypeBox `TObject`s, same as the built-in tools.
- Permissions run **outside** middleware: a call the user already denied never
  reaches `tool_call` handlers.
- `/reload` is refused while the agent is mid-run.
- Examples: `docs/examples/hello-tool.ts`, `permission-gate.ts`,
  `reload-self.ts`, `plan-mode.ts`.
