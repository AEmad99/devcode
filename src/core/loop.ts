import type { Provider } from "../providers/types.js";
import type { Emitter } from "./events.js";
import { isParallelSafeToolName } from "./tools/index.js";
import { validateToolInput } from "./tools/index.js";
import type { ContentBlock, Message, StopReason, StreamEvent, ToolDef, ToolResult, Usage } from "./types.js";

const DEFAULT_MAX_TURNS = 100;
const MAX_TOKENS = 16384;
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Parallel-safe predicate, accepting either a name or a tool def.
 * - When given a name: looks up the built-in name set (single source of truth).
 * - When given a ToolDef: also honors a per-def `parallelSafe: true` hint so
 *   extension tools that opt in participate in parallel batching.
 *
 * Kept name-based for back-compat with project-instructions.test.ts.
 */
export function isParallelSafeTool(nameOrTool: string | ToolDef): boolean {
  if (typeof nameOrTool === "string") return isParallelSafeToolName(nameOrTool);
  if (nameOrTool.parallelSafe) return true;
  return isParallelSafeToolName(nameOrTool.name);
}

/**
 * Def-only predicate, used by batchToolUses where we already have the def.
 */
function isParallelSafeByDef(tool: ToolDef): boolean {
  if (tool.parallelSafe) return true;
  return isParallelSafeToolName(tool.name);
}

export interface LoopOptions {
  provider: Provider;
  system: string;
  messages: Message[];
  tools: ToolDef[];
  events: Emitter;
  signal: AbortSignal;
  maxTurns?: number; // default 100
  steering?: { take(): Message | null }; // queue polled between turns/tools; may be null
  loopDetect?: boolean; // default true: stop when one tool is called 3x in a row with identical input
  thinking?: import("./thinking.js").ThinkingLevel;
  /** When false, always run tools sequentially. Default true. */
  parallelTools?: boolean;
}

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

