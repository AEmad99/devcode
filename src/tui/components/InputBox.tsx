import React, { memo, useCallback, useRef, useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { rankByFuzzy } from "../fuzzy.js";
import { longestCommonPrefix, rankSlashCommands, type SlashCommand } from "../slash.js";
import type { Theme } from "../theme.js";
import { THEMES } from "../theme.js";

/** Token under cursor starting with @ (for file mention completion). */
function atTokenAtCursor(value: string, cursor: number): { start: number; query: string } | null {
  let i = cursor - 1;
  while (i >= 0 && !/\s/.test(value[i])) i--;
  const start = i + 1;
  if (value[start] !== "@") return null;
  const query = value.slice(start + 1, cursor);
  if (query.includes("@")) return null;
  return { start, query };
}

interface Buffer {
  value: string;
  cursor: number;
}

const lineStart = (v: string, c: number): number => v.lastIndexOf("\n", c - 1) + 1;
const lineEnd = (v: string, c: number): number => {
  const i = v.indexOf("\n", c);
  return i === -1 ? v.length : i;
};

/**
 * Minimal, stable input rendering.
 * No per-keystroke syntax tokenization (that corrupted spaces and lagged the TUI).
 * Only slash-command prefix gets a soft accent.
 */
function renderLine(line: string, theme: Theme, cursorCol: number | null): React.ReactNode {
  const isSlash = line.startsWith("/");
  const space = line.indexOf(" ");
  const cmdEnd = isSlash ? (space < 0 ? line.length : space) : 0;

  if (cursorCol === null) {
    if (!isSlash) return <Text color={theme.text}>{line || " "}</Text>;
    return (
      <Text>
        <Text color={theme.accent} bold>
          {line.slice(0, cmdEnd)}
        </Text>
        <Text color={theme.text}>{line.slice(cmdEnd) || ""}</Text>
      </Text>
    );
  }

  // Cursor line: plain slices + inverse cell (no token splits — keeps spaces correct)
  const before = line.slice(0, cursorCol);
  const at = line[cursorCol] ?? " ";
  const after = line.slice(cursorCol + 1);

  if (!isSlash) {
    return (
      <Text>
        <Text color={theme.text}>{before}</Text>
        <Text inverse>{at}</Text>
        <Text color={theme.text}>{after}</Text>
      </Text>
    );
  }

  // Slash line with accent on /command portion
  const paint = (s: string, from: number) => {
    if (!s) return null;
    // segment relative to absolute [from, from+s.length)
    const absEnd = from + s.length;
    if (absEnd <= cmdEnd) {
      return (
        <Text color={theme.accent} bold>
          {s}
        </Text>
      );
    }
    if (from >= cmdEnd) {
      return <Text color={theme.text}>{s}</Text>;
    }
    const cut = cmdEnd - from;
    return (
      <Text>
        <Text color={theme.accent} bold>
          {s.slice(0, cut)}
        </Text>
        <Text color={theme.text}>{s.slice(cut)}</Text>
      </Text>
    );
  };

  return (
    <Text>
      {paint(before, 0)}
      <Text inverse>{at}</Text>
      {paint(after, cursorCol + 1)}
    </Text>
  );
}

export const InputBox = memo(function InputBox({
  running,
  disabled,
  onSubmit,
  onEscape,
  slashCommands,
  fileCandidates,
  theme,
  onScrollUp,
  onScrollDown,
  /** Fixed width for centered welcome layout (OpenCode-style) */
  width,
  placeholder: placeholderOverride,
}: {
  running: boolean;
  disabled?: boolean;
  onSubmit: (text: string) => void;
  onEscape?: () => void;
  slashCommands?: SlashCommand[];
  /** Project-relative paths for @path completion */
  fileCandidates?: string[];
  theme?: Theme;
  onScrollUp?: () => void;
  onScrollDown?: () => void;
  width?: number;
  placeholder?: string;
}) {
  const t = theme ?? THEMES.dev;
  const [buf, setBuf] = useState<Buffer>({ value: "", cursor: 0 });
  // Keep a ref so useInput never reads a stale buffer (ink may not re-bind every render).
  const bufRef = useRef(buf);
  bufRef.current = buf;
  const historyRef = useRef<string[]>([]);
  const draftRef = useRef("");
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const slashIndexRef = useRef(0);
  const [slashIndex, setSlashIndex] = useState(0);
  slashIndexRef.current = slashIndex;
  const atIndexRef = useRef(0);
  const [atIndex, setAtIndex] = useState(0);
  atIndexRef.current = atIndex;
  const fileCandidatesRef = useRef(fileCandidates ?? []);
  fileCandidatesRef.current = fileCandidates ?? [];

  const edit = useCallback((fn: (prev: Buffer) => Buffer): void => {
    setBuf((prev) => {
      const next = fn(prev);
      bufRef.current = next;
      return next;
    });
  }, []);
  const insert = useCallback(
    (text: string): void =>
      edit((p) => ({
        value: p.value.slice(0, p.cursor) + text + p.value.slice(p.cursor),
        cursor: p.cursor + text.length,
      })),
    [edit],
  );

  const recall = (index: number): void => {
    const text = historyRef.current[index];
    setHistIndex(index);
    setBuf({ value: text, cursor: text.length });
  };

  const moveVertical = (dir: -1 | 1): void =>
    edit((p) => {
      const lines = p.value.split("\n");
      let row = 0;
      let remaining = p.cursor;
      while (row < lines.length - 1 && remaining > lines[row].length) {
        remaining -= lines[row].length + 1;
        row++;
      }
      const target = row + dir;
      if (target < 0 || target >= lines.length) return p;
      const start = lines.slice(0, target).reduce((n, l) => n + l.length + 1, 0);
      const cursor = start + Math.min(remaining, lines[target].length);
      return { value: p.value, cursor };
    });

  const slashPrefix =
    slashCommands && buf.value.startsWith("/") && !buf.value.includes("\n")
      ? buf.value.slice(1).split(" ")[0] ?? ""
      : null;
  const slashOnly = slashPrefix !== null && !buf.value.includes(" ");
  const ranked = slashOnly && slashCommands ? rankSlashCommands(slashPrefix, slashCommands, 10) : [];
  const slashMatches = ranked.map((r) => r.cmd);
  const activeSlash = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));
  const slashMatchesRef = useRef(slashMatches);
  slashMatchesRef.current = slashMatches;

  // Argument dropdown: when the buffer is "/<cmd> <partial-arg>" and the
  // resolved command exposes a fixed set of arg options, show them inline
  // so the user picks from a list instead of typing the value free-form.
  const slashArgCmd =
    slashPrefix !== null && slashCommands
      ? slashCommands.find((c) => c.name === slashPrefix.toLowerCase() && c.args && c.args.length > 0)
      : undefined;
  const slashArgActive = slashArgCmd !== undefined && buf.value.includes(" ") && !buf.value.includes("\n");
  const slashArgQuery = slashArgActive ? buf.value.slice(buf.value.indexOf(" ") + 1) : "";
  const slashArgOptions = slashArgActive && slashArgCmd?.args
    ? slashArgCmd.args
        .filter((a) => !slashArgQuery || a.value.startsWith(slashArgQuery) || a.value.includes(slashArgQuery))
        .slice(0, 10)
    : [];
  const activeArg = Math.min(slashIndex, Math.max(0, slashArgOptions.length - 1));
  const slashArgOptionsRef = useRef(slashArgOptions);
  slashArgOptionsRef.current = slashArgOptions;
  const slashArgActiveRef = useRef(slashArgActive);
  slashArgActiveRef.current = slashArgActive;

  const atTok = !slashOnly && !slashArgActive ? atTokenAtCursor(buf.value, buf.cursor) : null;
  const atMatches =
    atTok && fileCandidates && fileCandidates.length > 0
      ? rankByFuzzy(fileCandidates, atTok.query, (p) => [p])
          .slice(0, 10)
          .map((r) => r.item)
      : [];
  const activeAt = Math.min(atIndex, Math.max(0, atMatches.length - 1));
  const atMatchesRef = useRef(atMatches);
  atMatchesRef.current = atMatches;
  const atTokRef = useRef(atTok);
  atTokRef.current = atTok;

  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  usePaste((text) => insert(text), { isActive: !disabled });

  useInput(
    (input, key) => {
      const cur = bufRef.current;
      const matches = slashMatchesRef.current;
      const sOnly = cur.value.startsWith("/") && !cur.value.includes(" ") && !cur.value.includes("\n");
      const sIdx = Math.min(slashIndexRef.current, Math.max(0, matches.length - 1));
      const argOptions = slashArgOptionsRef.current;
      const argActive = slashArgActiveRef.current && argOptions.length > 0;
      const argIdx = Math.min(slashIndexRef.current, Math.max(0, argOptions.length - 1));
      const aMatches = atMatchesRef.current;
      const aTok = atTokRef.current;
      const aIdx = Math.min(atIndexRef.current, Math.max(0, aMatches.length - 1));
      const aActive = !sOnly && aTok !== null && aMatches.length > 0;

      if (key.escape) {
        onEscape?.();
        return;
      }
      if (key.pageUp) {
        onScrollUp?.();
        return;
      }
      if (key.pageDown) {
        onScrollDown?.();
        return;
      }
      if (key.return && key.meta) {
        insert("\n");
        return;
      }
      // Enter / CR
      if (key.return || input === "\r") {
        // If the typed query already matches a valid option exactly, submit
        // instead of re-picking from the dropdown (so /thinking off + Enter
        // runs the command rather than re-filling the buffer).
        const argQueryExact =
          argActive && argOptions.some((o) => o.value === cur.value.slice(cur.value.indexOf(" ") + 1));
        if (argActive && !argQueryExact) {
          const pick = argOptions[argIdx] ?? argOptions[0];
          const sp = cur.value.indexOf(" ");
          const next = cur.value.slice(0, sp + 1) + pick.value;
          const nb = { value: next, cursor: next.length };
          bufRef.current = nb;
          setBuf(nb);
          setSlashIndex(0);
          return;
        }
        if (sOnly && matches.length > 0) {
          const pick = matches[sIdx] ?? matches[0];
          const next = `/${pick.name} `;
          const nb = { value: next, cursor: next.length };
          bufRef.current = nb;
          setBuf(nb);
          setSlashIndex(0);
          return;
        }
        if (aActive && aTok) {
          const pick = aMatches[aIdx] ?? aMatches[0];
          const before = cur.value.slice(0, aTok.start);
          const after = cur.value.slice(cur.cursor);
          const insertText = `@${pick} `;
          const next = before + insertText + after;
          const nb = { value: next, cursor: before.length + insertText.length };
          bufRef.current = nb;
          setBuf(nb);
          setAtIndex(0);
          return;
        }
        if (cur.value.endsWith("\\") && cur.cursor === cur.value.length) {
          edit((p) => ({ value: `${p.value.slice(0, -1)}\n`, cursor: p.cursor }));
          return;
        }
        if (cur.value.trim().length > 0) {
          historyRef.current.push(cur.value);
          if (historyRef.current.length > 100) historyRef.current.shift();
          onSubmitRef.current(cur.value);
        }
        const empty = { value: "", cursor: 0 };
        bufRef.current = empty;
        setBuf(empty);
        setHistIndex(null);
        setSlashIndex(0);
        setAtIndex(0);
        return;
      }
      if (input === "\n" || (key.ctrl && input === "j")) {
        insert("\n");
        return;
      }
      if (key.ctrl && input === "u") {
        edit((p) => {
          const start = lineStart(p.value, p.cursor);
          const end = lineEnd(p.value, p.cursor);
          const removeEnd = end < p.value.length ? end + 1 : end;
          return { value: p.value.slice(0, start) + p.value.slice(removeEnd), cursor: start };
        });
        return;
      }
      if (key.ctrl && input === "w") {
        edit((p) => {
          let i = p.cursor;
          while (i > 0 && /\s/.test(p.value[i - 1])) i--;
          while (i > 0 && !/\s/.test(p.value[i - 1])) i--;
          return { value: p.value.slice(0, i) + p.value.slice(p.cursor), cursor: i };
        });
        return;
      }
      if (key.backspace) {
        edit((p) =>
          p.cursor === 0 ? p : { value: p.value.slice(0, p.cursor - 1) + p.value.slice(p.cursor), cursor: p.cursor - 1 },
        );
        setSlashIndex(0);
        return;
      }
      if (key.delete) {
        edit((p) =>
          p.cursor >= p.value.length ? p : { value: p.value.slice(0, p.cursor) + p.value.slice(p.cursor + 1), cursor: p.cursor },
        );
        return;
      }
      if (key.leftArrow) {
        edit((p) => ({ ...p, cursor: Math.max(0, p.cursor - 1) }));
        return;
      }
      if (key.rightArrow) {
        edit((p) => ({ ...p, cursor: Math.min(p.value.length, p.cursor + 1) }));
        return;
      }
      if (key.home) {
        edit((p) => ({ ...p, cursor: lineStart(p.value, p.cursor) }));
        return;
      }
      if (key.end) {
        edit((p) => ({ ...p, cursor: lineEnd(p.value, p.cursor) }));
        return;
      }
      if (key.upArrow) {
        if (argActive) {
          setSlashIndex((i) => (i + argOptions.length - 1) % argOptions.length);
          return;
        }
        if (sOnly && matches.length > 0) {
          setSlashIndex((i) => (i + matches.length - 1) % matches.length);
          return;
        }
        if (aActive) {
          setAtIndex((i) => (i + aMatches.length - 1) % aMatches.length);
          return;
        }
        const firstNl = cur.value.indexOf("\n");
        const onFirstLine = firstNl === -1 || cur.cursor <= firstNl;
        const history = historyRef.current;
        if (onFirstLine) {
          if (history.length === 0) return;
          if (histIndex === null) {
            draftRef.current = cur.value;
            recall(history.length - 1);
          } else if (histIndex > 0) {
            recall(histIndex - 1);
          }
        } else {
          moveVertical(-1);
        }
        return;
      }
      if (key.downArrow) {
        if (argActive) {
          setSlashIndex((i) => (i + 1) % argOptions.length);
          return;
        }
        if (sOnly && matches.length > 0) {
          setSlashIndex((i) => (i + 1) % matches.length);
          return;
        }
        if (aActive) {
          setAtIndex((i) => (i + 1) % aMatches.length);
          return;
        }
        const lastNl = cur.value.lastIndexOf("\n");
        const onLastLine = lastNl === -1 || cur.cursor > lastNl;
        if (onLastLine) {
          if (histIndex === null) return;
          if (histIndex < historyRef.current.length - 1) recall(histIndex + 1);
          else {
            setHistIndex(null);
            const d = { value: draftRef.current, cursor: draftRef.current.length };
            bufRef.current = d;
            setBuf(d);
          }
        } else {
          moveVertical(1);
        }
        return;
      }
      if (key.tab) {
        if (argActive) {
          const pick = argOptions[argIdx] ?? argOptions[0];
          const sp = cur.value.indexOf(" ");
          const next = cur.value.slice(0, sp + 1) + pick.value;
          const nb = { value: next, cursor: next.length };
          bufRef.current = nb;
          setBuf(nb);
          setSlashIndex(0);
          return;
        }
        if (sOnly && matches.length > 0) {
          const pick = matches[sIdx] ?? matches[0];
          if (matches.length === 1) {
            const next = `/${pick.name} `;
            const nb = { value: next, cursor: next.length };
            bufRef.current = nb;
            setBuf(nb);
            setSlashIndex(0);
          } else {
            const lcp = longestCommonPrefix(matches.map((m) => m.name));
            const next = `/${lcp}`;
            const nb = { value: next, cursor: next.length };
            bufRef.current = nb;
            setBuf(nb);
          }
          return;
        }
        if (aActive && aTok) {
          const pick = aMatches[aIdx] ?? aMatches[0];
          const before = cur.value.slice(0, aTok.start);
          const after = cur.value.slice(cur.cursor);
          const insertText = `@${pick}`;
          const next = before + insertText + after;
          const nb = { value: next, cursor: before.length + insertText.length };
          bufRef.current = nb;
          setBuf(nb);
          setAtIndex(0);
        }
        return;
      }
      if (key.ctrl || key.meta) return;
      // Accept printable text; strip only C0 controls (keep space, tab handled above)
      if (input) {
        const cleaned = input.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
        if (cleaned) {
          insert(cleaned);
          setSlashIndex(0);
          setAtIndex(0);
        }
      }
    },
    { isActive: !disabled },
  );

  const lines = buf.value.split("\n");
  let row = 0;
  let remaining = buf.cursor;
  while (row < lines.length - 1 && remaining > lines[row].length) {
    remaining -= lines[row].length + 1;
    row++;
  }
  const col = remaining;

  const placeholder = placeholderOverride ?? (running ? "Queue a follow-up  (Enter to queue)" : null);
  // Empty placeholder: just show the cursor. The fixed welcome hint used to live
  // here ("Ask anything…  Fix broken tests") and was always the same sentence
  // on every launch — removing it lets each user use whatever framing suits
  // their workflow without DevCode putting words in the input.

  return (
    <Box flexDirection="column" width={width}>
      {slashOnly ? (
        <Box flexDirection="column" marginBottom={0} paddingX={1}>
          {slashMatches.length === 0 ? (
            <Text color={t.error}>no match for /{slashPrefix}</Text>
          ) : (
            slashMatches.map((m, i) => (
              <Text key={m.name} color={i === activeSlash ? t.accent : t.text}>
                {i === activeSlash ? "❯ " : "  "}/
                {m.name}
                <Text color={t.accentDim}>
                  {" — "}
                  {m.description}
                </Text>
              </Text>
            ))
          )}
        </Box>
      ) : slashArgActive ? (
        <Box flexDirection="column" marginBottom={0} paddingX={1}>
          {slashArgOptions.length === 0 ? (
            <Text color={t.error}>no option for /{slashArgCmd?.name} {slashArgQuery}</Text>
          ) : (
            slashArgOptions.map((o, i) => (
              <Text key={o.value} color={i === activeArg ? t.accent : t.text}>
                {i === activeArg ? "❯ " : "  "}/
                {slashArgCmd?.name} {o.value}
                {o.description ? (
                  <Text color={t.accentDim}>
                    {" — "}
                    {o.description}
                  </Text>
                ) : null}
              </Text>
            ))
          )}
        </Box>
      ) : atMatches.length > 0 ? (
        <Box flexDirection="column" marginBottom={0} paddingX={1}>
          {atMatches.map((p, i) => (
            <Text key={p} color={i === activeAt ? t.accent : t.text}>
              {i === activeAt ? "❯ " : "  "}@{p}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box
        borderStyle="single"
        borderColor={running ? t.warn : t.border}
        flexDirection="column"
        paddingX={1}
        width={width}
      >
        {buf.value.length === 0 ? (
          placeholder ? (
            <Text>
              <Text inverse>{" "}</Text>
              <Text color={t.accentDim}>{" "}{placeholder}</Text>
            </Text>
          ) : (
            <Text inverse>{" "}</Text>
          )
        ) : (
          lines.map((line, i) => (
            <Box key={i}>{renderLine(line, t, i === row ? col : null)}</Box>
          ))
        )}
      </Box>
    </Box>
  );
});
