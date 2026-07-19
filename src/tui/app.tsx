import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { compactMessages, estimateTokens, pruneToolOutputs, shouldCompact } from "../core/context.js";
import { Emitter } from "../core/events.js";
import { formatLimitsReport } from "../core/limits.js";
import { runAgentLoop } from "../core/loop.js";
import {
  PermissionEngine,
  wrapToolsWithPermissions,
  type PermissionChoice,
  type PermissionMode,
} from "../core/permissions.js";
import { estimateCost } from "../core/pricing.js";
import { loadSettings, saveSettings } from "../core/settings.js";
import {
  detectThinking,
  parseThinkingLevel,
  thinkingLabel as formatThinkingLabel,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../core/thinking.js";
import { listBackground, onBackgroundDone } from "../core/background.js";
import { expandMentions, listFileCandidates } from "../core/mentions.js";
import { runHooks } from "../core/hooks.js";
import {
  exportSessionMarkdown,
  listSessions,
  loadSession,
  openSessionWriter,
  renameSession,
  type SessionInfo,
  type SessionWriter,
} from "../core/session.js";
import { defaultTools } from "../core/tools/index.js";
import { taskTool } from "../core/tools/task.js";
import type { Message, Usage } from "../core/types.js";
import { clearCred } from "../providers/auth/storage.js";
import { modelsFor, type ModelInfo } from "../providers/models.js";
import { listProviders, makeProvider as registryMakeProvider } from "../providers/registry.js";
import type { Provider } from "../providers/types.js";
import { bashTool } from "../core/tools/bash.js";
import { ExtensionRuntime } from "../extensions/runtime.js";
import { ConfirmPrompt } from "./components/ConfirmPrompt.js";
import { Header } from "./components/Header.js";
import { InputBox } from "./components/InputBox.js";
import { LoginFlow, type LoginResult } from "./components/LoginFlow.js";
import { MessageList, userEntryIds } from "./components/MessageList.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { ProviderPicker } from "./components/ProviderPicker.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { PermissionsPanel } from "./components/PermissionsPanel.js";
import { ResumePicker } from "./components/ResumePicker.js";
import { ScrollToEnd } from "./components/ScrollToEnd.js";
import { StatusLine } from "./components/StatusLine.js";
import { StreamingText } from "./components/StreamingText.js";
import { ThinkingStream } from "./components/ThinkingStream.js";
import { layoutFromTerminal } from "./layout.js";
import { SLASH_COMMANDS, parseSlash } from "./slash.js";
import { initialState, reducer } from "./store.js";
import { resolveTheme, THEME_IDS, THEMES, type ThemeId } from "./theme.js";

export function App({
  provider,
  providerId: initialProviderId,
  model,
  system,
  sessionWriter: initialSessionWriter,
  initialMessages,
  resumeNote,
  providerError,
  permissionMode: initialPermissionMode,
  onModelChange,
  onProviderChange,
  onChoiceChange,
}: {
  provider: Provider | null;
  providerId: string;
  model: string;
  system: string;
  sessionWriter?: SessionWriter;
  initialMessages?: Message[];
  resumeNote?: string;
  providerError?: string;
  permissionMode?: PermissionMode;
  onModelChange?: (model: string) => void;
  onProviderChange?: (providerId: string) => void;
  /** Preferred: persist provider+model as one pair */
  onChoiceChange?: (providerId: string, model: string) => void;
}) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const [sessionWriter, setSessionWriter] = useState<SessionWriter | undefined>(initialSessionWriter);
  const historyRef = useRef<Message[]>(initialMessages ?? []);
  const writtenRef = useRef(historyRef.current.length); // history entries already in the session file
  const queueRef = useRef<Message[]>([]);
  const followUpRef = useRef<string[]>([]); // extension followUp messages, drained after runs
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false); // authoritative "a run is in flight" flag (reducer state lags a render)
  const resolverRef = useRef<((choice: PermissionChoice) => void) | null>(null);
  const confirmResolverRef = useRef<((yes: boolean) => void) | null>(null);
  const lastCtrlCRef = useRef(0);
  const lastUsageRef = useRef<Usage | null>(null);
  const fileCandidatesRef = useRef<string[]>([]);
  // O(history) token estimate cached across stream ticks: history mutates only by
  // push (length changes) or wholesale replacement (identity changes).
  const ctxCacheRef = useRef<{ arr: Message[]; len: number; value: number } | null>(null);
  const providerRef = useRef<Provider | null>(provider);
  const [providerId, setProviderId] = useState(initialProviderId);
  const providerIdRef = useRef(providerId);
  providerIdRef.current = providerId;
  const [modelName, setModelName] = useState(model);
  const modelRef = useRef(modelName);
  modelRef.current = modelName;
  const [login, setLogin] = useState<{ providerId?: string } | null>(null);
  const settings0 = loadSettings();
  const [themeId, setThemeId] = useState<ThemeId>(() => resolveTheme(settings0.theme).id);
  const theme = useMemo(() => resolveTheme(themeId), [themeId]);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(() => settings0.thinking ?? "medium");
  const thinkingRef = useRef(thinkingLevel);
  thinkingRef.current = thinkingLevel;
  const thinkCap = useMemo(() => detectThinking(modelName, providerId), [modelName, providerId]);
  const thinkLabel = formatThinkingLabel(thinkingLevel, thinkCap);
  // Banner only at cold start — hide permanently after first user message.
  const [showBanner, setShowBanner] = useState(true);
  // Model / provider / resume picker overlays (type-to-search)
  const [modelPicker, setModelPicker] = useState<{ models: ModelInfo[]; loading: boolean } | null>(null);
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [resumePicker, setResumePicker] = useState<{ sessions: SessionInfo[]; loading: boolean } | null>(null);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [fileCandidates, setFileCandidates] = useState<string[]>([]);
  // Bumped after /reload so the input's slash-command menu picks up extension changes.
  const [reloadTick, setReloadTick] = useState(0);
  // Jump between previous user queries: index into user-entry list (-1 = live tail)
  const [jumpIdx, setJumpIdx] = useState(-1);
  const jumpFocusId = useMemo(() => {
    if (jumpIdx < 0) return null;
    const ids = userEntryIds(state.entries);
    return ids[jumpIdx] ?? null;
  }, [jumpIdx, state.entries]);

  useEffect(() => {
    if (resumeNote) dispatch({ type: "info", text: resumeNote });
    if (providerError) dispatch({ type: "info", text: `${providerError} — run /login to connect a provider` });
    // Resumed sessions: skip banner (chat already has history)
    if (initialMessages && initialMessages.length > 0) setShowBanner(false);
  }, [resumeNote, providerError, initialMessages]);

  const engine = useMemo(() => {
    const eng = new PermissionEngine(settings0.permissions);
    if (initialPermissionMode) eng.setMode(initialPermissionMode);
    return eng;
  }, [initialPermissionMode]);
  const hooksConfig = settings0.hooks;
  const persistPermissions = useCallback(
    (snap: { allow: string[]; deny: string[]; defaultMode: PermissionMode }) => {
      saveSettings({
        permissions: {
          allow: snap.allow,
          deny: snap.deny,
          defaultMode: snap.defaultMode,
        },
      });
    },
    [],
  );

  const uiConfirm = useCallback((title: string, detail?: string) => {
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
      dispatch({ type: "confirm_request", title, detail });
    });
  }, []);

  const runtime = useMemo(
    () =>
      new ExtensionRuntime({
        cwd: process.cwd(),
        getModel: () => modelRef.current,
        confirm: uiConfirm,
        notify: (text, level) => {
          if (level === "error") dispatch({ type: "error", error: text });
          else dispatch({ type: "info", text });
        },
        exec: async (command) => {
          const r = await bashTool.execute("ext-exec", { command }, new AbortController().signal);
          return { code: r.is_error ? 1 : 0, output: r.content };
        },
        steer: (text) => {
          queueRef.current.push({ role: "user", content: [{ type: "text", text }] });
          dispatch({ type: "queue_update", count: queueRef.current.length });
        },
        followUp: (text) => followUpRef.current.push(text),
        isRunning: () => busyRef.current,
      }),
    [uiConfirm],
  );

  // Declared after `runtime` so it can emit to extensions; both memos are
  // referentially stable (runtime's only dep, uiConfirm, never changes).
  const askPermission = useCallback(
    (req: { tool: string; detail: string; input?: unknown }) =>
      new Promise<PermissionChoice>((resolve) => {
        resolverRef.current = resolve;
        dispatch({ type: "permission_request", request: { tool: req.tool, detail: req.detail, input: req.input } });
      }),
    [],
  );

  // Stable array identity so InputBox's memo survives stream ticks; refreshed on /reload.
  const slashCommands = useMemo(() => [...SLASH_COMMANDS, ...runtime.commands()], [runtime, reloadTick]);

  // Load extensions once on mount; errors surface into the chat (agent-visible).
  useEffect(() => {
    runtime.onError((info) => dispatch({ type: "error", error: `[extension] ${info.path}: ${info.error}` }));
    void runtime.load().then(({ loaded }) => {
      if (loaded > 0) dispatch({ type: "info", text: `${loaded} extension${loaded === 1 ? "" : "s"} loaded` });
    });
  }, [runtime]);

  // @path completion candidates; refresh periodically.
  useEffect(() => {
    const refresh = () => {
      void listFileCandidates(process.cwd()).then((list) => {
        fileCandidatesRef.current = list;
        setFileCandidates(list);
      });
    };
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, []);

  // Background bash completions between runs.
  useEffect(() => {
    const sync = () => {
      const n = listBackground().filter((t) => !t.done).length;
      dispatch({ type: "bg_update", running: n });
    };
    sync();
    return onBackgroundDone((t) => {
      sync();
      dispatch({
        type: "info",
        text: `Background ${t.id} finished (exit ${t.exitCode}) · ${t.command.slice(0, 80)}`,
      });
    });
  }, []);

  // Tools per run: extension tools shadow built-ins, middleware wraps everything,
  // and permissions wrap LAST (a call the user denies never reaches tool_call hooks).
  const buildTools = useCallback(
    (events?: Emitter) => {
      const cwd = process.cwd();
      const defaults = defaultTools(sessionWriter?.id ?? "tui", cwd);
      const merged = runtime.mergedTools(defaults);
      // Seed the permission engine with read-only names from the live tool set
      // (built-ins + any extension tool that declared readOnly/parallelSafe).
      // Runs on every build (initial load, /reload, provider switch) — idempotent.
      runtime.syncReadOnlyNames(merged);
      const wrapPerm = (tools: ReturnType<typeof defaultTools>) => {
        const withHooks = tools.map((tool) => ({
          ...tool,
          execute: async (id: string, input: any, signal: AbortSignal) => {
            const block = await runHooks(hooksConfig, {
              event: "tool_call",
              cwd,
              toolName: tool.name,
              detail: (() => {
                try {
                  return JSON.stringify(input);
                } catch {
                  return String(input);
                }
              })(),
            });
            if (block) return { content: block.reason, is_error: true as const };
            const result = await tool.execute(id, input, signal);
            await runHooks(hooksConfig, {
              event: "tool_result",
              cwd,
              toolName: tool.name,
              detail: result.content.slice(0, 2000),
            });
            return result;
          },
        }));
        return wrapToolsWithPermissions(runtime.wrapWithMiddleware(withHooks), engine, askPermission, {
          onPersist: persistPermissions,
          onPrompt: (req) => {
            // Fire-and-forget: extensions observe permission prompts (e.g. notify-on-wait).
            void runtime.emitPermissionRequested({ tool: req.tool, detail: req.detail });
          },
        });
      };
      if (!providerRef.current) return wrapPerm(merged);
      const task = taskTool({
        provider: providerRef.current,
        system,
        cwd,
        subTools: (subCwd) => {
          const subDefaults = defaultTools(sessionWriter?.id ?? "tui", subCwd ?? cwd);
          const subMerged = runtime.mergedTools(subDefaults).filter((t) => t.name !== "task");
          return wrapPerm(subMerged);
        },
        thinking: thinkingRef.current,
        resolveProvider: (modelId) => registryMakeProvider(providerIdRef.current, { model: modelId }),
        onEvent: events ? (ev) => events.emit(ev) : undefined,
      });
      return wrapPerm([...merged, task]);
    },
    [runtime, engine, askPermission, sessionWriter, system, persistPermissions, hooksConfig],
  );

  const flushSessionWrites = useCallback(() => {
    if (!sessionWriter) return;
    while (writtenRef.current < historyRef.current.length) {
      sessionWriter.append(historyRef.current[writtenRef.current]);
      writtenRef.current++;
    }
  }, [sessionWriter]);

  const compactNow = useCallback(async () => {
    if (!providerRef.current) return;
    const est = estimateTokens(historyRef.current);
    dispatch({ type: "info", text: `Compacting context (est. ${est} tokens)…` });
    try {
      pruneToolOutputs(historyRef.current);
      historyRef.current = await compactMessages(
        providerRef.current,
        historyRef.current,
        new AbortController().signal,
      );
      writtenRef.current = 0;
      flushSessionWrites(); // record the summary message in the session file
      dispatch({ type: "info", text: `Compacted: ${est} → ${estimateTokens(historyRef.current)} tokens` });
    } catch (err) {
      dispatch({ type: "error", error: `Compaction failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, [flushSessionWrites]);

  const startRun = useCallback(() => {
    if (busyRef.current) return;
    if (!providerRef.current) {
      dispatch({ type: "error", error: "No provider configured — run /login to connect a provider" });
      return;
    }
    busyRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "run_start" });
    const events = new Emitter();

    // Stream coalescing: burst-then-settle pattern.
    //   First token of a burst dispatches via setImmediate so the user sees
    //   the first character within a frame (no 50ms blank-then-flush lag).
    //   Subsequent tokens within ~33ms accumulate into a single dispatch.
    //   Tool/tool_start/tool_end/turn_end/error boundaries flush immediately
    //   so a transcript never gets stranded inside the buffer mid-tool.
    //
    // Empirically, terminal render at 30fps (33ms) feels smoother than the
    // original 50ms cadence (which produced a noticeable "burst, freeze,
    // burst" rhythm on long completions) while keeping per-render text
    // short enough that the Markdown re-parse inside StreamingText stays
    // cheap (≤200KB chars/sec streaming in practice).
    let textBuf = "";
    let thinkBuf = "";
    const flushStream = (): void => {
      if (textBuf) {
        const t = textBuf;
        textBuf = "";
        dispatch({ type: "text_delta", text: t });
      }
      if (thinkBuf) {
        const t = thinkBuf;
        thinkBuf = "";
        dispatch({ type: "thinking_delta", text: t });
      }
    };
    let streamTimer: ReturnType<typeof setTimeout> | null = null;
    const kickStream = (): void => {
      if (streamTimer) return;
      // Leading edge: flush on the next macrotask so the very first token
      // lands within a frame rather than waiting ~33ms.
      streamTimer = setTimeout(() => {
        streamTimer = null;
        flushStream();
      }, 33);
    };
    const flushStreamNow = (): void => {
      if (streamTimer) {
        clearTimeout(streamTimer);
        streamTimer = null;
      }
      flushStream();
    };
    events.on("text_delta", (e) => {
      textBuf += e.text;
      kickStream();
    });
    events.on("thinking_delta", (e) => {
      thinkBuf += e.text;
      kickStream();
    });
    events.on("tool_use_start", (e) => {
      flushStreamNow();
      dispatch({ type: "tool_use_start", id: e.id, name: e.name });
    });
    events.on("tool_delta", (e) => {
      dispatch({ type: "tool_delta", id: e.id, partialJson: e.partialJson });
    });
    events.on("tool_start", (e) => {
      flushStreamNow();
      dispatch({ type: "tool_start", id: e.id, name: e.name, input: e.input });
    });
    events.on("tool_end", (e) => {
      flushStreamNow();
      dispatch({ type: "tool_end", id: e.id, name: e.name, result: e.result });
    });
    events.on("turn_end", (e) => {
      flushStreamNow();
      lastUsageRef.current = e.usage;
      dispatch({ type: "turn_end", stopReason: e.stopReason, usage: e.usage });
    });
    events.on("error", (e) => {
      flushStreamNow();
      dispatch({ type: "error", error: e.error });
    });
    const steering = {
      take: (): Message | null => {
        const msg = queueRef.current.shift() ?? null;
        dispatch({ type: "queue_update", count: queueRef.current.length });
        return msg;
      },
    };
    void (async () => {
      await runtime.emitTurnStart();
      await runHooks(hooksConfig, { event: "turn_start", cwd: process.cwd() });
      try {
        await runAgentLoop({
          provider: providerRef.current!,
          system,
          messages: historyRef.current,
          tools: buildTools(events),
          events,
          signal: controller.signal,
          steering,
          thinking: thinkingRef.current,
        });
      } finally {
        await runHooks(hooksConfig, { event: "turn_end", cwd: process.cwd() });
        await runtime.emitTurnEnd();
      }
    })().then(
      async () => {
        flushSessionWrites();
        if (lastUsageRef.current && shouldCompact(lastUsageRef.current, modelRef.current, providerIdRef.current)) {
          await compactNow(); // busy stays true while compacting: submissions queue up
        }
        busyRef.current = false;
        abortRef.current = null;
        // Drain extension followUps (slash-prefixed ones route as commands, e.g. reload-self),
        // then chain any steering-queued messages into the next run.
        for (const text of followUpRef.current.splice(0)) {
          handleSubmitRef.current(text);
        }
        if (!busyRef.current && queueRef.current.length > 0) {
          historyRef.current.push(...queueRef.current.splice(0));
          dispatch({ type: "queue_update", count: 0 });
          startRun();
        }
      },
      (err) => {
        busyRef.current = false;
        abortRef.current = null;
        dispatch({ type: "error", error: err instanceof Error ? err.message : String(err) });
      },
    );
  }, [system, runtime, buildTools, compactNow, flushSessionWrites, hooksConfig]);

  const switchProvider = useCallback(
    (id: string, model?: string) => {
      const next = registryMakeProvider(id, { model });
      providerRef.current = next;
      setProviderId(id);
      const m = model ?? next.defaultModel;
      setModelName(m);
      // One atomic write so the next launch restores both.
      if (onChoiceChange) onChoiceChange(id, m);
      else {
        onProviderChange?.(id);
        onModelChange?.(m);
      }
      return next;
    },
    [onModelChange, onProviderChange, onChoiceChange],
  );

  const handleLoginDone = useCallback(
    (result: LoginResult | null) => {
      setLogin(null);
      if (!result) {
        dispatch({ type: "info", text: "Login cancelled" });
        return;
      }
      const method = result.method === "oauth" ? "OAuth" : "API key";
      dispatch({ type: "info", text: `Logged in to ${result.providerId} (${method})` });
      try {
        const next = switchProvider(result.providerId);
        dispatch({ type: "info", text: `Now using ${result.providerId} / ${next.defaultModel}` });
      } catch (err) {
        dispatch({ type: "error", error: err instanceof Error ? err.message : String(err) });
      }
    },
    [switchProvider],
  );

  const handleSlash = useCallback(
    (cmd: string, args: string) => {
      switch (cmd) {
        case "help":
          dispatch({
            type: "info",
            text: SLASH_COMMANDS.map((c) => `/${c.name} — ${c.description}`).join("\n"),
          });
          return;
        case "clear":
          historyRef.current = [];
          writtenRef.current = 0;
          sessionWriter?.markCleared();
          dispatch({ type: "clear" });
          dispatch({ type: "info", text: "History cleared (new messages keep appending to the same session file)" });
          return;
        case "compact":
          busyRef.current = true;
          void compactNow().finally(() => {
            busyRef.current = false;
          });
          return;
        case "cost": {
          const u = stateRef.current.usage;
          dispatch({
            type: "info",
            text: `Usage: ${u.input} in / ${u.output} out / cache ${u.cacheRead} read, ${u.cacheWrite} write — est. $${estimateCost(modelRef.current, u).toFixed(4)}`,
          });
          return;
        }
        case "model":
          if (!args) {
            setModelPicker({ models: [], loading: true });
            void modelsFor(providerIdRef.current).then((list) => {
              setModelPicker({ models: list, loading: false });
            });
          } else {
            try {
              switchProvider(providerIdRef.current, args);
              dispatch({ type: "info", text: `Switched to model ${args} (prompt cache reset)` });
            } catch (err) {
              dispatch({ type: "error", error: err instanceof Error ? err.message : String(err) });
            }
          }
          return;
        case "limits": {
          dispatch({
            type: "info",
            text: formatLimitsReport(providerIdRef.current, modelRef.current),
          });
          return;
        }
        case "permissions": {
          setPermissionsOpen(true);
          return;
        }
        case "resume": {
          setResumePicker({ sessions: [], loading: true });
          void listSessions(process.cwd()).then((sessions) => {
            setResumePicker({ sessions, loading: false });
          });
          return;
        }
        case "name": {
          if (!args.trim()) {
            dispatch({ type: "error", error: "Usage: /name <label>" });
            return;
          }
          if (!sessionWriter) {
            dispatch({ type: "error", error: "No active session" });
            return;
          }
          try {
            renameSession(sessionWriter.path, args.trim());
            sessionWriter.setName?.(args.trim());
            dispatch({ type: "info", text: `Session named: ${args.trim()} (${sessionWriter.id})` });
          } catch (err) {
            dispatch({ type: "error", error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }
        case "export": {
          if (!sessionWriter) {
            dispatch({ type: "error", error: "No active session to export" });
            return;
          }
          try {
            // Flush latest messages first
            while (writtenRef.current < historyRef.current.length) {
              sessionWriter.append(historyRef.current[writtenRef.current]);
              writtenRef.current++;
            }
            const out = exportSessionMarkdown(sessionWriter.path, args.trim() || undefined);
            dispatch({ type: "info", text: `Exported session → ${out}` });
          } catch (err) {
            dispatch({ type: "error", error: `Export failed: ${err instanceof Error ? err.message : String(err)}` });
          }
          return;
        }
        case "provider":
          if (!args) {
            setProviderPickerOpen(true);
          } else {
            try {
              const next = switchProvider(args);
              dispatch({ type: "info", text: `Switched to ${args} / ${next.defaultModel}` });
            } catch (err) {
              dispatch({ type: "error", error: err instanceof Error ? err.message : String(err) });
            }
          }
          return;
        case "thinking": {
          if (!args) {
            const cap = detectThinking(modelRef.current, providerIdRef.current);
            dispatch({
              type: "info",
              text: `Thinking: ${thinkingRef.current} · model ${cap.supported ? "supports" : "may not support"} extended thinking (${cap.reason})\nLevels: ${THINKING_LEVELS.join(" | ")}\nUsage: /thinking <level>`,
            });
            return;
          }
          const level = parseThinkingLevel(args);
          if (!level) {
            dispatch({ type: "error", error: `Unknown thinking level "${args}". Try: ${THINKING_LEVELS.join(", ")}` });
            return;
          }
          setThinkingLevel(level);
          thinkingRef.current = level;
          saveSettings({ thinking: level });
          const cap = detectThinking(modelRef.current, providerIdRef.current);
          dispatch({
            type: "info",
            text: `Thinking set to ${level}${cap.supported ? "" : " (model may ignore — " + cap.reason + ")"}`,
          });
          return;
        }
        case "theme": {
          if (!args) {
            const list = THEME_IDS.map((id) => `  ${id === themeId ? "●" : " "} ${id.padEnd(8)} ${THEMES[id].description}`).join("\n");
            dispatch({ type: "info", text: `Theme: ${themeId}\n${list}\nUsage: /theme <name>` });
            return;
          }
          const next = args.toLowerCase() as ThemeId;
          if (!THEME_IDS.includes(next)) {
            dispatch({ type: "error", error: `Unknown theme "${args}". Try: ${THEME_IDS.join(", ")}` });
            return;
          }
          setThemeId(next);
          saveSettings({ theme: next });
          dispatch({ type: "info", text: `Theme → ${next} (${THEMES[next].description})` });
          return;
        }
        case "login":
          setLogin({ providerId: args || undefined });
          return;
        case "reload":
          void runtime.reload().then((res) => {
            setReloadTick((t) => t + 1);
            dispatch({ type: "info", text: res.message });
          });
          return;
        case "logout":
          if (!args) {
            dispatch({ type: "error", error: "Usage: /logout <provider>" });
            return;
          }
          clearCred(args);
          dispatch({ type: "info", text: `Logged out of ${args} (stored credentials removed)` });
          return;
        case "exit":
          exit();
          setTimeout(() => process.exit(0), 100);
          return;
        default: {
          const ext = runtime.command(cmd);
          if (!ext) {
            dispatch({ type: "error", error: `Unknown command: /${cmd} — try /help` });
            return;
          }
          void Promise.resolve(ext.handler(args, runtime.commandContext(cmd))).catch((err) => {
            dispatch({
              type: "error",
              error: `/${cmd} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
            });
          });
        }
      }
    },
    [compactNow, engine, exit, onModelChange, sessionWriter, runtime, switchProvider, themeId],
  );

  const handleSubmit = useCallback(
    (raw: string) => {
      const slash = parseSlash(raw);
      if (slash) {
        if (busyRef.current) {
          dispatch({ type: "info", text: "Run in progress — slash commands are disabled while running" });
        } else {
          handleSlash(slash.cmd, slash.args);
        }
        return;
      }
      // First user message dismisses the startup logo permanently.
      setShowBanner(false);
      setJumpIdx(-1);
      dispatch({ type: "user_submit", text: raw });
      void (async () => {
        const text = await expandMentions(raw, process.cwd());
        const msg: Message = { role: "user", content: [{ type: "text", text }] };
        if (busyRef.current) {
          queueRef.current.push(msg);
          dispatch({ type: "queue_update", count: queueRef.current.length });
        } else {
          historyRef.current.push(msg);
          if (sessionWriter) {
            sessionWriter.append(msg);
            writtenRef.current++;
          }
          startRun();
        }
      })();
    },
    [handleSlash, sessionWriter, startRun],
  );

  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  const resolvePermission = useCallback((choice: PermissionChoice) => {
    dispatch({ type: "permission_resolve" });
    resolverRef.current?.(choice);
    resolverRef.current = null;
  }, []);

  const handleAcceptEditsSession = useCallback(() => {
    engine.acceptEditsThisSession();
    dispatch({ type: "info", text: "Session: all write/edit calls allowed until restart" });
  }, [engine]);

  // Live terminal size — re-renders on window resize (Ink useWindowSize).
  const win = useWindowSize();
  const layout = useMemo(() => layoutFromTerminal(win.columns, win.rows), [win.columns, win.rows]);
  const scrollStepRef = useRef(layout.scrollStep);
  scrollStepRef.current = layout.scrollStep;

  // Stable InputBox callbacks so its memo holds during stream ticks.
  const handleInputEscape = useCallback(() => abortRef.current?.abort(), []);
  const handleScrollUp = useCallback(() => {
    setJumpIdx(-1);
    dispatch({ type: "scroll", delta: scrollStepRef.current });
  }, []);
  const handleScrollDown = useCallback(() => {
    setJumpIdx(-1);
    dispatch({ type: "scroll", delta: -scrollStepRef.current });
  }, []);

  const resolveConfirm = useCallback((yes: boolean) => {
    dispatch({ type: "confirm_resolve" });
    confirmResolverRef.current?.(yes);
    confirmResolverRef.current = null;
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      if (login) return;
      if (modelPicker) {
        setModelPicker(null);
        return;
      }
      if (providerPickerOpen) {
        setProviderPickerOpen(false);
        return;
      }
      if (resumePicker) {
        setResumePicker(null);
        return;
      }
      if (permissionsOpen) {
        setPermissionsOpen(false);
        return;
      }
      if (jumpIdx >= 0) {
        setJumpIdx(-1);
        dispatch({ type: "scroll_to_end" });
        return;
      }
      if (stateRef.current.permission) resolvePermission("deny");
      abortRef.current?.abort();
      return;
    }
    // Overlays own their keys
    if (
      modelPicker ||
      providerPickerOpen ||
      resumePicker ||
      permissionsOpen ||
      login ||
      stateRef.current.permission ||
      stateRef.current.confirm
    )
      return;

    // Jump to previous / next user query: [ and ] (or Shift+Left / Shift+Right)
    if (input === "[" || (key.leftArrow && key.shift)) {
      const ids = userEntryIds(stateRef.current.entries);
      if (ids.length === 0) return;
      setJumpIdx((i) => {
        if (i < 0) return ids.length - 1;
        return Math.max(0, i - 1);
      });
      dispatch({ type: "scroll", delta: 0 }); // detach from tail
      return;
    }
    if (input === "]" || (key.rightArrow && key.shift)) {
      const ids = userEntryIds(stateRef.current.entries);
      if (ids.length === 0) return;
      setJumpIdx((i) => {
        if (i < 0) return -1;
        if (i >= ids.length - 1) {
          dispatch({ type: "scroll_to_end" });
          return -1;
        }
        return i + 1;
      });
      return;
    }

    if (key.pageUp || (key.ctrl && input === "u")) {
      setJumpIdx(-1);
      dispatch({ type: "scroll", delta: scrollStepRef.current });
      return;
    }
    if (key.pageDown || (key.ctrl && input === "d")) {
      setJumpIdx(-1);
      dispatch({ type: "scroll", delta: -scrollStepRef.current });
      return;
    }
    if (key.end || (key.ctrl && input === "e")) {
      setJumpIdx(-1);
      dispatch({ type: "scroll_to_end" });
      return;
    }
    if (key.ctrl && input === "g") {
      setJumpIdx(-1);
      dispatch({ type: "scroll_to_top" });
      return;
    }
    if (input === "c" && key.ctrl) {
      if (stateRef.current.permission) resolvePermission("deny");
      if (busyRef.current) {
        abortRef.current?.abort();
        return;
      }
      const now = Date.now();
      if (now - lastCtrlCRef.current < 1000) {
        exit();
        setTimeout(() => process.exit(0), 100);
      } else {
        lastCtrlCRef.current = now;
        dispatch({ type: "info", text: "Press Ctrl+C again to exit" });
      }
    }
  });

  const showJump = (!state.followTail || state.scrollOffset > 0) && jumpIdx < 0;
  // Cached O(history) estimate; recomputed only when history is pushed to or replaced.
  const history = historyRef.current;
  let contextUsed = ctxCacheRef.current?.value ?? 0;
  if (ctxCacheRef.current?.arr !== history || ctxCacheRef.current.len !== history.length) {
    contextUsed = estimateTokens(history);
    ctxCacheRef.current = { arr: history, len: history.length, value: contextUsed };
  }
  const anyToolRunning = useMemo(
    () => state.entries.some((e) => e.kind === "tool" && e.status === "running"),
    [state.entries],
  );

  const { columns: termCols, rows: termRows, inputWidth, messageWindow, pickerWindow } = layout;

  const composer =
    login ? (
      <LoginFlow
        theme={theme}
        initialProviderId={login.providerId}
        providers={listProviders()}
        onDone={handleLoginDone}
      />
    ) : providerPickerOpen ? (
      <ProviderPicker
        theme={theme}
        providers={listProviders()}
        currentId={providerId}
        title="Switch provider"
        windowSize={pickerWindow}
        onPick={(row) => {
          setProviderPickerOpen(false);
          try {
            const next = switchProvider(row.spec.id);
            dispatch({ type: "info", text: `Provider → ${row.spec.id} / ${next.defaultModel}` });
          } catch (err) {
            dispatch({ type: "error", error: err instanceof Error ? err.message : String(err) });
          }
        }}
        onCancel={() => setProviderPickerOpen(false)}
      />
    ) : modelPicker ? (
      <ModelPicker
        theme={theme}
        models={modelPicker.models}
        current={modelName}
        loading={modelPicker.loading}
        windowSize={pickerWindow}
        onPick={(id) => {
          setModelPicker(null);
          try {
            switchProvider(providerIdRef.current, id);
            dispatch({ type: "info", text: `Model → ${id}` });
          } catch (err) {
            dispatch({ type: "error", error: err instanceof Error ? err.message : String(err) });
          }
        }}
        onCancel={() => setModelPicker(null)}
      />
    ) : resumePicker ? (
      <ResumePicker
        theme={theme}
        sessions={resumePicker.sessions}
        currentId={sessionWriter?.id}
        loading={resumePicker.loading}
        windowSize={pickerWindow}
        onPick={(s) => {
          setResumePicker(null);
          void (async () => {
            try {
              const loaded = await loadSession(s.path);
              historyRef.current = loaded.messages;
              writtenRef.current = loaded.messages.length;
              setSessionWriter(openSessionWriter(s.path, s.id));
              dispatch({ type: "clear" });
              dispatch({
                type: "info",
                text: `Resumed session ${s.id} (${loaded.messages.length} messages)`,
              });
              setShowBanner(false);
            } catch (err) {
              dispatch({ type: "error", error: err instanceof Error ? err.message : String(err) });
            }
          })();
        }}
        onCancel={() => setResumePicker(null)}
      />
    ) : permissionsOpen ? (
      <PermissionsPanel
        theme={theme}
        engine={engine}
        onChange={(snap) => {
          persistPermissions(snap);
          dispatch({
            type: "info",
            text: `Permissions updated · mode=${snap.defaultMode} · allow=${snap.allow.length} deny=${snap.deny.length}`,
          });
        }}
        onClose={() => setPermissionsOpen(false)}
      />
    ) : state.permission ? (
      <PermissionPrompt
        request={state.permission}
        onResolve={resolvePermission}
        onAcceptEditsSession={handleAcceptEditsSession}
      />
    ) : state.confirm ? (
      <ConfirmPrompt title={state.confirm.title} detail={state.confirm.detail} onResolve={resolveConfirm} />
    ) : (
      <InputBox
        running={state.running}
        theme={theme}
        width={showBanner ? inputWidth : termCols}
        onSubmit={handleSubmit}
        onEscape={handleInputEscape}
        slashCommands={slashCommands}
        fileCandidates={fileCandidates}
        onScrollUp={handleScrollUp}
        onScrollDown={handleScrollDown}
      />
    );

  // ── Welcome: soft-centered logo + input (no fixed terminal height) ──
  // Ink on Windows clears the entire terminal for any frame whose height >=
  // viewport rows. Never pin the root to termRows or history vanishes on every
  // keystroke / stream tick. Soft vertical padding keeps total height under
  // the viewport so scrollback stays intact (Grok Build / Claude Code style).
  if (showBanner && !login && !modelPicker && !providerPickerOpen && !resumePicker && !permissionsOpen) {
    // Header(~7) + input(~3) + meta(~3) + tip(~2) ≈ 15 rows of content.
    const welcomePad = Math.max(0, Math.min(8, Math.floor((termRows - 16) / 2)));
    return (
      <Box flexDirection="column" width={termCols} alignItems="center">
        {welcomePad > 0 ? <Box height={welcomePad} /> : null}
        <Header theme={theme} />
        <Box width={inputWidth} flexDirection="column" alignItems="stretch">
          {composer}
        </Box>
          <Box marginTop={1} flexDirection="column" alignItems="center">
            <Text>
              <Text color={theme.accent} bold>
                {providerId === "fake" ? "demo" : providerId}
              </Text>
              <Text color={theme.accentDim}>{"  ·  "}</Text>
              <Text color={theme.highlight}>{modelName}</Text>
              {thinkLabel && !thinkLabel.endsWith(":off") ? (
                <>
                  <Text color={theme.accentDim}>{"  ·  "}</Text>
                  <Text color={theme.thinking}>{thinkLabel}</Text>
                </>
              ) : null}
            </Text>
          </Box>
      </Box>
    );
  }

  // ── Active chat: document flow + <Static> transcript (not a fullscreen viewport) ──
  // Committed messages go through MessageList → Ink <Static> and remain in the
  // terminal scrollback. Only the live region (stream / tools / input / status)
  // is rewritten each frame — same pattern as Grok Build and other agent TUIs.
  return (
    <Box flexDirection="column" width={termCols}>
      <MessageList
        entries={state.entries}
        theme={theme}
        scrollOffset={jumpIdx >= 0 ? 0 : state.scrollOffset}
        windowSize={messageWindow}
        jumpFocusId={jumpFocusId}
        width={termCols}
      />
      {state.streamingThinking || (state.running && !state.streamingText && !anyToolRunning) ? (
        <ThinkingStream text={state.streamingThinking} theme={theme} active={state.running} />
      ) : null}
      {state.streamingText ? (
        <StreamingText
          text={state.streamingText}
          theme={theme}
          maxLines={Math.max(8, termRows - 8)}
          width={termCols}
        />
      ) : null}
      <ScrollToEnd
        theme={theme}
        visible={showJump || jumpIdx >= 0}
        unread={state.scrollOffset}
        onJump={() => {
          setJumpIdx(-1);
          dispatch({ type: "scroll_to_end" });
        }}
      />
      <Box flexDirection="column" width={termCols}>
        {composer}
        {jumpIdx >= 0 ? (
          <Text>
            <Text color={theme.accent}>  [ / ] </Text>
            <Text color={theme.text}>
              query {jumpIdx + 1}/{userEntryIds(state.entries).length}
            </Text>
            <Text color={theme.accentDim}> · Esc or Jump to latest to return</Text>
          </Text>
        ) : null}
        <StatusLine
          theme={theme}
          model={modelName}
          providerId={providerId}
          cwd={process.cwd()}
          usage={state.usage}
          cost={estimateCost(modelName, state.usage)}
          queued={state.queuedCount}
          bgRunning={state.bgRunning}
          running={state.running}
          thinkingLabel={thinkLabel}
          contextUsed={contextUsed}
          width={termCols}
        />
      </Box>
    </Box>
  );
}
