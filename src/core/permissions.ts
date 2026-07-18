import type { ToolDef } from "./types.js";

export type PermissionAction = "allow" | "ask" | "deny";

/**
 * User response to a live permission prompt (Claude Code parity).
 * - once: allow this call only
 * - session: don't ask again this session (tool or bash first-token)
 * - always: persist allow rule to settings.json
 * - deny: deny this call only
 * - always_deny: persist deny rule to settings.json
 */
export type PermissionChoice = "once" | "session" | "always" | "deny" | "always_deny";

/** Session-wide modes, analogous to Claude Code permissions.defaultMode. */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface PermissionRequest {
  tool: string;
  detail: string; // bash command or file path
  input?: unknown; // raw tool input, used by the UI to render diffs
}
export type AskFn = (req: PermissionRequest) => Promise<PermissionChoice>;

// Read-only and low-risk self-management tools are always allowed.
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "todo",
  "remember",
  "reload_extensions",
  "background_task", // list/read/kill of jobs the user already authorized via bash
  "web_search",
  "web_fetch",
]);

// Bash commands that never need prompting when they are the leading command.
const BASH_ALLOWED_PREFIXES = ["ls", "pwd", "git status", "git diff", "git log", "cat", "echo"];

const EDIT_TOOLS = new Set(["write", "edit"]);

export function firstToken(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  return command.trim().split(/\s+/)[0] || undefined;
}

// Circuit breaker: rm -rf (any flag order, -r/-f or --recursive/--force) aimed at /, ~ or $HOME.
function isDangerousRm(command: string): boolean {
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const tokens = segment
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0 && t !== "sudo");
    if (tokens[0] !== "rm") continue;
    const flags = tokens.slice(1).filter((t) => t.startsWith("-"));
    const flagChars = flags.join("").toLowerCase();
    const recursive = flagChars.includes("r") || flags.includes("--recursive");
    const force = flagChars.includes("f") || flags.includes("--force");
    if (!recursive || !force) continue;
    for (const target of tokens.slice(1).filter((t) => !t.startsWith("-"))) {
      const norm = target.replace(/["']/g, "").replace(/\/+$/, "");
      if (norm === "" || norm === "~" || norm === "$HOME") return true; // "" == bare "/"
    }
  }
  return false;
}

// Circuit breaker: write/edit aimed at .git internals.
function isGitInternalsPath(path: string): boolean {
  const norm = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return norm === ".git" || norm.startsWith(".git/") || norm.includes("/.git/") || norm.endsWith("/.git");
}

