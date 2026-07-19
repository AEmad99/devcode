/**
 * Terminal alternate-screen + cursor + wrap management.
 *
 * Why this exists: by default Ink paints into the live scrollback buffer from
 * the current cursor position. Running DevCode after `less` (or any tool that
 * left the prompt not at the top of the viewport) means the TUI inherits that
 * state and renders into whatever rows are left — so the app appears wrapped
 * to the leftover width and clipped to the leftover height.
 *
 * Standard alt-screen recipe (vim / htop / lazygit tradition):
 *
 *   ESC[?1049h   switch to alternate screen buffer (clean canvas)
 *   ESC[?25l     hide text cursor (we draw our own affordances)
 *   ESC[?7l      disable auto-wrap (so long lines repaint at true width)
 *   ESC[2J ESC[H clear+home so the very first frame paints at row 1
 *
 * On exit, the inverse restores the original screen, cursor, and wrap state.
 * Restoring matters: if we leak the alt-screen, the shell prompt would
 * disappear and the user would have to type `tput rmcup` or reset the
 * terminal to recover.
 *
 * Idempotent: `enterFullScreen()` is a no-op after itself; `leaveFullScreen()`
 * too. Safe to wire into multiple exit paths.
 */

const ESC = "\x1b";

// Compose escape sequences via string concat (rather than template literals
// with `${ESC}`) — the bracket chars in CSI sequences look like invalid TS
// expression placeholders inside a template, even though they're inside a
// string literal at runtime.
function csi(n: number, suffix: string): string {
  return `${ESC}[${n}${suffix}`;
}
function csiQuestion(n: number, suffix: string): string {
  return `${ESC}[?${n}${suffix}`;
}
const ALT_SCREEN_ON = csiQuestion(1049, "h");
const ALT_SCREEN_OFF = csiQuestion(1049, "l");
const CURSOR_HIDE = csiQuestion(25, "l");
const CURSOR_SHOW = csiQuestion(25, "h");
const WRAP_DISABLE = csiQuestion(7, "l");
const WRAP_ENABLE = csiQuestion(7, "h");
const CLEAR_SCREEN = csi(2, "J");
// `ESC[H` (no parameter) is the canonical cursor-home sequence — VT100 standard.
// `\x1b[0H` (with an implicit "0" arg) is equivalent but most terminal emulators
// render the bare form, so we emit that.
const CURSOR_HOME = `${ESC}[H`;

/** Switch to the alt screen, hide cursor, disable wrap, clear+home. */
export function enterFullScreen(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(
    ALT_SCREEN_ON + CURSOR_HIDE + WRAP_DISABLE + CLEAR_SCREEN + CURSOR_HOME,
  );
}

/**
 * Inverse of `enterFullScreen()`. Idempotent and safe to call multiple times
 * — process exit, SIGINT, SIGTERM, /exit, Ctrl+C twice all funnel here.
 */
export function leaveFullScreen(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(ALT_SCREEN_OFF + CURSOR_SHOW + WRAP_ENABLE);
}

/**
 * Install a one-shot cleanup so the user's shell isn't stranded in alt-screen
 * if DevCode crashes, panics, or the process is killed externally. We listen
 * for the events that *can* still run user JS (exit, SIGINT, SIGTERM,
 * uncaught exception, unhandled rejection) and tear down the screen once.
 *
 * 'exit' fires last on normal termination; 'SIGINT' / 'SIGTERM' cover Ctrl+C
 * and `kill <pid>`; the uncaught handlers cover programmer error paths.
 */
export function installScreenCleanupOnce(): void {
  const cleanup = (): void => {
    leaveFullScreen();
  };
  // process.on('exit') fires synchronously on normal termination — our only
  // chance to write the restore sequence before the process goes away.
  process.on("exit", cleanup);
  // SIGINT/SIGTERM: the signal handlers themselves must avoid any async work
  // (Node will forcibly terminate after we return), but writing the restore
  // bytes synchronously to stdout is fine.
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  // For uncaught errors, we restore the screen and re-raise so Node's default
  // logging still fires — otherwise the user sees an empty alt-screen and the
  // crash trace in some other process they can't see.
  process.on("uncaughtException", (err) => {
    leaveFullScreen();
    // Re-emit after a tick so stdout has time to flush.
    setImmediate(() => {
      throw err;
    });
  });
  process.on("unhandledRejection", (reason) => {
    leaveFullScreen();
    setImmediate(() => {
      throw reason instanceof Error ? reason : new Error(String(reason));
    });
  });
}
