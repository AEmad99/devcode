# DevCode

Minimal self-extensible TUI coding agent — a Claude Code-style replica built on **TypeScript + Ink (React 19) + Bun**.

DevCode is intentionally small: a thin agentic loop, eight built-in tools, streaming terminal UI, multi-provider auth, and a pi-style extension system so the running agent can extend itself without a rebuild.

## Features

- **Agentic loop** — stream → tool dispatch → `is_error` feedback → steering queue → AbortSignal
- **Tools** — `read`, `write`, `edit`, `bash` (+ background), `background_task`, `grep`, `glob`, `todo`, `remember`, `task` (subagent)
- **Streaming TUI** — Ink UI with markdown, collapsible tool blocks, diffs, permission prompts, `@path` mentions
- **Sessions** — append-only JSONL transcripts, `--continue` / `--resume`, interactive `/resume` picker
- **Context management** — head+tail spill caps, prune old tool outputs, auto-compaction
- **Permissions** — allow / ask / deny, session remember, persistent rules in `settings.json`, circuit breakers
- **Bundled extensions** — `web_search`/`web_fetch`, markdown commands, checkpoints/`/rewind`, format-on-edit, notify, auto-commit, MCP client
- **Self-extension** — jiti-loaded TypeScript extensions (tools, commands, hooks) + `/reload`
- **Multi-provider** — Anthropic, OpenAI, OpenAI Codex, Google Gemini, GitHub Copilot, OpenRouter

## Install (Windows)

One-liner in **PowerShell** (installs Bun if needed, builds a binary, adds it to your user `PATH`):

```powershell
irm https://raw.githubusercontent.com/AEmad99/devcode/main/install.ps1 | iex
```

Then open a **new** terminal and run:

```powershell
devcode
```

Optional env vars before installing:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEVCODE_INSTALL_DIR` | `%LOCALAPPDATA%\devcode` | Install root |
| `DEVCODE_REPO` | `https://github.com/AEmad99/devcode.git` | Clone URL |
| `DEVCODE_REF` | `main` | Branch / tag |

### Other install paths

```bash
# From source (Bun)
git clone https://github.com/AEmad99/devcode.git
cd devcode
bun install
bun run build
bun run dev                 # interactive TUI
bun run src/index.ts -p "create fizzbuzz.ts and run it"   # headless

# Global CLI via Bun (runs prepare → build)
bun install -g github:AEmad99/devcode
```

### Flags

| Flag | Description |
|------|-------------|
| `-p` / `--print <prompt>` | Non-interactive run to completion |
| `--model <id>` | Model override |
| `--provider <id>` | Provider id (`anthropic`, `openai`, `openai-codex`, `google`, `copilot`, `openrouter`) |
| `--continue` | Resume the most recent session for this cwd |
| `--resume <prefix>` | Resume a session by id prefix |
| `--max-turns <n>` | Cap agent turns (default 100) |
| `--output-format text\|json\|stream-json` | Headless output shape (with `-p`) |
| `--permission-mode default\|acceptEdits\|bypassPermissions` | Headless/TUI permission mode |
| `--name <label>` | Name the session (shown in `/resume`) |
| `--append-system <text>` | Extra system-prompt text (scripting) |

Config/auth live under `~/.devcode/` (override with `DEVCODE_HOME`). Project-local extensions: `.devcode/extensions/`.

### Permissions (`~/.devcode/settings.json`)

