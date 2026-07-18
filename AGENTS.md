# AGENTS.md — working on DevCode

Guidance for coding agents contributing to this repository.

## Stack

- **Runtime / package manager:** Bun (dev + test + compile). Node 22+ for running the bundled output.
- **Language:** TypeScript, strict. ESM (`"type": "module"`).
- **TUI:** Ink 7 + React 19. Core never prints; TUI never imports provider internals.
- **Schemas:** `@sinclair/typebox` (JSON Schema + TS types for tools).
- **Extensions:** `jiti` with `moduleCache: false`, default-export factory `(api) => void`.
- **No** Vercel AI SDK, no heavy agent frameworks. Prefer thin fetch+SSE providers.

## Commands

```bash
bun install
bun test                 # must stay green; tests are offline
bun x tsc --noEmit
bun run dev              # interactive TUI
bun run build            # dist/index.js
bun run compile          # dist/devcode(.exe)
```

Point `DEVCODE_HOME` at a temp dir in tests — never write to the developer's real `~/.devcode`.

## Architecture map

```
src/
  index.ts          entry: arg parse → TUI | -p print mode
  core/             provider-agnostic agent loop + events + tools + sessions + memory + permissions + background
  providers/        stream adapters + auth (OAuth/API keys) + models catalog
  extensions/       jiti loader, ExtensionAPI, runtime /reload, built-in reload_extensions tool
  tui/              Ink app over the event boundary
extensions/         bundled extensions (web, commands, checkpoints, notify, auto-commit, mcp, …)
docs/               shipped with the package; absolute paths injected into the system prompt
test/               bun:test, mocked providers, tmp DEVCODE_HOME
```

| Layer | Responsibility |
|-------|----------------|
| `core/loop.ts` | THE loop: stream → tools → feedback → steering → abort. Semantics are frozen — additive only. |
| `core/types.ts` | Canonical `Message` / `ContentBlock` / `StreamEvent` / `ToolDef`. Frozen shape. |
| `core/events.ts` | Typed emitter; TUI subscribes; core never prints. |
| `core/memory.ts` | Persistent curated memory (global + project `memory.md`); written via the `remember` tool, injected into the system prompt at session start. |
| `providers/*` | Translate canonical messages ↔ vendor wire format. Inject `fetchImpl` in tests. |
| `providers/config.ts` | **Only** place for API version strings, endpoints, client IDs. |
| `providers/auth/*` | PKCE, device flow, `auth.json` storage, single-flight refresh. |
| `extensions/*` | Discover → load → bind tools/commands/hooks; `/reload` cycle. |
| `tui/*` | Ink UI + slash commands; talks to core only via events + shared session writer. |

## Invariants

1. **One `tool_result` per `tool_use`.** The loop always emits a result block (including on abort/error).
2. **Tool / provider errors go to the model as `is_error` results** (or a single loop `error` event). Never dump stacks into chat.
3. **`loop.ts` semantics are frozen** — extend via tools, permissions wrappers, or extensions, not by rewriting the control flow.
4. **Canonical types are frozen** — provider-specific shapes stay inside `providers/`.
5. **Every provider accepts injected `fetchImpl`** and has offline SSE fixture tests.
6. **Auth refresh is single-flight** (promise dedup). Failed refresh clears the cred and demands re-login — no retry storms.
7. **Oversized tool output spills** to disk (head 60% + tail 40% + path marker). Caps live in `tools/index.ts`.

## Conventions

- Prefer editing existing files over creating new ones. Do not add docs/READMEs unprompted.
- TypeBox for all tool parameter schemas.
- Config strings (API versions, OAuth client IDs, beta headers) only in `providers/config.ts`.
- Windows: bash tool prefers Git Bash when present so POSIX quoting works for agent-authored commands.
- Keep the surface area minimal — MCP, subagents, sandboxing, keychain storage are explicitly deferred (post-v1 / extensions). See "Recommended features" below for how each should arrive when its time comes.

## When changing behavior

1. Add or update an offline test under `test/`.
2. Run `bun test` and `bun x tsc --noEmit`.
3. If you touch packaging, also smoke `bun run build` and `bun dist/index.js` / `node dist/index.js` with a non-TTY stdin (expect the TUI guard) and `-p` with missing credentials (clean error, not a stack dump).

