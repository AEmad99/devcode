import { readFileSync, writeFileSync } from "node:fs";
import type { HooksConfig } from "./hooks.js";
import { settingsPath } from "./paths.js";
import type { ThinkingLevel } from "./thinking.js";

export interface Settings {
  provider?: string;
  model?: string;
  trustedProjects?: string[];
  /** Theme id: claude | dev | dusk | ember | mono | forest */
  theme?: string;
  thinking?: ThinkingLevel;
  /**
   * Persistent permission rules. Each rule is "tool" (matches every invocation
   * of that tool) or "tool:glob" (glob matched against the bash command, the
   * file path, or JSON.stringify(input) for other tools). Deny wins over allow.
   * defaultMode mirrors Claude Code: default | acceptEdits | bypassPermissions.
   */
  permissions?: {
    allow?: string[];
    deny?: string[];
    defaultMode?: "default" | "acceptEdits" | "bypassPermissions";
  };
  /**
   * Declarative shell hooks (no TypeScript extension required).
   * See core/hooks.ts for the shape and env vars.
   */
  hooks?: HooksConfig;
}

export function loadSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8")) as Settings;
  } catch {
    return {};
  }
}

export function saveSettings(patch: Settings): void {
  const next = { ...loadSettings(), ...patch };
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
}

/** Remember the active provider + model pair (both keys always written together). */
export function rememberChoice(provider: string, model: string): void {
  if (!provider || provider === "fake") return;
  if (!model) return;
  saveSettings({ provider, model });
}