function hasAllowedBashPrefix(command: string): boolean {
  const trimmed = command.trim();
  return BASH_ALLOWED_PREFIXES.some(
    (prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `) || trimmed.startsWith(`${prefix}\t`),
  );
}

export interface PermissionRules {
  allow?: string[];
  deny?: string[];
  /** Claude Code–style mode applied when no more specific rule matches. */
  defaultMode?: PermissionMode;
}

// Glob semantics (deliberately tiny, dependency-free): a pattern is translated
// to an anchored RegExp. "**" always crosses path separators (→ ".*"). A single
// "*" is segment-scoped (→ "[^/]*") when the pattern contains "/", and a free
// wildcard (→ ".*") otherwise — the latter keeps bash rules like "git *"
// convenient, where separator awareness is meaningless. All other characters
// are literal; no "?" or character classes. The whole target must match.
function globToRegExp(pattern: string): RegExp {
  const segmentScoped = pattern.includes("/");
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += segmentScoped ? "[^/]*" : ".*";
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

interface CompiledRule {
  tool: string;
  re: RegExp | null; // null = bare "tool" rule: matches every invocation
}

function compileRule(rule: string): CompiledRule {
  const idx = rule.indexOf(":");
  if (idx < 0) return { tool: rule, re: null };
  return { tool: rule.slice(0, idx), re: globToRegExp(rule.slice(idx + 1)) };
}

// The string a "tool:glob" rule matches against: the full command for bash,
// the path for file tools, the serialized input for everything else.
function ruleTarget(tool: string, input: any): string {
  if (tool === "bash") return String(input?.command ?? "");
  if (typeof input?.path === "string") return input.path;
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

/**
 * Suggest a persistent rule for "always allow/deny this kind of call".
 * Mirrors Claude Code's "Yes, and don't ask again for: curl:*" patterns.
 */
export function suggestPermissionRule(tool: string, input: any): string {
  if (tool === "bash") {
    const tok = firstToken(input?.command);
    return tok ? `bash:${tok} *` : "bash";
  }
  if (typeof input?.path === "string") {
    const p = String(input.path).replace(/\\/g, "/");
    // Directory writes → allow the folder tree; single file → that path.
    if (p.endsWith("/")) return `${tool}:${p}**`;
    const slash = p.lastIndexOf("/");
    if (slash > 0 && EDIT_TOOLS.has(tool)) {
      // e.g. write:src/** so related edits don't re-prompt constantly
      return `${tool}:${p.slice(0, slash + 1)}**`;
    }
    return `${tool}:${p}`;
  }
  return tool;
}

/** Human label for a rule in the UI. */
export function formatRuleLabel(rule: string): string {
  const idx = rule.indexOf(":");
  if (idx < 0) return `${rule} (all)`;
  return `${rule.slice(0, idx)}(${rule.slice(idx + 1)})`;
}

export class PermissionEngine {
  /** Live copy of persistent rules (mutated by always-allow / manager UI). */
  private allowList: string[];
  private denyList: string[];
  private allowRules: CompiledRule[];
  private denyRules: CompiledRule[];
  private headless: boolean;
  private sessionAllows = new Set<string>();
  private sessionDenies = new Set<string>();
  /** Session mode override; falls back to settings defaultMode. */
  private mode: PermissionMode;
  private settingsMode: PermissionMode;

  constructor(rules?: PermissionRules, opts?: { headless?: boolean }) {
    this.allowList = [...(rules?.allow ?? [])];
    this.denyList = [...(rules?.deny ?? [])];
    this.allowRules = this.allowList.map(compileRule);
    this.denyRules = this.denyList.map(compileRule);
    this.headless = opts?.headless ?? false;
    this.settingsMode = rules?.defaultMode ?? "default";
    this.mode = this.settingsMode;
  }

  /** Snapshot for display / persistence. */
  get rules(): Readonly<{ allow: string[]; deny: string[]; defaultMode: PermissionMode }> {
    return { allow: [...this.allowList], deny: [...this.denyList], defaultMode: this.mode };
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  listSessionAllows(): string[] {
    return [...this.sessionAllows].sort();
  }

  listSessionDenies(): string[] {
    return [...this.sessionDenies].sort();
  }

  // "don't ask again this session" — for bash, pattern is the first-token command (e.g. "git").
  rememberSession(tool: string, pattern?: string): void {
    this.sessionAllows.add(pattern ? `${tool}:${pattern}` : tool);
  }

  rememberSessionDeny(tool: string, pattern?: string): void {
    this.sessionDenies.add(pattern ? `${tool}:${pattern}` : tool);
  }

  /** Accept all write/edit for the rest of this session (Claude Code "allow all edits"). */
  acceptEditsThisSession(): void {
    this.sessionAllows.add("write");
    this.sessionAllows.add("edit");
  }

  /**
   * Add a persistent rule. Returns the new rules object suitable for saveSettings.
   * Deny list is cleaned of the same rule if moving to allow (and vice versa).
   */
  addPersistentRule(rule: string, kind: "allow" | "deny"): { allow: string[]; deny: string[]; defaultMode: PermissionMode } {
    if (kind === "allow") {
      this.denyList = this.denyList.filter((r) => r !== rule);
      if (!this.allowList.includes(rule)) this.allowList.push(rule);
    } else {
      this.allowList = this.allowList.filter((r) => r !== rule);
      if (!this.denyList.includes(rule)) this.denyList.push(rule);
    }
    this.recompile();
    return this.rules as { allow: string[]; deny: string[]; defaultMode: PermissionMode };
  }

  removePersistentRule(rule: string, kind: "allow" | "deny"): { allow: string[]; deny: string[]; defaultMode: PermissionMode } {
    if (kind === "allow") this.allowList = this.allowList.filter((r) => r !== rule);
    else this.denyList = this.denyList.filter((r) => r !== rule);
    this.recompile();
    return this.rules as { allow: string[]; deny: string[]; defaultMode: PermissionMode };
  }

  private recompile(): void {
    this.allowRules = this.allowList.map(compileRule);
    this.denyRules = this.denyList.map(compileRule);
  }

  private matchesAny(compiled: CompiledRule[], tool: string, target: string): boolean {
    return compiled.some((r) => r.tool === tool && (r.re === null || r.re.test(target)));
  }

  private sessionKey(tool: string, input: any): { toolKey: string; patternKey?: string } {
    if (tool === "bash") {
      const cmd = firstToken(input?.command);
      return { toolKey: "bash", patternKey: cmd ? `bash:${cmd}` : undefined };
    }
    return { toolKey: tool };
  }

  check(tool: string, input: any): PermissionAction {
    // 1. Hard circuit breakers — no override (beats rules, session allows, headless, bypass).
    if (tool === "bash" && typeof input?.command === "string" && isDangerousRm(input.command)) return "deny";
    if ((tool === "write" || tool === "edit") && typeof input?.path === "string" && isGitInternalsPath(input.path)) {
      return "deny";
    }
    // 2. Persistent deny rules — beat session remembers and allow rules.
    const target = this.denyRules.length > 0 || this.allowRules.length > 0 ? ruleTarget(tool, input) : "";
    if (this.matchesAny(this.denyRules, tool, target)) return "deny";

    // 3. Session denies.
    const sk = this.sessionKey(tool, input);
    if (this.sessionDenies.has(sk.toolKey) || (sk.patternKey && this.sessionDenies.has(sk.patternKey))) {
      return "deny";
    }

    // 4. Mode shortcuts (Claude Code defaultMode).
    if (this.mode === "bypassPermissions") return "allow";
    if (this.mode === "acceptEdits" && EDIT_TOOLS.has(tool)) return "allow";

    // 5. Session-remembered allows.
    if (tool === "bash") {
      const cmd = firstToken(input?.command);
      if (this.sessionAllows.has("bash") || (cmd !== undefined && this.sessionAllows.has(`bash:${cmd}`))) {
        return "allow";
      }
    } else if (this.sessionAllows.has(tool)) {
      return "allow";
    }
    // 6. Persistent allow rules.
    if (this.matchesAny(this.allowRules, tool, target)) return "allow";
    // 7. Read-only tools.
    if (READ_ONLY_TOOLS.has(tool)) return "allow";
    // 8. Seeded safe bash prefixes.
    if (tool === "bash" && typeof input?.command === "string" && hasAllowedBashPrefix(input.command)) return "allow";
    // 9. Everything else: headless runs can't prompt, so they allow (deny rules above still bite).
    return this.headless ? "allow" : "ask";
  }
}

export function permissionDetail(tool: string, input: any): string {
  if (tool === "bash") return String(input?.command ?? "");
  if (typeof input?.path === "string") return input.path;
  try {
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return String(input);
  }
}

export interface WrapPermissionsOpts {
  /** Called after a persistent rule is added so the host can write settings.json. */
  onPersist?: (rules: { allow: string[]; deny: string[]; defaultMode: PermissionMode }) => void;
}

export function wrapToolsWithPermissions(
  tools: ToolDef[],
  engine: PermissionEngine,
  ask: AskFn,
  opts?: WrapPermissionsOpts,
): ToolDef[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (id, input, signal) => {
      const action = engine.check(tool.name, input);
      if (action === "deny") return { content: "Permission denied by user", is_error: true };
      if (action === "ask") {
        const choice = await ask({ tool: tool.name, detail: permissionDetail(tool.name, input), input });
        if (choice === "deny") return { content: "Permission denied by user", is_error: true };
        if (choice === "always_deny") {
          const rule = suggestPermissionRule(tool.name, input);
          const snap = engine.addPersistentRule(rule, "deny");
          opts?.onPersist?.(snap);
          return { content: "Permission denied by user", is_error: true };
        }
        if (choice === "session") {
          // acceptEdits-this-session is applied by the UI before resolving "session"
          // for write/edit; still remember the single tool for bash / other tools.
          if (tool.name === "bash") {
            engine.rememberSession("bash", firstToken(input?.command));
          } else if (!EDIT_TOOLS.has(tool.name) || !engine.listSessionAllows().includes("write")) {
            engine.rememberSession(tool.name);
          }
        }
        if (choice === "always") {
          const rule = suggestPermissionRule(tool.name, input);
          const snap = engine.addPersistentRule(rule, "allow");
          opts?.onPersist?.(snap);
        }
        // "once" — fall through with no remember
      }
      return tool.execute(id, input, signal);
    },
  }));
}
