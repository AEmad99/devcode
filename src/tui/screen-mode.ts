/**
 * Terminal cursor + wrap management for the TUI.
 *
 * IMPORTANT: we deliberately do NOT use the alternate screen buffer
 * (ESC[?1049h). The alt screen is a separate buffer that terminals do not
 * keep in scrollback — it is what vim / htop / lazygit use, and on exit the
 * original screen is restored and everything painted into the alt buffer is
 * discarded. That is the opposite of what DevCode wants: the transcript is
 * rendered through Ink <Static>, which writes into the PRIMARY screen so the
 * user can scroll back up with their terminal's native scrollback and read
 * everything the agent did. Using the alt screen made the whole history
 * invisible the moment the user scrolled or exited.
 *
 * So we stay in the primary buffer and only manage the cursor and auto-wrap:
 *
 *   ESC[?25l   hide the text cursor (we draw our own affordances)
 *   ESC[?7l    disable auto-wrap so long lines repaint at true width
 *   ESC[2J ESC[H clear+home once so the first frame paints at row 1
 *
 * On exit we restore the cursor and wrap state. We intentionally do NOT clear
 * on exit: the transcript stays in scrollback for the user to read.
 *
 * Idempotent: `enterScreenMode()` is a no-op after itself; `leaveScreenMode()`
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
const CURSOR_HIDE = csiQuestion(25, "l");
const CURSOR_SHOW = csiQuestion(25, "h");
const WRAP_DISABLE = csiQuestion(7, "l");
const WRAP_ENABLE = csiQuestion(7, "h");
const CLEAR_SCREEN = csi(2, "J");
// `ESC[H` (no parameter) is the canonical cursor-home sequence — VT100 standard.
// `\x1b[0H` (with an implicit "0" arg) is equivalent but most terminal emulators
// render the bare form, so we emit that.
const CURSOR_HOME = `${ESC}[H`;

/** Hide cursor + disable wrap + clear once so the first frame paints cleanly. */
export function enterScreenMode(): void {
  if (!process.stdout.isTTY) return;
  // Stay in the primary buffer so the <Static> transcript lands in scrollback.
  process.stdout.write(CURSOR_HIDE + WRAP_DISABLE + CLEAR_SCREEN + CURSOR_HOME);
}

/**
 * Inverse of `enterScreenMode()`. Idempotent and safe to call multiple times
 * — process exit, SIGINT, SIGTERM, /exit, Ctrl+C twice all funnel here.
 * We do NOT clear the screen: the transcript remains in the terminal scrollback.
 */
export function leaveScreenMode(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(CURSOR_SHOW + WRAP_ENABLE);
}

/**
 * Install a one-shot cleanup so the user's shell isn't left with a hidden
 * cursor or disabled wrap if DevCode crashes, panics, or the process is
 * killed externally. We listen for the events that *can* still run user JS
 * (exit, SIGINT, SIGTERM, uncaught exception, unhandled rejection) and tear
 * down the screen once.
 *
 * 'exit' fires last on normal termination — our only chance to write the
 * restore sequence before the process goes away. SIGINT/SIGTERM handlers must
 * avoid async work (Node forcibly terminates after we return), but writing the
 * restore bytes synchronously to stdout is fine.
 */
export function installScreenCleanupOnce(): void {
  const cleanup = (): void => {
    leaveScreenMode();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  // For uncaught errors, restore the screen and re-raise so Node's default
  // logging still fires — otherwise the user sees a blank cursor and the
  // crash trace in some other process they can't see.
  process.on("uncaughtException", (err) => {
    leaveScreenMode();
    // Re-emit after a tick so stdout has time to flush.
    setImmediate(() => {
      throw err;
    });
  });
  process.on("unhandledRejection", (reason) => {
    leaveScreenMode();
    setImmediate(() => {
      throw reason instanceof Error ? reason : new Error(String(reason));
    });
  });
}