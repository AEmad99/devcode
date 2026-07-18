// Terminal themes. Default = Dev family cyan (not third-party brand colors).
// Prefer bright ANSI names for readability on dark terminals (DevTerm, Windows Terminal).

export type ThemeId = "dev" | "dusk" | "ember" | "mono" | "forest" | "claude";

export interface Theme {
  id: ThemeId;
  name: string;
  description: string;
  accent: string;
  accentDim: string;
  highlight: string;
  success: string;
  warn: string;
  error: string;
  thinking: string;
  border: string;
  user: string;
  assistant?: string;
  /** Secondary body text — should stay readable (avoid pure gray/dim) */
  muted: string;
  /** Primary body / labels */
  text: string;
  statusBg: string;
  statusFg: string;
}

export const THEMES: Record<ThemeId, Theme> = {
  dev: {
    id: "dev",
    name: "Dev",
    description: "Cyan — Dev family default",
    accent: "cyanBright",
    accentDim: "cyan",
    highlight: "white",
    success: "greenBright",
    warn: "yellowBright",
    error: "redBright",
    thinking: "cyan",
    border: "cyan",
    user: "cyanBright",
    text: "white",
    muted: "gray",
    statusBg: "cyan",
    statusFg: "black",
  },
  dusk: {
    id: "dusk",
    name: "Dusk",
    description: "Violet — DevWhisp sibling",
    accent: "magentaBright",
    accentDim: "magenta",
    highlight: "white",
    success: "greenBright",
    warn: "yellowBright",
    error: "redBright",
    thinking: "white",
    border: "magenta",
    user: "magentaBright",
    text: "white",
    muted: "white",
    statusBg: "magenta",
    statusFg: "black",
  },
  ember: {
    id: "ember",
    name: "Ember",
    description: "Warm amber",
    accent: "yellowBright",
    accentDim: "yellow",
    highlight: "white",
    success: "greenBright",
    warn: "yellowBright",
    error: "redBright",
    thinking: "white",
    border: "yellow",
    user: "yellowBright",
    text: "white",
    muted: "white",
    statusBg: "yellow",
    statusFg: "black",
  },
  mono: {
    id: "mono",
    name: "Mono",
    description: "High-contrast grayscale",
    accent: "white",
    accentDim: "white",
    highlight: "white",
    success: "white",
    warn: "white",
    error: "white",
    thinking: "white",
    border: "white",
    user: "white",
    text: "white",
    muted: "white",
    statusBg: "white",
    statusFg: "black",
  },
  forest: {
    id: "forest",
    name: "Forest",
    description: "Green terminal classic",
    accent: "greenBright",
    accentDim: "green",
    highlight: "white",
    success: "greenBright",
    warn: "yellowBright",
    error: "redBright",
    thinking: "white",
    border: "green",
    user: "greenBright",
    text: "white",
    muted: "white",
    statusBg: "green",
    statusFg: "black",
  },
  claude: {
    id: "claude",
    name: "Claude",
    description: "Warm coral accent (optional)",
    accent: "yellowBright",
    accentDim: "yellow",
    highlight: "white",
    success: "greenBright",
    warn: "yellowBright",
    error: "redBright",
    thinking: "white",
    border: "yellow",
    user: "yellowBright",
    text: "white",
    muted: "white",
    statusBg: "yellow",
    statusFg: "black",
  },
};

export const THEME_IDS = Object.keys(THEMES) as ThemeId[];

export function resolveTheme(id?: string): Theme {
  if (id && id in THEMES) return THEMES[id as ThemeId];
  return THEMES.dev; // Dev family cyan — not a third-party brand default
}
