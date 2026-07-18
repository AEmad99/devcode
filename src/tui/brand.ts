// DevCode brand — CLI wordmark in the filled-block style used by Claude Code / Gemini CLI.
// (Solid █ letterforms, not outline ASCII and not abstract glyphs.)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BRAND = {
  id: "devcode",
  name: "DevCode",
  tagline: "minimal coding agent",
  accent: "cyan" as const,
};

/**
 * Filled block wordmark — same density/style as Claude Code CLI banners.
 * Generated with the "block" filled font (█ + box edges), spelling DEVCODE.
 */
export const LOGO_WORDMARK = [
  " ██████╗  ███████╗ ██╗   ██╗  ██████╗  ██████╗  ██████╗  ███████╗",
  " ██╔══██╗ ██╔════╝ ██║   ██║ ██╔════╝ ██╔═══██╗ ██╔══██╗ ██╔════╝",
  " ██║  ██║ █████╗   ██║   ██║ ██║      ██║   ██║ ██║  ██║ █████╗  ",
  " ██║  ██║ ██╔══╝   ╚██╗ ██╔╝ ██║      ██║   ██║ ██║  ██║ ██╔══╝  ",
  " ██████╔╝ ███████╗  ╚████╔╝  ╚██████╗ ╚██████╔╝ ██████╔╝ ███████╗",
  " ╚═════╝  ╚══════╝   ╚═══╝    ╚═════╝  ╚═════╝  ╚═════╝  ╚══════╝",
] as const;

const FALLBACK_VERSION = "0.1.0";
let cachedVersion: string | undefined;

export function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, "..", "..", "package.json"),
    join(moduleDir, "..", "package.json"),
    join(process.cwd(), "package.json"),
    join(dirname(process.execPath), "package.json"),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version) {
        return (cachedVersion = pkg.version);
      }
    } catch {
      // try next
    }
  }
  return (cachedVersion = FALLBACK_VERSION);
}
