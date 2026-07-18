import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const FILE_CAP = 100 * 1024;
const MAX_CANDIDATES = 5000;

/**
 * Expand `@path` mentions into inline file content for the model.
 * Unresolved tokens are left as-is. Paths may be relative to cwd or absolute.
 */
export async function expandMentions(text: string, cwd: string = process.cwd()): Promise<string> {
  // Match @path tokens: @./foo, @src/x.ts, @D:\a\b, @"path with spaces"
  // Avoid email-like user@host and plain @mentions without path chars when followed by space-only.
  const re = /@(?:"([^"]+)"|([A-Za-z]:[\\/][^\s]+|(?:\.\.?[\\/]|[\\/])?[^\s@]+))/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(last, m.index);
    const raw = (m[1] ?? m[2] ?? "").trim();
    last = m.index + m[0].length;
    if (!raw || raw.includes("://")) {
      out += m[0];
      continue;
    }
    // Skip bare words that look like social mentions (no slash, no extension, no drive)
    if (!/[\\/]/.test(raw) && !/\.\w{1,8}$/.test(raw) && !/^[A-Za-z]:/.test(raw)) {
      out += m[0];
      continue;
    }
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
    if (!existsSync(abs)) {
      out += m[0];
      continue;
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      out += m[0];
      continue;
    }
    if (!st.isFile()) {
      out += m[0];
      continue;
    }
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      out += m[0];
      continue;
    }
    let note = "";
    if (content.length > FILE_CAP) {
      note = `\n…[truncated to ${FILE_CAP} of ${content.length} bytes]`;
      content = content.slice(0, FILE_CAP);
    }
    const display = relative(cwd, abs).replace(/\\/g, "/") || abs.replace(/\\/g, "/");
    out += `<file path="${display}">\n${content}${note}\n</file>`;
  }
  out += text.slice(last);
  return out;
}

/** Flat list of project files for @ completion (excludes .git / node_modules). */
export async function listFileCandidates(cwd: string = process.cwd()): Promise<string[]> {
  const out: string[] = [];
  try {
    const glob = new Bun.Glob("**/*");
    for await (const p of glob.scan({ cwd, onlyFiles: true, followSymlinks: false })) {
      const norm = p.replace(/\\/g, "/");
      if (norm.startsWith(".git/") || norm.includes("/.git/")) continue;
      if (norm.startsWith("node_modules/") || norm.includes("/node_modules/")) continue;
      if (norm.startsWith("dist/") || norm.includes("/dist/")) continue;
      out.push(norm);
      if (out.length >= MAX_CANDIDATES) break;
    }
  } catch {
    return [];
  }
  return out;
}
