import React from "react";
import { Box, Text } from "ink";
import { homedir } from "node:os";
import { relative, isAbsolute } from "node:path";
import type { ToolResult } from "../../core/types.js";
import type { Theme } from "../theme.js";
import { DiffView } from "./DiffView.js";

/** Short display path: relative to cwd when possible, ~ for home, forward slashes. */
export function shortPath(p: string, cwd = process.cwd()): string {
  if (!p) return p;
  let out = p.replace(/\\/g, "/");
  const cwdN = cwd.replace(/\\/g, "/");
  const home = homedir().replace(/\\/g, "/");
  try {
    if (isAbsolute(p)) {
      const rel = relative(cwd, p).replace(/\\/g, "/");
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) out = rel;
      else if (home && out.toLowerCase().startsWith(home.toLowerCase())) {
        out = `~${out.slice(home.length)}`;
      }
    }
  } catch {
    // keep out
  }
  // collapse long middle of deep paths: a/b/c/d/e/f.ts → a/b/…/e/f.ts
  const parts = out.split("/");
  if (parts.length > 5) {
    out = `${parts[0]}/${parts[1]}/…/${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return out || p;
}

function previewFor(name: string, input: unknown, partialJson?: string): string {
  if ((input === null || input === undefined) && partialJson) {
    return partialJson.replace(/\s+/g, " ").slice(0, 90);
  }
  const inp = (input ?? {}) as Record<string, unknown>;
  if (name === "bash" || name.endsWith("/bash")) return String(inp.command ?? "").replace(/\s+/g, " ").slice(0, 90);
  const base = name.includes("/") ? name.split("/").pop()! : name;
  if (base === "read" || base === "write" || base === "edit" || base === "glob") {
    return shortPath(String(inp.path ?? inp.pattern ?? ""));
  }
  if (base === "grep") {
    const pat = String(inp.pattern ?? "");
    const path = inp.path ? shortPath(String(inp.path)) : "";
    return path ? `${pat}  in ${path}` : pat;
  }
  try {
    return (JSON.stringify(input) ?? "").replace(/\s+/g, " ").slice(0, 90);
  } catch {
    return "";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Parse read-tool output: `N\\tline` rows + optional truncation footer. */
function parseReadLines(content: string): { rows: { n: number; text: string }[]; footer?: string } {
  const rows: { n: number; text: string }[] = [];
  let footer: string | undefined;
  for (const line of content.split("\n")) {
    if (line.startsWith("[truncated:") || line.startsWith("[+") || line.startsWith("[…")) {
      footer = line.replace(/^\[|\]$/g, "");
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab > 0 && /^\d+$/.test(line.slice(0, tab))) {
      rows.push({ n: Number(line.slice(0, tab)), text: line.slice(tab + 1) });
    } else if (line.length > 0) {
      rows.push({ n: 0, text: line });
    }
  }
  return { rows, footer };
}

function ReadResultView({ content, theme, maxLines = 18 }: { content: string; theme: Theme; maxLines?: number }) {
  const { rows, footer } = parseReadLines(content);
  if (rows.length === 0) {
    return (
      <Box marginLeft={2}>
        <Text color={theme.muted}>(empty)</Text>
      </Box>
    );
  }
  const shown = rows.slice(0, maxLines);
  const more = rows.length - shown.length;
  const width = String(shown[shown.length - 1]?.n || shown.length).length;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((row, i) => (
        <Text key={i}>
          <Text color={theme.muted}>
            {row.n > 0 ? String(row.n).padStart(width, " ") : " ".repeat(width)}
            {" │ "}
          </Text>
          <Text color={theme.text}>{row.text || " "}</Text>
        </Text>
      ))}
      {more > 0 ? (
        <Text color={theme.muted}>
          {"  · "}… {more} more line{more === 1 ? "" : "s"}
          {footer ? ` (${footer})` : ""}
        </Text>
      ) : footer ? (
        <Text color={theme.muted}>
          {"  · "}
          {footer}
        </Text>
      ) : null}
    </Box>
  );
}

function GenericResultView({ result, theme, maxLines = 12 }: { result: ToolResult; theme: Theme; maxLines?: number }) {
  if (!result.content) return null;
  const lines = result.content.split("\n");
  // drop trailing empty
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const shown = lines.slice(0, maxLines);
  const more = lines.length - shown.length;
  const color = result.is_error ? theme.error : theme.text;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((line, i) => (
        <Text key={i} color={color}>
          {line || " "}
        </Text>
      ))}
      {more > 0 ? (
        <Text color={theme.muted}>
          {"  · "}… {more} more line{more === 1 ? "" : "s"}
        </Text>
      ) : null}
    </Box>
  );
}

function WriteSummary({ content, path, theme }: { content: string; path: string; theme: Theme }) {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const bytes = Buffer.byteLength(content, "utf8");
  return (
    <Box marginLeft={2}>
      <Text color={theme.muted}>
        {"  · wrote "}
        {lines.length} line{lines.length === 1 ? "" : "s"}
        {` (${formatBytes(bytes)}) → `}
        <Text color={theme.highlight}>{shortPath(path)}</Text>
      </Text>
    </Box>
  );
}

function EditSummary({ result, theme }: { result?: ToolResult; theme: Theme }) {
  if (!result?.content || result.is_error) return null;
  // "Edited path: replaced N occurrence(s)"
  const m = /replaced (\d+)/i.exec(result.content);
  const n = m ? m[1] : null;
  return (
    <Box marginLeft={2}>
      <Text color={theme.muted}>
        {"  · "}
        {n ? `replaced ${n} occurrence${n === "1" ? "" : "s"}` : result.content}
      </Text>
    </Box>
  );
}

const FALLBACK_THEME = {
  error: "red",
  muted: "gray",
  text: "white",
  success: "green",
  highlight: "white",
  accentDim: "cyan",
  warn: "yellow",
} as Theme;

export function ToolBlock({
  name,
  input,
  status,
  result,
  theme,
  partialJson,
}: {
  name: string;
  input: unknown;
  status: "running" | "done";
  result?: ToolResult;
  theme?: Theme;
  partialJson?: string;
}) {
  const t = theme ?? FALLBACK_THEME;
  const inp = (input ?? {}) as Record<string, unknown>;
  const preview = previewFor(name, input, partialJson);
  const done = status === "done";
  const failed = done && !!result?.is_error;

  const icon = !done ? (
    <Text color={t.warn}>●</Text>
  ) : failed ? (
    <Text color={t.error}>✗</Text>
  ) : (
    <Text color={t.success}>✓</Text>
  );

  // Friendly verb labels
  const label =
    name === "read"
      ? "read"
      : name === "write"
        ? "write"
        : name === "edit"
          ? "edit"
          : name === "bash"
            ? "bash"
            : name;

  const isRead = name === "read";
  const isWrite = name === "write";
  const isEdit = name === "edit";
  const filePath = typeof inp.path === "string" ? inp.path : "";

  return (
    <Box flexDirection="column">
      <Text>
        {icon}{" "}
        <Text bold color={t.highlight}>
          {label}
        </Text>
        {preview ? (
          <>
            <Text color={t.muted}>{"  "}</Text>
            <Text color={failed ? t.error : t.accentDim ?? t.muted}>{preview}</Text>
          </>
        ) : null}
        {!done ? (
          <Text color={t.warn}> …</Text>
        ) : null}
      </Text>

      {/* Write: clean create preview (no @@ headers) + compact summary */}
      {isWrite && typeof inp.content === "string" ? (
        <>
          <DiffView oldText="" newText={inp.content} create theme={t} maxLines={24} />
          {done && !failed ? <WriteSummary content={inp.content} path={filePath} theme={t} /> : null}
          {done && failed && result ? <GenericResultView result={result} theme={t} /> : null}
        </>
      ) : null}

      {/* Edit: soft diff + one-line summary (skip raw result dump) */}
      {isEdit && typeof inp.old_string === "string" && typeof inp.new_string === "string" ? (
        <>
          <DiffView oldText={inp.old_string} newText={inp.new_string} theme={t} maxLines={30} />
          {done && !failed ? <EditSummary result={result} theme={t} /> : null}
          {done && failed && result ? <GenericResultView result={result} theme={t} /> : null}
        </>
      ) : null}

      {/* Read: numbered gutter, readable body */}
      {isRead && done && result && !result.is_error ? (
        <ReadResultView content={result.content} theme={t} />
      ) : null}
      {isRead && done && result?.is_error ? <GenericResultView result={result} theme={t} /> : null}

      {/* Everything else (bash, grep, glob, todo, …) */}
      {!isRead && !isWrite && !isEdit && done && result ? (
        <GenericResultView result={result} theme={t} maxLines={name === "bash" ? 20 : 12} />
      ) : null}
    </Box>
  );
}
