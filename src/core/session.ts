import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir } from "./paths.js";
import type { Message } from "./types.js";

export interface SessionMeta {
  v: 1;
  type: "meta";
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  /** Optional human-readable name set via /name or --name. */
  name?: string;
}

export interface SessionWriter {
  id: string;
  path: string;
  append(message: Message): void;
  markCleared(): void;
  /** Update the meta line name (rewrites file head). */
  setName?(name: string): void;
}

export interface SessionInfo {
  id: string;
  path: string;
  createdAt: string;
  messageCount: number;
  preview: string; // first user text, 80 chars
  name?: string;
}

// "D:/projects/DevCode" -> "D-projects-DevCode"
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "root";
}

function rewriteMetaName(path: string, name: string): void {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  if (lines.length === 0) return;
  try {
    const meta = JSON.parse(lines[0]) as SessionMeta;
    if (meta.type !== "meta") return;
    meta.name = name;
    lines[0] = JSON.stringify(meta);
    writeFileSync(path, lines.join("\n"), "utf8");
  } catch {
    /* leave file alone */
  }
}

function makeWriter(path: string, id: string): SessionWriter {
  return {
    id,
    path,
    append(message: Message): void {
      appendFileSync(path, `${JSON.stringify({ type: "message", message })}\n`, "utf8");
    },
    markCleared(): void {
      appendFileSync(path, `${JSON.stringify({ type: "cleared" })}\n`, "utf8");
    },
    setName(name: string): void {
      rewriteMetaName(path, name);
    },
  };
}

export function createSession(cwd: string, model: string, id?: string, name?: string): SessionWriter {
  const sessionId = id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(sessionsDir(), projectSlug(cwd));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const meta: SessionMeta = {
    v: 1,
    type: "meta",
    id: sessionId,
    cwd,
    model,
    createdAt: new Date().toISOString(),
    ...(name?.trim() ? { name: name.trim() } : {}),
  };
  writeFileSync(path, `${JSON.stringify(meta)}\n`, "utf8");
  return makeWriter(path, sessionId);
}

// Append to an existing session file (resume): no meta rewrite, messages preserved.
export function openSessionWriter(path: string, id: string): SessionWriter {
  return makeWriter(path, id);
}

/** Rename a session (updates meta.name). */
export function renameSession(path: string, name: string): void {
  rewriteMetaName(path, name.trim());
}

/**
 * Export a session to markdown (human-readable transcript).
 * Returns the written absolute path.
 */
export function exportSessionMarkdown(sessionPath: string, outPath?: string): string {
  const { meta, messages } = (() => {
    // sync load
    const lines = readFileSync(sessionPath, "utf8").split("\n").filter(Boolean);
    let meta: SessionMeta | null = null;
    const messages: Message[] = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.type === "meta") meta = rec;
        else if (rec.type === "cleared") messages.length = 0;
        else if (rec.type === "message") messages.push(rec.message as Message);
      } catch {
        /* skip */
      }
    }
    if (!meta) throw new Error(`Not a DevCode session file: ${sessionPath}`);
    return { meta, messages };
  })();

  const lines: string[] = [
    `# Session ${meta.name ? `${meta.name} (${meta.id})` : meta.id}`,
    "",
    `- cwd: \`${meta.cwd}\``,
    `- model: \`${meta.model}\``,
    `- created: ${meta.createdAt}`,
    "",
  ];
  for (const m of messages) {
    lines.push(`## ${m.role}`);
    for (const b of m.content) {
      if (b.type === "text") lines.push(b.text, "");
      else if (b.type === "tool_use") {
        lines.push(`\`\`\`tool ${b.name}`, JSON.stringify(b.input, null, 2), "```", "");
      } else if (b.type === "tool_result") {
        lines.push(
          `\`\`\`result${b.is_error ? " error" : ""}`,
          b.content.slice(0, 4000),
          "```",
          "",
        );
      }
    }
  }
  const dest =
    outPath ??
    join(sessionsDir(), projectSlug(meta.cwd), `${meta.id}${meta.name ? `-${meta.name.replace(/[^a-zA-Z0-9_-]/g, "_")}` : ""}.md`);
  writeFileSync(dest, lines.join("\n"), "utf8");
  return dest;
}

function parseSessionLine(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null; // truncated/corrupt line (e.g. mid-write kill)
  }
}

export async function listSessions(cwd: string): Promise<SessionInfo[]> {
  const dir = join(sessionsDir(), projectSlug(cwd));
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const file of files) {
    try {
      const path = join(dir, file);
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      let meta: SessionMeta | null = null;
      let messageCount = 0;
      let preview = "";
      for (const line of lines) {
        const rec = parseSessionLine(line);
        if (!rec) continue;
        if (rec.type === "meta" && !meta) meta = rec;
        else if (rec.type === "message") {
          messageCount++;
          if (!preview && rec.message?.role === "user") {
            const text = (rec.message.content ?? []).find((b: any) => b?.type === "text")?.text;
            if (typeof text === "string") preview = text.slice(0, 80);
          }
        }
      }
      if (meta) {
        out.push({
          id: meta.id,
          path,
          createdAt: meta.createdAt,
          messageCount,
          preview,
          name: meta.name,
        });
      }
    } catch {
      // skip unreadable / junk files
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

export async function loadSession(path: string): Promise<{ meta: SessionMeta; messages: Message[] }> {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  let meta: SessionMeta | null = null;
  const messages: Message[] = [];
  for (const line of lines) {
    const rec = parseSessionLine(line);
    if (!rec) continue; // skip truncated last line after a kill
    if (rec.type === "meta") meta = rec;
    else if (rec.type === "cleared") messages.length = 0; // /clear drops earlier history for future readers
    else if (rec.type === "message") messages.push(rec.message as Message);
  }
  if (!meta) throw new Error(`Not a DevCode session file: ${path}`);
  return { meta, messages };
}

// Resolve a --resume prefix against this project's sessions.
export async function resolveSession(
  cwd: string,
  prefix: string,
): Promise<{ info?: SessionInfo; error?: string }> {
  const matches = (await listSessions(cwd)).filter((s) => s.id.startsWith(prefix));
  if (matches.length === 0) return { error: `No session matches "${prefix}" for ${cwd}` };
  if (matches.length > 1) {
    const candidates = matches.map((m) => `${m.id} (${m.createdAt}, ${m.messageCount} messages)`).join("\n  ");
    return { error: `Ambiguous session prefix "${prefix}". Candidates:\n  ${candidates}` };
  }
  return { info: matches[0] };
}