Claude Code–style allow/deny rules + modes. Live prompts use a vertical dropdown
(Yes / don't ask again / always allow / No / always deny). `/permissions` opens
an interactive manager for modes and rules.

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": ["bash:git *", "write:src/**"],
    "deny": ["bash:rm *", "write:.env*"]
  }
}
```

| Mode | Behavior |
|------|----------|
| `default` | Ask for write/edit/bash (and other mutating tools) |
| `acceptEdits` | Auto-allow write + edit; still ask for bash |
| `bypassPermissions` | Auto-allow all (circuit breakers still apply) |

Rules are `tool` or `tool:glob`. Deny wins over allow.

### Slash commands (built-in)

`/help` `/clear` `/compact` `/cost` `/limits` `/permissions` `/resume` `/name` `/export` `/model` `/provider` `/thinking` `/theme` `/login` `/logout` `/reload` `/exit` — plus skills from `commands/` + `skills/` (YAML frontmatter), and extension commands (`/plan`, `/rewind`, `/checkpoints`, `/mcp`, `/autocommit`, `/skills`, …).

## Provider / auth matrix

Aligned with [pi’s provider list](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md).

### Subscriptions (OAuth)

| Provider | Notes |
|----------|-------|
| **anthropic** | Claude Pro/Max — ⚠️ ToS-gray first-party client |
| **openai-codex** | ChatGPT Plus/Pro Codex — ⚠️ ToS-gray |
| **google** | Login with Google (Code Assist) |
| **copilot** | GitHub device flow |

### API keys (env or `/login`)

| Provider id | Env var |
|-------------|---------|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GEMINI_API_KEY` / `GOOGLE_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `ant-ling` | `ANT_LING_API_KEY` |
| `azure-openai-responses` | `AZURE_OPENAI_API_KEY` (+ `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`) |
| `nvidia` | `NVIDIA_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `cerebras` | `CEREBRAS_API_KEY` |
| `cloudflare-ai-gateway` | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`) |
| `cloudflare-workers-ai` | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`) |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |
| `zai` / `zai-coding-cn` | `ZAI_API_KEY` / `ZAI_CODING_CN_API_KEY` |
| `opencode` / `opencode-go` | `OPENCODE_API_KEY` |
| `huggingface` | `HF_TOKEN` |
| `fireworks` | `FIREWORKS_API_KEY` |
| `together` | `TOGETHER_API_KEY` |
| `kimi-coding` | `KIMI_API_KEY` |
| `minimax` / `minimax-cn` | `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` |
| `moonshotai` / `moonshotai-cn` | `MOONSHOT_API_KEY` |
| `xiaomi` (+ token-plan regions) | `XIAOMI_API_KEY` / `XIAOMI_TOKEN_PLAN_*_API_KEY` |
| `amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK` (+ OpenAI-compat `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`) |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY` (+ `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`) |
| `radius` | `RADIUS_API_KEY` (optional `RADIUS_GATEWAY_URL`) |

> **⚠️ ToS caveat:** Anthropic and OpenAI **subscription OAuth** reuse first-party client IDs and may violate those providers' terms of service. **API keys are the sanctioned path.** Copilot device flow is the more widely tolerated OAuth option. **Google OAuth** needs your own client credentials via env (`DEVCODE_GOOGLE_OAUTH_CLIENT_ID` / `DEVCODE_GOOGLE_OAUTH_CLIENT_SECRET`, or the `GOOGLE_OAUTH_*` aliases) — nothing is shipped in-repo for secret-scanning safety.

Run `/provider` in the TUI for the live list and auth status.

### How to log in

```text
/login                 # pick provider → OAuth and/or API key
/login anthropic       # jump straight to that provider
/provider              # list providers + auth state
/provider openai       # switch active provider
/logout anthropic      # clear stored credentials
```

Credentials are stored in `~/.devcode/auth.json` (mode `0600`). Env vars are auto-detected and take precedence over stored keys.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Enter | Send |
| Ctrl+J | Newline |
| Esc | Interrupt current turn / tool |
| Ctrl+C ×2 | Quit |
| Tab | Slash-command completion |
| ↑ / ↓ | Input history / menu navigation |

## Slash commands

`/login` · `/logout` · `/model` · `/provider` · `/compact` · `/clear` · `/reload` · `/cost` · `/help`

Extensions can register additional commands.

## Extensions (quickstart)

1. Write a TypeScript factory to `~/.devcode/extensions/hello.ts` (see `docs/examples/hello-tool.ts`).
2. In the TUI, run `/reload`.
3. Authoring guide: `docs/extensions.md` (also linked from the system prompt so the agent can self-extend).

## Development

```bash
bun test                  # unit + integration tests (offline)
bun x tsc --noEmit        # typecheck
bun run build             # bundle → dist/index.js
bun run compile           # single binary → dist/devcode(.exe)
```

Stack: Bun as dev runtime/bundler, Node 22+ compatible at runtime, Ink 7 + React 19, TypeBox for tool schemas, jiti for extension loading. No Vercel AI SDK — each provider is a thin fetch+SSE adapter so OAuth headers and cache breakpoints stay explicit.

## What's verified

- Offline unit tests cover the loop, tools, permissions, sessions, providers (mocked SSE), OAuth plumbing, auth refresh, and extension load/reload.
- Live OAuth dances and live multi-provider smokes are **not** exercised in CI without credentials — treat first login per provider as a manual check.

## License

MIT
