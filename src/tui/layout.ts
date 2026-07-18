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
  return { columns, rows: r, inputWidth, messageWindow, scrollStep, pickerWindow };
}