export async function runAgentLoop(opts: LoopOptions): Promise<{ messages: Message[]; stopReason: StopReason }> {
  const { provider, system, messages, tools, events, signal, steering } = opts;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const loopDetect = opts.loopDetect ?? true;
  const parallelTools = opts.parallelTools ?? true;
  let loopKey: string | null = null;
  let loopStreak = 0;
  let loopError: string | null = null;

  const fail = (error: string): { messages: Message[]; stopReason: StopReason } => {
    events.emit({ type: "error", error });
    events.emit({ type: "turn_end", stopReason: "error", usage: ZERO_USAGE });
    return { messages, stopReason: "error" };
  };

  for (let turn = 0; ; turn++) {
    const steered = steering?.take();
    if (steered) {
      messages.push(steered);
      loopKey = null; // user steering resets the identical-call streak
      loopStreak = 0;
    }
    if (turn >= maxTurns) return fail(`Max turns (${maxTurns}) reached`);

    let done: Extract<StreamEvent, { type: "done" }> | undefined;
    let partialText = "";
    try {
      for await (const ev of provider.stream({
        system,
        messages,
        tools,
        maxTokens: MAX_TOKENS,
        signal,
        thinking: opts.thinking,
      })) {
        if (ev.type === "text_delta") {
          partialText += ev.text;
          events.emit({ type: "text_delta", text: ev.text });
        } else if (ev.type === "thinking_delta") {
          events.emit({ type: "thinking_delta", text: ev.text });
        } else if (ev.type === "tool_use_start") {
          events.emit({ type: "tool_use_start", id: ev.id, name: ev.name });
        } else if (ev.type === "tool_use_delta") {
          events.emit({ type: "tool_delta", id: ev.id, partialJson: ev.partialJson });
        } else if (ev.type === "done") done = ev;
      }
    } catch (err) {
      // Keep any text that already streamed so the transcript isn't silent on a drop.
      if (partialText && !done) {
        messages.push({ role: "assistant", content: [{ type: "text", text: partialText }] });
      }
      if (signal.aborted) {
        events.emit({ type: "turn_end", stopReason: "aborted", usage: ZERO_USAGE });
        return { messages, stopReason: "aborted" };
      }
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (!done) return fail("Provider stream ended without a done event");

    messages.push(done.message);
    if (done.stopReason !== "tool_use") {
      events.emit({ type: "turn_end", stopReason: done.stopReason, usage: done.usage });
      return { messages, stopReason: done.stopReason };
    }

    const toolUses = done.message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const results: ContentBlock[] = [];
    let aborted = false;
    let steerMsg: Message | null = null;

    // Batch consecutive parallel-safe tools; mutate / unknown tools run alone.
    const batches = parallelTools ? batchToolUses(toolUses, tools) : toolUses.map((tu) => [tu]);

    for (const batch of batches) {
      if (aborted || steerMsg || loopError) {
        for (const tu of batch) {
          if (loopError) results.push(errorResult(tu.id, loopError));
          else if (steerMsg) results.push(errorResult(tu.id, "Skipped: user sent a new message"));
          else results.push(errorResult(tu.id, "Aborted by user"));
        }
        continue;
      }

      if (signal.aborted) {
        aborted = true;
        for (const tu of batch) results.push(errorResult(tu.id, "Aborted by user"));
        continue;
      }

      const s = steering?.take();
      if (s) {
        steerMsg = s;
        loopKey = null;
        loopStreak = 0;
        for (const tu of batch) results.push(errorResult(tu.id, "Skipped: user sent a new message"));
        continue;
      }

      // Loop detect: sequential keys across the batch (same as one-by-one).
      if (loopDetect) {
        let batchLoopError: string | null = null;
        for (const tu of batch) {
          const key = `${tu.name}\0${JSON.stringify(tu.input)}`;
          loopStreak = key === loopKey ? loopStreak + 1 : 1;
          loopKey = key;
          if (loopStreak >= 3) {
            batchLoopError = `Loop detected: \`${tu.name}\` called 3 times with identical input`;
            break;
          }
        }
        if (batchLoopError) {
          loopError = batchLoopError;
          for (const tu of batch) results.push(errorResult(tu.id, loopError));
          continue;
        }
      }

      if (batch.length === 1) {
        const tu = batch[0];
        events.emit({ type: "tool_start", id: tu.id, name: tu.name, input: tu.input });
        const result = await executeTool(tools, tu, signal);
        events.emit({ type: "tool_end", id: tu.id, name: tu.name, result });
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: result.content,
          ...(result.is_error ? { is_error: true } : {}),
        });
      } else {
        // Concurrent read-only tools — preserve result order matching batch order.
        for (const tu of batch) {
          events.emit({ type: "tool_start", id: tu.id, name: tu.name, input: tu.input });
        }
        const settled = await Promise.all(batch.map((tu) => executeTool(tools, tu, signal)));
        for (let i = 0; i < batch.length; i++) {
          const tu = batch[i];
          const result = settled[i];
          events.emit({ type: "tool_end", id: tu.id, name: tu.name, result });
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: result.content,
            ...(result.is_error ? { is_error: true } : {}),
          });
        }
      }
    }

    messages.push({ role: "user", content: results });
    if (steerMsg) messages.push(steerMsg);
    if (loopError) return fail(loopError);
  }
}

/**
 * Group consecutive parallel-safe tool uses; others alone.
 *
 * `tools` is the resolved ToolDef list (built-ins + extension tools) so the
 * def-aware predicate can honor an extension tool's `parallelSafe: true` hint.
 * When omitted (legacy callers / project-instructions.test.ts), falls back to
 * the name-based predicate over the built-in set.
 */
export function batchToolUses(toolUses: ToolUseBlock[], tools?: ToolDef[]): ToolUseBlock[][] {
  const isSafe = (name: string): boolean => {
    if (tools) {
      const def = tools.find((t) => t.name === name);
      if (def && isParallelSafeByDef(def)) return true;
      return false;
    }
    return isParallelSafeToolName(name);
  };
  const batches: ToolUseBlock[][] = [];
  let current: ToolUseBlock[] = [];
  for (const tu of toolUses) {
    if (isSafe(tu.name)) {
      current.push(tu);
    } else {
      if (current.length) {
        batches.push(current);
        current = [];
      }
      batches.push([tu]);
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function errorResult(tool_use_id: string, content: string): ContentBlock {
  return { type: "tool_result", tool_use_id, content, is_error: true };
}

async function executeTool(tools: ToolDef[], tu: ToolUseBlock, signal: AbortSignal): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === tu.name);
  if (!tool) return { content: `Unknown tool: ${tu.name}`, is_error: true };
  const invalid = validateToolInput(tool, tu.input);
  if (invalid) return { content: invalid, is_error: true };
  try {
    return await tool.execute(tu.id, tu.input, signal);
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), is_error: true };
  }
}
