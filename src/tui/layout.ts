/**
 * Terminal layout helpers — keep chrome + message window proportional to
 * live columns/rows so resize events reflow the TUI cleanly.
 */

export interface TerminalLayout {
  columns: number;
  rows: number;
  /** Welcome-screen / centered input width. */
  inputWidth: number;
  /** How many transcript entries to keep in the scrolled window. */
  messageWindow: number;
  /** PageUp/PageDown scroll step (entries). */
  scrollStep: number;
  /** Searchable picker visible rows. */
  pickerWindow: number;
  /**
   * Hard ceiling for the dynamic (non-Static) region's height in rows.
   *
   * Ink 7's shouldClearTerminalForFrame triggers a full clearTerminal write
   * (ESC[2J ESC[3J ESC[H, which erases the whole scrollback buffer) whenever
   * the dynamic output height >= the viewport rows, and on Windows Console
   * whenever the previous or next frame was fullscreen. A fullscreen frame
   * therefore discards the Static transcript the user needs to scroll back
   * through.
   *
   * Keeping the live region under this budget guarantees Ink stays on its
   * incremental erase-lines path (cursor up + erase line), which preserves
   * scrollback. The budget leaves a margin below the viewport so a trailing
   * newline or a border edge can never push the frame to fullscreen.
   */
  liveBudget: number;
}

const MIN_COLS = 40;
const MIN_ROWS = 10;
/** Status + input border + optional stream/think + margins. */
const CHROME_ROWS = 10;

/**
 * Derive UI geometry from terminal dimensions.
 * Safe with zeros/undefined (falls back to classic 80×24).
 */
export function layoutFromTerminal(cols?: number | null, rows?: number | null): TerminalLayout {
  const columns = Math.max(MIN_COLS, Math.floor(cols && cols > 0 ? cols : 80));
  const r = Math.max(MIN_ROWS, Math.floor(rows && rows > 0 ? rows : 24));
  const inputWidth = Math.min(72, Math.max(MIN_COLS, columns - 8));
  const messageWindow = Math.max(6, r - CHROME_ROWS);
  const scrollStep = Math.max(3, Math.floor(messageWindow / 3));
  const pickerWindow = Math.max(6, Math.min(16, r - 12));
  // Strictly less than the viewport so Ink never classifies the frame as
  // fullscreen and wipes scrollback. Reserve a few rows for the input border
  // and status line which always live in the live region.
  const liveBudget = Math.max(6, r - 3);
  return { columns, rows: r, inputWidth, messageWindow, scrollStep, pickerWindow, liveBudget };
}
