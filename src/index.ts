#!/usr/bin/env bun
import React from "react";
import { Emitter } from "./core/events.js";
import { exitCodeForLoopResult } from "./core/exit-codes.js";
import { captureGitSnapshot, formatGitSnapshot } from "./core/git-snapshot.js";
import { runHooks } from "./core/hooks.js";
import { runAgentLoop } from "./core/loop.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt } from "./core/prompt.js";
import { loadProjectInstructions } from "./core/project-instructions.js";
import { detectRuntimeEnv } from "./core/runtime-env.js";
import { loadMemory } from "./core/memory.js";
import {
  createSession,
  listSessions,
  loadSession,
  openSessionWriter,
  resolveSession,
  type SessionWriter,
} from "./core/session.js";
import { loadSettings, rememberChoice } from "./core/settings.js";
import { formatSkillsIndex, loadAllSkills } from "./core/skills.js";
import { expandMentions } from "./core/mentions.js";
import { defaultTools } from "./core/tools/index.js";
import { taskTool } from "./core/tools/task.js";
import { formatEventLine, formatFinalResult } from "./core/output-format.js";
import {
  PermissionEngine,
  wrapToolsWithPermissions,
  type AskFn,
  type PermissionMode,
} from "./core/permissions.js";
import type { AgentEvent, Message, StreamEvent, Usage } from "./core/types.js";
import { docsDir, globalExtensionsDir, projectExtensionsDir } from "./extensions/loader.js";
import { makeProvider, preferredProviderId, refreshStoredOAuth } from "./providers/registry.js";
import type { Provider } from "./providers/types.js";

const ESC = String.fromCharCode(27);
const dim = (s: string): string => `${ESC}[2m${s}${ESC}[0m`;
const red = (s: string): string => `${ESC}[31m${s}${ESC}[0m`;

type OutputFormat = "text" | "json" | "stream-json";

interface CliArgs {
  prompt?: string;
  model?: string;
  maxTurns?: number;
  continue?: boolean;
  resume?: string;
  provider?: string;
  outputFormat?: OutputFormat;
  permissionMode?: PermissionMode;
  name?: string;
  systemAppend?: string;
}

function parsePermissionMode(v: string): PermissionMode {
  if (v === "default" || v === "acceptEdits" || v === "bypassPermissions") return v;
  throw new Error(`Unknown --permission-mode "${v}" (expected default|acceptEdits|bypassPermissions)`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--print") args.prompt = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--max-turns") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.maxTurns = Math.floor(n);
    } else if (a === "--continue") args.continue = true;
    else if (a === "--resume") args.resume = argv[++i];
    else if (a === "--provider") args.provider = argv[++i];
    else if (a === "--output-format") {
      const v = argv[++i];
      if (v !== "text" && v !== "json" && v !== "stream-json") {
        throw new Error(`Unknown --output-format "${v}" (expected text|json|stream-json)`);
      }
      args.outputFormat = v;
    } else if (a === "--permission-mode") {
      args.permissionMode = parsePermissionMode(argv[++i] ?? "");
    } else if (a === "--name") {
      args.name = argv[++i];
    } else if (a === "--append-system") {
      args.systemAppend = argv[++i];
    } else if (!a.startsWith("-")) positional.push(a);
  }
  if (args.prompt === undefined && positional.length > 0) args.prompt = positional.join(" ");
  return args;
}

function buildAppSystemPrompt(cwd: string, append?: string): string {
  const runtime = detectRuntimeEnv(cwd);
  const gitSnap = captureGitSnapshot(cwd);
  const instructions = loadProjectInstructions(cwd);
  const skills = loadAllSkills(cwd);
  let system = buildSystemPrompt({
    cwd,
    platform: process.platform,
    shell: currentShell(),
    date: new Date().toISOString().slice(0, 10),
    isGitRepo: detectGitRepo() || !!gitSnap.branch,
    docsDir: shippedDocsDir(),
    memory: loadMemory(cwd),
    extGlobalDir: globalExtensionsDir(),
    extProjectDir: projectExtensionsDir(cwd),
    runtime,
    projectInstructions: instructions.text || undefined,
    gitSnapshot: formatGitSnapshot(gitSnap) || undefined,
    skillsIndex: formatSkillsIndex(skills) || undefined,
  });
  if (append?.trim()) system = `${system}\n\n# Additional instructions\n${append.trim()}`;
  return system;
}