## Current scope (v0.1 assessment)

A deliberately small frozen core with an already-extensive periphery.

**Minimal by design (the moat — do not grow casually):**

- `core/loop.ts` is ~160 lines; canonical types are three content blocks (`text` / `tool_use` / `tool_result`) — no images, no provider-specific shapes.
- Built-in tools: `read`, `write`, `edit`, `bash`, `background_task`, `grep`, `glob`, `todo`, `remember`, `task` (plus `reload_extensions` from the extension runtime).
- Providers are thin fetch+SSE adapters over ~30 vendors; no SDK, no agent framework.

**Already extensive (do not rebuild):**

- Extensions: tools, slash commands, `tool_call`/`tool_result` middleware, lifecycle events (`permission_requested`), hot `/reload`, project trust gate, agent self-extension, bundled package extensions.
- Permissions (allow/ask/deny + session remembers + persistent settings rules + circuit breakers), context management (spill caps, pruning, auto-compaction), sessions (JSONL, `--continue`/`--resume`, `/resume` picker), persistent memory (global + project).
- Background bash (`run_in_background` + `background_task`), `@path` mentions, structured `-p --output-format`.
- TUI: themes, thinking levels, model/provider/resume pickers, fuzzy slash ranking, markdown/syntax/diffs.
- Auth: OAuth (Anthropic, Codex, Google, Copilot) with single-flight refresh; ~26 API-key providers; env-var detection.

## Feature landscape (vs the top agents)

Assessed 2026-07 against Claude Code, Codex CLI, Gemini CLI, OpenCode, and Aider.

| Capability | Top agents | DevCode |
|---|---|---|
| Subagents / task delegation | Claude Code (`Task` tool), Codex (native), OpenCode | yes — `task` (explore/all, model override, worktree, progress) |
| MCP client | Claude Code, Codex, Gemini, OpenCode | yes — stdio + HTTP/SSE, `/mcp status\|restart` |
| OS-level sandbox | Codex (kernel), Gemini (opt-in), Claude Code (opt-in) | no (deferred) |
| Lifecycle hooks | Claude Code (`settings.json`), Codex (TOML) | yes — extension events + `settings.hooks` shell hooks |
| Skills / markdown custom commands | Claude Code (`SKILL.md`, `.claude/commands/*.md`) | yes — frontmatter + skills index in system prompt |
| Checkpoints / rewind | Claude Code, Gemini, Cline | yes — `/rewind`, `/checkpoints` (create→delete restore) |
| Background tasks | Claude Code, Codex | yes — `bash.run_in_background` + `background_task` |
| Image input | Claude Code, Codex, Gemini | no (frozen canonical types) |
| Web search/fetch tools | Gemini (built-in), Claude Code | yes — `extensions/web.ts` |
| Structured headless output | Codex `exec --json`, Claude Code `--output-format` | yes — `-p --output-format` + exit codes + `--permission-mode` |
| Git auto-commit / repo map | Aider | yes — `/autocommit`; light git snapshot in prompt (no repo map) |
| Project instructions | Claude Code (`CLAUDE.md`), Cursor rules | yes — `AGENTS.md` / `CLAUDE.md` / `.devcode/instructions.md` |
| Plan mode | Claude Code, Codex | yes — bundled `/plan` |
| Parallel read-only tools | Claude Code, Codex | yes — concurrent `read`/`grep`/`glob`/`web_*` |
| Named / exportable sessions | various | yes — `/name`, `/export`, `--name` |
| Persistent memory | Claude Code, Gemini | yes — `remember` + `memory.md` |
| Permission engine | all three | yes — ask/allow/deny + rules + circuit breakers |
| Runtime self-extension | unique to DevCode/pi | yes — jiti + `/reload` |

## Deferred (post-v1)

Still out of the frozen core; revisit only if needed:

- **Image content blocks** — requires changing frozen canonical types.
- **OS-level sandbox** (seatbelt/landlock) — heavy per-platform work; extensions can shell out to existing sandbox runners today.

**Deliberately out of scope (do not propose):** IDE integrations, cloud/remote task runners, voice, browser control, keychain storage, LSP servers, built-in repo-map — extension territory or anti-minimal.
