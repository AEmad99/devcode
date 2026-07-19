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
  accent: "cyan",
} as Theme;

/**
 * Phase-icon table — every tool/op gets a glyph + verb label so the transcript
 * reads as a sequence of distinguishable phases rather than a wall of text.
 *
 *   read          ⤓   read   (passive — file into the agent)
 *   write         ↳   write  (active  — file out of the agent)
 *   edit          ✎   edit   (active  — in-place mutation)
 *   bash          $   bash   (active  — shell execution)
 *   grep          ⌕   grep   (passive — search)
 *   glob          *   glob   (passive — file listing)
 *   todo          ☑   todo   (passive — checklist view)
 *   remember      ◐   memory (passive — persistent state)
 *   reload        ↻   reload (active  — runtime mutation)
 *   background    ⏳   bg     (passive — async task)
 *   web_search    ◌   search (passive — web query)
 *   web_fetch     ⤓   fetch  (passive — web read)
 *   task:*        ⊟   task   (passive — subagent)
 *   mcp_*         ⌬   mcp    (active  — external server call)
 *   default       ▸   generic
 *
 * Status overlays: ● in warn (running), ✓ in success (ok), ✗ in error (failed).
 */
const PHASE_ICON: Record<string, { glyph: string; verb: string; phase: "read" | "write" | "operate" | "think" }> = {
  read: { glyph: "⤓", verb: "read", phase: "read" },
  write: { glyph: "↳", verb: "write", phase: "write" },
  edit: { glyph: "✎", verb: "edit", phase: "write" },
  bash: { glyph: "$", verb: "bash", phase: "operate" },
  grep: { glyph: "⌕", verb: "grep", phase: "read" },
  glob: { glyph: "*", verb: "glob", phase: "read" },
  todo: { glyph: "☑", verb: "todo", phase: "read" },
  remember: { glyph: "◐", verb: "memory", phase: "read" },
  reload_extensions: { glyph: "↻", verb: "reload", phase: "operate" },
  background_task: { glyph: "⏳", verb: "bg", phase: "read" },
  web_search: { glyph: "◌", verb: "search", phase: "read" },
  web_fetch: { glyph: "⤓", verb: "fetch", phase: "read" },
};

function phaseFor(name: string): { glyph: string; verb: string; phase: "read" | "write" | "operate" | "think" } {
  // task labels come through as "task:<label>/<tool>"; treat the whole run as a read-phase subagent.
  if (name.startsWith("task:") || name === "task") return { glyph: "⊟", verb: "task", phase: "read" };
  if (name.startsWith("mcp_")) return { glyph: "⌬", verb: "mcp", phase: "operate" };
  return PHASE_ICON[name] ?? { glyph: "▸", verb: name, phase: "operate" };
}

function phaseAccent(theme: Theme, phase: "read" | "write" | "operate" | "think"): string {
  // Three distinct hues so reads, writes, and operations never blur together.
  switch (phase) {
    case "read":
      return theme.accent; // cyan / theme accent
    case "write":
      return theme.warn; // amber / theme warning hue
    case "operate":
      return theme.highlight; // white
    case "think":
      return theme.thinking;
  }
}

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

  const phase = phaseFor(name);
  const phaseColor = phaseAccent(t, phase.phase);

  // Status glyph on the left rail: ● running / ✓ ok / ✗ failed.
  // Failed bumps the phase color toward error so the failure mode reads at a glance.
  const statusGlyph = !done ? (
    <Text color={t.warn}>●</Text>
  ) : failed ? (
    <Text color={t.error}>✗</Text>
  ) : (
    <Text color={t.success}>✓</Text>
  );

  // Phase glyph next to the verb label (kept short — wide glyphs break line wrap on narrow terminals).
  const phaseGlyph = <Text color={phaseColor}>{phase.glyph}</Text>;

  // Verb label colored by phase so write-/edit-/bash phases don't all read as "highlight white".
  const verb = (
    <Text bold color={phaseColor}>
      {phase.verb}
    </Text>
  );

  const isRead = name === "read";
  const isWrite = name === "write";
  const isEdit = name === "edit";
  const filePath = typeof inp.path === "string" ? inp.path : "";

  return (
    <Box flexDirection="column">
      {/* Header line: [status] [phase-glyph] [verb]   [preview…] */}
      <Text>
        {statusGlyph} {phaseGlyph} {verb}
        {preview ? (
          <>
            <Text color={t.muted}>{"  "}</Text>
            <Text color={failed ? t.error : t.accentDim ?? t.muted}>{preview}</Text>
          </>
        ) : null}
        {!done ? <Text color={t.warn}> …</Text> : null}
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

      {/* Bash output: distinct from grep/glob dump — a thin "output" header so
          the transcript reads as "command $ result" rather than a bare wall. */}
      {name === "bash" && done && result && !failed ? (
        <Box marginLeft={2} flexDirection="column">
          <Text color={t.muted}>{"  · output"}</Text>
          <GenericResultView result={result} theme={t} maxLines={20} />
        </Box>
      ) : null}

      {/* Everything else (grep, glob, todo, …) */}
      {!isRead && !isWrite && !isEdit && name !== "bash" && done && result ? (
        <GenericResultView result={result} theme={t} maxLines={12} />
      ) : null}
    </Box>
  );
}