function detectGitRepo(): boolean {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 && r.stdout.toString().trim() === "true";
  } catch {
    return false;
  }
}

function currentShell(): string {
  const rt = detectRuntimeEnv();
  return rt.posixShell ?? rt.shellPath;
}

// The shipped docs/ dir (extension authoring guide), when present.
function shippedDocsDir(): string | undefined {
  const dir = docsDir();
  return existsSync(join(dir, "extensions.md")) ? dir : undefined;
}

// Scripted offline provider for TUI smoke tests (DEVCODE_FAKE_PROVIDER=1).
function createFakeProvider(): Provider {
  let calls = 0;
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  return {
    id: "fake",
    defaultModel: "fake-model",
    stream() {
      calls++;
      const events: StreamEvent[] = [];
      if (calls === 1) {
        const text = "Let me look at **package.json**.";
        events.push(
          { type: "text_delta", text },
          { type: "tool_use_start", id: "t1", name: "read" },
          { type: "tool_use_delta", id: "t1", partialJson: '{"path":"package.json"}' },
          {
            type: "done",
            stopReason: "tool_use",
            usage,
            message: {
              role: "assistant",
              content: [
                { type: "text", text },
                { type: "tool_use", id: "t1", name: "read", input: { path: "package.json" } },
              ],
            },
          },
        );
      } else {
        const text = `Fake reply ${calls}.`;
        events.push({ type: "text_delta", text }, {
          type: "done",
          stopReason: "end_turn",
          usage,
          message: { role: "assistant", content: [{ type: "text", text }] },
        });
      }
      return (async function* () {
        for (const ev of events) yield ev;
      })();
    },
  };
}

