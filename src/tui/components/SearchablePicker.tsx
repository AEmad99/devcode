/**
 * Frictionless type-to-filter list (fzf / command-palette style).
 * Type to search · ↑/↓ move · Enter pick · Esc clears query then cancels.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import { layoutFromTerminal } from "../layout.js";
import { rankByFuzzy } from "../fuzzy.js";
import type { Theme } from "../theme.js";

export interface SearchablePickerProps<T> {
  theme: Theme;
  title: string;
  items: T[];
  /** Fields used for fuzzy search (id, name, aliases, …). */
  fieldsOf: (item: T) => string[];
  /** Stable key for React list. */
  keyOf: (item: T) => string;
  /** Main label line. */
  labelOf: (item: T) => string;
  /** Optional dim secondary text (auth status, model name, …). */
  detailOf?: (item: T) => string | undefined;
  /** Highlight current selection (e.g. active model). */
  isCurrent?: (item: T) => boolean;
  /** Prefer this item when opening with empty query. */
  initialKey?: string;
  loading?: boolean;
  emptyMessage?: string;
  noMatchMessage?: string;
  windowSize?: number;
  placeholder?: string;
  onPick: (item: T) => void;
  onCancel: () => void;
  /** Extra footer hint line. */
  footerHint?: string;
}

export function SearchablePicker<T>({
  theme,
  title,
  items,
  fieldsOf,
  keyOf,
  labelOf,
  detailOf,
  isCurrent,
  initialKey,
  loading,
  emptyMessage = "Nothing to show",
  noMatchMessage = "No matches",
  windowSize,
  placeholder = "type to search…",
  onPick,
  onCancel,
  footerHint,
}: SearchablePickerProps<T>) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const win = useWindowSize();
  // Prefer explicit prop; otherwise track live terminal height on resize.
  const adaptiveWindow = useMemo(
    () => (windowSize != null ? windowSize : layoutFromTerminal(win.columns, win.rows).pickerWindow),
    [windowSize, win.columns, win.rows],
  );

  const ranked = useMemo(() => rankByFuzzy(items, query, fieldsOf), [items, query, fieldsOf]);
  const filtered = useMemo(() => ranked.map((r) => r.item), [ranked]);

  // Keep index valid; when query changes, jump to top (best match).
  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    if (filtered.length === 0) {
      setIndex(0);
      return;
    }
    if (index >= filtered.length) setIndex(filtered.length - 1);
  }, [filtered.length, index]);

  // On first open / items load, focus current or initial key when not searching.
  useEffect(() => {
    if (query || filtered.length === 0) return;
    const key = initialKey;
    if (!key) return;
    const i = filtered.findIndex((it) => keyOf(it) === key);
    if (i >= 0) setIndex(i);
    // only when items identity changes and query empty
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, initialKey]);

  useInput((input, key) => {
    if (key.escape) {
      if (query) {
        setQuery("");
        return;
      }
      onCancel();
      return;
    }

    // Ctrl+U / Ctrl+W — clear search (muscle memory from shells)
    if (key.ctrl && (input === "u" || input === "U" || input === "w" || input === "W")) {
      setQuery("");
      return;
    }

    if (key.upArrow) {
      if (filtered.length === 0) return;
      setIndex((i) => (i + filtered.length - 1) % filtered.length);
      return;
    }
    if (key.downArrow) {
      if (filtered.length === 0) return;
      setIndex((i) => (i + 1) % filtered.length);
      return;
    }

    if (key.return) {
      const hit = filtered[index];
      if (hit) onPick(hit);
      return;
    }

    // Digits are always part of the search query (model ids like gpt-4.1, o3, claude-4-6).

    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }

    // Printable characters → append to search (no need to focus a separate field)
    if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
      // ink may deliver multi-char paste
      const clean = input.replace(/[\x00-\x1f]/g, "");
      if (clean) setQuery((q) => q + clean);
    }
  });

  const start = Math.max(0, Math.min(index - Math.floor(adaptiveWindow / 3), Math.max(0, filtered.length - adaptiveWindow)));
  const slice = filtered.slice(start, start + adaptiveWindow);
  const total = filtered.length;
  const searching = query.length > 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text color={theme.accent} bold>
        {title}
      </Text>

      {/* Always-visible search bar */}
      <Box>
        <Text color={theme.accentDim}>⌕ </Text>
        <Text color={theme.highlight}>{query || ""}</Text>
        <Text color={theme.accent}>{searching || query ? "█" : ""}</Text>
        {!query ? <Text color={theme.muted}>{placeholder}</Text> : null}
      </Box>

      <Text color={theme.muted}>
        ↑/↓ · Enter · type to filter · Esc {query ? "clear" : "cancel"}
        {footerHint ? ` · ${footerHint}` : ""}
      </Text>

      {loading ? (
        <Text color={theme.text}>Loading…</Text>
      ) : items.length === 0 ? (
        <Text color={theme.error}>{emptyMessage}</Text>
      ) : filtered.length === 0 ? (
        <Text color={theme.warn}>
          {noMatchMessage}
          {query ? ` for “${query}”` : ""}
          {" — Esc to clear"}
        </Text>
      ) : (
        slice.map((item, i) => {
          const abs = start + i;
          const active = abs === index;
          const current = isCurrent?.(item) ?? false;
          const detail = detailOf?.(item);
          return (
            <Text key={keyOf(item)} color={active ? theme.accent : theme.text} bold={active || current}>
              {active ? "❯ " : "  "}
              {current ? "● " : "  "}
              {labelOf(item)}
              {detail ? (
                <Text color={theme.muted} bold={false}>
                  {"  "}
                  {detail}
                </Text>
              ) : null}
            </Text>
          );
        })
      )}

      {!loading && total > 0 ? (
        <Text color={theme.muted}>
          {searching ? `${total} match${total === 1 ? "" : "es"}` : `${total} total`}
          {total > adaptiveWindow
            ? ` · ${start + 1}–${Math.min(start + adaptiveWindow, total)}`
            : ""}
          {searching && items.length !== total ? ` of ${items.length}` : ""}
        </Text>
      ) : null}
    </Box>
  );
}
