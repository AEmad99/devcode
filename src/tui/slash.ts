import { fuzzyScore } from "./fuzzy.js";

export { fuzzyScore } from "./fuzzy.js";

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "List available commands" },
  { name: "clear", description: "Clear conversation history" },
  { name: "compact", description: "Compact context now" },
  { name: "cost", description: "Show cumulative usage and cost" },
  { name: "limits", description: "Show context window + rate-limit hints for current provider" },
  { name: "permissions", description: "Manage permission modes and allow/deny rules" },
  { name: "resume", description: "Pick a previous session to resume" },
  { name: "name", description: "Name this session (/name <label>)" },
  { name: "export", description: "Export session to markdown (/export [path])" },
  { name: "memory", description: "Show persistent memory (/memory clear [global|project|all])" },
  { name: "model", description: "Open model picker (or /model <id>)" },
  { name: "provider", description: "Open provider picker (or /provider <id>)" },
  { name: "thinking", description: "Show/set thinking level (off|low|medium|high|max)" },
  { name: "theme", description: "Show/set UI theme" },
  { name: "login", description: "Log in to a provider (OAuth or API key)" },
  { name: "logout", description: "Log out of a provider" },
  { name: "reload", description: "Reload extensions" },
  { name: "version", description: "Show installed DevCode version" },
  { name: "update", description: "Check GitHub for a newer DevCode release" },
  { name: "exit", description: "Quit DevCode" },
];

export function parseSlash(input: string): { cmd: string; args: string } | null {
  if (!input.startsWith("/")) return null;
  const m = /^\/(\S+)(?:\s+(.*))?$/.exec(input.trim());
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

export interface RankedSlash {
  cmd: SlashCommand;
  score: number;
}

/** Rank slash commands by fuzzy similarity; returns best-first, score > 0 only. */
export function rankSlashCommands(query: string, commands: SlashCommand[], limit = 12): RankedSlash[] {
  const q = query.toLowerCase().replace(/^\//, "");
  const ranked: RankedSlash[] = [];
  for (const cmd of commands) {
    const byName = fuzzyScore(q, cmd.name);
    const byDesc = Math.floor(fuzzyScore(q, cmd.description) * 0.35);
    const score = Math.max(byName, byDesc);
    if (score > 0 || !q) ranked.push({ cmd, score: score || 1 });
  }
  ranked.sort((a, b) => b.score - a.score || a.cmd.name.localeCompare(b.cmd.name));
  return ranked.slice(0, limit);
}

/** @deprecated prefer rankSlashCommands — kept for prefix-only callers */
export function matchSlashCommands(prefix: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  return rankSlashCommands(prefix, commands).map((r) => r.cmd);
}

export function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}