async function launchTui(args: CliArgs): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('TUI requires an interactive terminal. Use -p "prompt" for print mode.');
    process.exitCode = 1;
    return;
  }

  const settings = loadSettings();
  let provider: Provider | null = null;
  let providerId = "anthropic";
  let providerError: string | undefined;
  let model = args.model ?? settings.model ?? "claude-sonnet-4-5";
  if (process.env.DEVCODE_FAKE_PROVIDER) {
    provider = createFakeProvider();
    providerId = "fake";
    model = args.model ?? "fake-model";
  } else {
    // Always prefer last-used provider/model from ~/.devcode/settings.json
    // unless the user passed --provider / --model on the CLI.
    providerId = preferredProviderId(args.provider, settings.provider);
    const wantedModel = args.model ?? settings.model;
    await refreshStoredOAuth(providerId);
    try {
      provider = makeProvider(providerId, { model: wantedModel });
      model = wantedModel ?? provider.defaultModel;
      // Persist the effective pair so the next launch restores exactly this.
      rememberChoice(providerId, model);
    } catch (err) {
      providerError = err instanceof Error ? err.message : String(err);
      // Keep the remembered preference even if auth is missing — /login can fix it.
      if (settings.provider) providerId = settings.provider;
      if (settings.model) model = settings.model;
    }
  }

  const cwd = process.cwd();
  let sessionWriter: SessionWriter;
  let initialMessages: Message[] = [];
  let resumeNote: string | undefined;
  if (args.resume || args.continue) {
    const target = args.resume
      ? await resolveSession(cwd, args.resume)
      : { info: (await listSessions(cwd))[0], error: `No sessions found for ${cwd}` };
    if (!target.info) {
      console.error(target.error);
      process.exitCode = 1;
      return;
    }
    try {
      const { meta, messages } = await loadSession(target.info.path);
      initialMessages = messages;
      sessionWriter = openSessionWriter(target.info.path, meta.id);
      resumeNote = `Resumed session ${meta.id} (${messages.length} messages)`;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  } else {
    sessionWriter = createSession(cwd, model, undefined, args.name);
  }

  const system = buildAppSystemPrompt(cwd, args.systemAppend);
  if (args.name && sessionWriter.setName) {
    sessionWriter.setName(args.name);
  }
  // Print session id for scripting / later --resume
  if (sessionWriter.id) {
    console.error(dim(`session ${sessionWriter.id}${args.name ? ` (${args.name})` : ""}`));
  }
  const { render } = await import("ink");
  const { App } = await import("./tui/app.js");
  render(
    React.createElement(App, {
      provider,
      providerId,
      model,
      system,
      sessionWriter,
      initialMessages,
      resumeNote,
      providerError,
      permissionMode: args.permissionMode,
      onChoiceChange: (p: string, m: string) => rememberChoice(p, m),
    }),
    { exitOnCtrlC: false },
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prompt) {
    await launchTui(args);
    return;
  }

  const cwd = process.cwd();
  const system = buildAppSystemPrompt(cwd, args.systemAppend);

  const settings = loadSettings();
  const providerId = preferredProviderId(args.provider, settings.provider);
  const modelId = args.model ?? settings.model;
  await refreshStoredOAuth(providerId);
  let provider: Provider;
  try {
    provider = makeProvider(providerId, { model: modelId });
    rememberChoice(providerId, modelId ?? provider.defaultModel);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`Tip: set a key env var, or run the TUI and /login. Provider tried: ${providerId}`);
    process.exitCode = 1;
    return;
  }

  const outputFormat = args.outputFormat ?? "text";
  const events = new Emitter();
  let lastUsage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastError: string | undefined;
  if (outputFormat === "stream-json") {
    const printEvent = (e: AgentEvent): void => console.log(formatEventLine(e));
    events.on("text_delta", printEvent);
    events.on("thinking_delta", printEvent);
    events.on("tool_use_start", printEvent);
    events.on("tool_delta", printEvent);
    events.on("tool_start", printEvent);
    events.on("tool_end", printEvent);
    events.on("turn_end", printEvent);
    events.on("error", printEvent);
  } else if (outputFormat === "json") {
    events.on("turn_end", (e) => {
      lastUsage = e.usage;
    });
  } else {
    events.on("text_delta", (e) => process.stdout.write(e.text));
    events.on("tool_use_start", (e) => console.error(dim(`\n[tool→] ${e.name}…`)));
    events.on("tool_start", (e) => console.log(`\n[tool] ${e.name}(${JSON.stringify(e.input).slice(0, 120)})`));
    events.on("tool_end", (e) => {
      const line = `→ ${e.result.content.slice(0, 200).replace(/\n/g, " ")}`;
      console.log(e.result.is_error ? dim(line) : line);
    });
    events.on("turn_end", (e) =>
      console.error(
        `\n[turn_end] stop=${e.stopReason} input=${e.usage.input} output=${e.usage.output} cacheRead=${e.usage.cacheRead} cacheWrite=${e.usage.cacheWrite}`,
      ),
    );
    events.on("error", (e) => {
      lastError = e.error;
      console.error(red(`error: ${e.error}`));
    });
  }
  events.on("error", (e) => {
    lastError = e.error;
  });

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  const permRules = {
    ...settings.permissions,
    ...(args.permissionMode ? { defaultMode: args.permissionMode } : {}),
  };
  const permissionEngine = new PermissionEngine(permRules, { headless: true });
  if (args.permissionMode) permissionEngine.setMode(args.permissionMode);
  const ask: AskFn = async () => "deny";
  const promptText = await expandMentions(args.prompt, cwd);
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: promptText }] }];
  const baseTools = defaultTools("print", cwd);
  const wrapPerm = (tools: ReturnType<typeof defaultTools>) =>
    wrapToolsWithPermissions(tools, permissionEngine, ask);
  const tools = wrapPerm([
    ...baseTools,
    taskTool({
      provider,
      system,
      cwd,
      subTools: (subCwd) => wrapPerm(defaultTools("print-sub", subCwd ?? cwd)),
      resolveProvider: (model) => makeProvider(providerId, { model }),
      onEvent: (ev) => events.emit(ev),
    }),
  ]);

  await runHooks(settings.hooks, { event: "turn_start", cwd });
  const { stopReason } = await runAgentLoop({
    provider,
    system,
    messages,
    tools,
    events,
    signal: controller.signal,
    maxTurns: args.maxTurns,
  });
  await runHooks(settings.hooks, { event: "turn_end", cwd });
  if (outputFormat === "json") {
    console.log(formatFinalResult({ stopReason, usage: lastUsage, messages }));
  }
  process.exitCode = exitCodeForLoopResult(stopReason, lastError);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
