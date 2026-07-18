import type { StopReason } from "./types.js";

/**
 * Process exit codes for headless `-p` mode.
 * 0 = success, 1 = generic error, 2 = max turns / max tokens,
 * 3 = aborted, 4 = tool/loop error stop reason.
 */
export function exitCodeForStopReason(stopReason: StopReason): number {
  switch (stopReason) {
    case "end_turn":
      return 0;
    case "max_tokens":
      return 2;
    case "aborted":
      return 3;
    case "error":
      return 4;
    case "tool_use":
      // Loop should not exit mid tool_use; treat as unexpected.
      return 1;
    default:
      return 1;
  }
}

/** Special: max-turns fail path uses stopReason "error" with a known message prefix. */
export function exitCodeForLoopResult(stopReason: StopReason, errorMessage?: string): number {
  if (stopReason === "error" && errorMessage?.startsWith("Max turns")) return 2;
  return exitCodeForStopReason(stopReason);
}
