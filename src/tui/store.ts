import type { StopReason, ToolResult, Usage } from "../core/types.js";

export type Entry =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | {
      id: number;
      kind: "tool";
      toolId: string;
      name: string;
      input: unknown;
      /** Streaming partial JSON args (before tool_start finalizes input). */
      partialJson?: string;
      status: "running" | "done";
      result?: ToolResult;
    }
  | { id: number; kind: "info" | "error"; text: string }
  | { id: number; kind: "thinking"; text: string };

export interface PendingPermission {
  tool: string;
  detail: string;
  input?: unknown;
}

export interface State {
  entries: Entry[];
  streamingText: string;
  streamingThinking: string;
  running: boolean;
  usage: Usage;
  permission: PendingPermission | null;
  confirm: { title: string; detail?: string } | null;
  queuedCount: number;
  /** Running background bash jobs (bg-N). */
  bgRunning: number;
  nextId: number;
  /** 0 = stick to bottom; >0 = lines scrolled up from end */
  scrollOffset: number;
  followTail: boolean;
}

export type Action =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_delta"; id: string; partialJson: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_end"; id: string; name: string; result: ToolResult }
  | { type: "turn_end"; stopReason: StopReason; usage: Usage }
  | { type: "error"; error: string }
  | { type: "info"; text: string }
  | { type: "user_submit"; text: string }
  | { type: "run_start" }
  | { type: "permission_request"; request: PendingPermission }
  | { type: "permission_resolve" }
  | { type: "confirm_request"; title: string; detail?: string }
  | { type: "confirm_resolve" }
  | { type: "queue_update"; count: number }
  | { type: "bg_update"; running: number }
  | { type: "clear" }
  | { type: "scroll"; delta: number }
  | { type: "scroll_to_end" }
  | { type: "scroll_to_top" };

export const initialState: State = {
  entries: [],
  streamingText: "",
  streamingThinking: "",
  running: false,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  permission: null,
  confirm: null,
  queuedCount: 0,
  bgRunning: 0,
  nextId: 1,
  scrollOffset: 0,
  followTail: true,
};

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

function commitStreaming(state: State): State {
  let s = state;
  if (s.streamingThinking.length > 0) {
    s = {
      ...s,
      streamingThinking: "",
      entries: [...s.entries, { id: s.nextId, kind: "thinking", text: s.streamingThinking }],
      nextId: s.nextId + 1,
    };
  }
  if (s.streamingText.length === 0) return s;
  return {
    ...s,
    streamingText: "",
    entries: [...s.entries, { id: s.nextId, kind: "assistant", text: s.streamingText }],
    nextId: s.nextId + 1,
  };
}

function maybeFollow(state: State, next: State): State {
  // New content while following: stay at bottom
  if (state.followTail) return { ...next, scrollOffset: 0, followTail: true };
  return next;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "text_delta":
      return maybeFollow(state, { ...state, streamingText: state.streamingText + action.text });
    case "thinking_delta":
      return maybeFollow(state, { ...state, streamingThinking: state.streamingThinking + action.text });
    case "tool_use_start": {
      const s = commitStreaming(state);
      // Avoid duplicate rows if tool_start already created this id.
      if (s.entries.some((e) => e.kind === "tool" && e.toolId === action.id)) return s;
      return maybeFollow(s, {
        ...s,
        entries: [
          ...s.entries,
          {
            id: s.nextId,
            kind: "tool",
            toolId: action.id,
            name: action.name,
            input: null,
            partialJson: "",
            status: "running",
          },
        ],
        nextId: s.nextId + 1,
      });
    }
    case "tool_delta": {
      return {
        ...state,
        entries: state.entries.map((e) =>
          e.kind === "tool" && e.toolId === action.id
            ? { ...e, partialJson: (e.partialJson ?? "") + action.partialJson }
            : e,
        ),
      };
    }
    case "tool_start": {
      const s = commitStreaming(state);
      const existing = s.entries.find((e) => e.kind === "tool" && e.toolId === action.id);
      if (existing) {
        return {
          ...s,
          entries: s.entries.map((e) =>
            e.kind === "tool" && e.toolId === action.id
              ? { ...e, name: action.name, input: action.input, status: "running" as const }
              : e,
          ),
        };
      }
      return maybeFollow(s, {
        ...s,
        entries: [
          ...s.entries,
          { id: s.nextId, kind: "tool", toolId: action.id, name: action.name, input: action.input, status: "running" },
        ],
        nextId: s.nextId + 1,
      });
    }
    case "tool_end": {
      const s = commitStreaming(state);
      return {
        ...s,
        entries: s.entries.map((e) =>
          e.kind === "tool" && e.toolId === action.id ? { ...e, status: "done" as const, result: action.result } : e,
        ),
      };
    }
    case "turn_end": {
      let s = commitStreaming(state);
      if (action.stopReason === "aborted") {
        s = {
          ...s,
          entries: [...s.entries, { id: s.nextId, kind: "info" as const, text: "Interrupted by user" }],
          nextId: s.nextId + 1,
        };
      }
      return maybeFollow(s, { ...s, running: false, usage: addUsage(s.usage, action.usage) });
    }
    case "error":
      return maybeFollow(state, {
        ...state,
        entries: [...state.entries, { id: state.nextId, kind: "error", text: action.error }],
        nextId: state.nextId + 1,
      });
    case "info":
      return maybeFollow(state, {
        ...state,
        entries: [...state.entries, { id: state.nextId, kind: "info", text: action.text }],
        nextId: state.nextId + 1,
      });
    case "user_submit":
      return {
        ...state,
        entries: [...state.entries, { id: state.nextId, kind: "user", text: action.text }],
        nextId: state.nextId + 1,
        scrollOffset: 0,
        followTail: true,
      };
    case "run_start":
      return { ...state, running: true, streamingThinking: "", followTail: state.followTail };
    case "permission_request":
      return { ...state, permission: action.request };
    case "permission_resolve":
      return { ...state, permission: null };
    case "confirm_request":
      return { ...state, confirm: { title: action.title, detail: action.detail } };
    case "confirm_resolve":
      return { ...state, confirm: null };
    case "queue_update":
      return { ...state, queuedCount: action.count };
    case "bg_update":
      return { ...state, bgRunning: action.running };
    case "clear":
      return {
        ...initialState,
        usage: state.usage,
        nextId: state.nextId,
        followTail: true,
        scrollOffset: 0,
      };
    case "scroll": {
      // Positive delta = scroll up (older messages)
      const next = Math.max(0, state.scrollOffset + action.delta);
      return { ...state, scrollOffset: next, followTail: next === 0 };
    }
    case "scroll_to_end":
      return { ...state, scrollOffset: 0, followTail: true };
    case "scroll_to_top":
      return { ...state, scrollOffset: Math.max(0, state.entries.length), followTail: false };
  }
}
