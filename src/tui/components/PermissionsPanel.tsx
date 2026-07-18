/**
 * Interactive /permissions manager (Claude Code parity).
 * Browse modes, allow/deny rules, and session remembers; remove rules with Enter.
 */
import React, { useCallback, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  formatRuleLabel,
  type PermissionEngine,
  type PermissionMode,
} from "../../core/permissions.js";
import type { Theme } from "../theme.js";

type Row =
  | { kind: "header"; id: string; label: string }
  | { kind: "mode"; id: string; mode: PermissionMode; label: string; detail: string }
  | { kind: "rule"; id: string; list: "allow" | "deny"; rule: string; label: string; detail: string }
  | { kind: "session"; id: string; which: "allow" | "deny"; key: string; label: string; detail: string }
  | { kind: "action"; id: string; action: "clear_session" | "done"; label: string; detail?: string };

const MODES: { mode: PermissionMode; label: string; detail: string }[] = [
  { mode: "default", label: "default", detail: "ask before write/edit/bash (and other mutating tools)" },
  { mode: "acceptEdits", label: "acceptEdits", detail: "auto-allow write + edit; still ask for bash" },
  { mode: "bypassPermissions", label: "bypassPermissions", detail: "auto-allow all (circuit breakers still apply)" },
];

export function PermissionsPanel({
  theme,
  engine,
  onChange,
  onClose,
}: {
  theme: Theme;
  engine: PermissionEngine;
  /** Persist rules/mode to settings after a mutation. */
  onChange: (snapshot: { allow: string[]; deny: string[]; defaultMode: PermissionMode }) => void;
  onClose: () => void;
}) {
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);

  const rows: Row[] = useMemo(() => {
    void tick;
    const r = engine.rules;
    const mode = engine.getMode();
    const out: Row[] = [];

    out.push({ kind: "header", id: "h-mode", label: "Mode (this session · also saved as defaultMode)" });
    for (const m of MODES) {
      out.push({
        kind: "mode",
        id: `mode-${m.mode}`,
        mode: m.mode,
        label: `${mode === m.mode ? "●" : "○"} ${m.label}`,
        detail: m.detail,
      });
    }

    out.push({ kind: "header", id: "h-allow", label: `Allow rules (${r.allow.length}) — Enter to remove` });
    if (r.allow.length === 0) {
      out.push({
        kind: "action",
        id: "allow-empty",
        action: "done",
        label: "(none — use the prompt “always allow” or edit settings.json)",
      });
    } else {
      for (const rule of r.allow) {
        out.push({
          kind: "rule",
          id: `allow-${rule}`,
          list: "allow",
          rule,
          label: formatRuleLabel(rule),
          detail: rule,
        });
      }
    }

    out.push({ kind: "header", id: "h-deny", label: `Deny rules (${r.deny.length}) — Enter to remove` });
    if (r.deny.length === 0) {
      out.push({
        kind: "action",
        id: "deny-empty",
        action: "done",
        label: "(none)",
      });
    } else {
      for (const rule of r.deny) {
        out.push({
          kind: "rule",
          id: `deny-${rule}`,
          list: "deny",
          rule,
          label: formatRuleLabel(rule),
          detail: rule,
        });
      }
    }

    const sa = engine.listSessionAllows();
    const sd = engine.listSessionDenies();
    out.push({ kind: "header", id: "h-sess", label: `Session remembers (allow ${sa.length} · deny ${sd.length})` });
    for (const k of sa) {
      out.push({
        kind: "session",
        id: `sa-${k}`,
        which: "allow",
        key: k,
        label: `session allow · ${k}`,
        detail: "until restart",
      });
    }
    for (const k of sd) {
      out.push({
        kind: "session",
        id: `sd-${k}`,
        which: "deny",
        key: k,
        label: `session deny · ${k}`,
        detail: "until restart",
      });
    }
    if (sa.length === 0 && sd.length === 0) {
      out.push({
        kind: "action",
        id: "sess-empty",
        action: "done",
        label: "(no session remembers yet)",
      });
    }

    out.push({
      kind: "action",
      id: "done",
      action: "done",
      label: "Done",
      detail: "close",
    });
    return out;
  }, [engine, tick]);

  // Selectable rows only (skip pure headers and empty placeholders that are action:done empty)
  const selectable = useMemo(
    () =>
      rows.filter((row) => {
        if (row.kind === "header") return false;
        if (row.kind === "action" && row.id.endsWith("-empty")) return false;
        if (row.kind === "action" && row.id === "sess-empty") return false;
        return true;
      }),
    [rows],
  );

  const [index, setIndex] = useState(0);
  const safeIndex = selectable.length === 0 ? 0 : Math.min(index, selectable.length - 1);
  const active = selectable[safeIndex];

  const activate = useCallback(
    (row: Row | undefined) => {
      if (!row) return;
      if (row.kind === "mode") {
        engine.setMode(row.mode);
        onChange({ ...engine.rules, defaultMode: row.mode });
        refresh();
        return;
      }
      if (row.kind === "rule") {
        const snap = engine.removePersistentRule(row.rule, row.list);
        onChange(snap);
        refresh();
        return;
      }
      if (row.kind === "action" && row.action === "done") {
        onClose();
        return;
      }
      // session rows are informational; Enter closes? better leave them
    },
    [engine, onChange, onClose],
  );

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow || input === "k") {
      if (selectable.length === 0) return;
      setIndex((i) => (i + selectable.length - 1) % selectable.length);
      return;
    }
    if (key.downArrow || input === "j" || key.tab) {
      if (selectable.length === 0) return;
      setIndex((i) => (i + 1) % selectable.length);
      return;
    }
    if (key.return) {
      activate(active);
      return;
    }
    if (input === "d" || input === "D") {
      // shortcut: if on a rule, remove
      if (active?.kind === "rule") activate(active);
      return;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        Permissions
      </Text>
      <Text color={theme.muted}>↑/↓ · Enter select/remove · d delete rule · Esc close</Text>
      <Text color={theme.muted}>
        Rules: tool or tool:glob · deny wins · circuit breakers (rm -rf /, .git) always deny
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row) => {
          if (row.kind === "header") {
            return (
              <Text key={row.id} color={theme.accentDim} bold>
                {row.label}
              </Text>
            );
          }
          const isActive = active?.id === row.id;
          const label =
            row.kind === "mode"
              ? row.label
              : row.kind === "rule"
                ? `${row.list === "allow" ? "allow" : "deny"}  ${row.label}`
                : row.kind === "session"
                  ? row.label
                  : row.label;
          const detail =
            row.kind === "mode"
              ? row.detail
              : row.kind === "rule"
                ? row.detail
                : row.kind === "session"
                  ? row.detail
                  : row.detail;
          return (
            <Text key={row.id} color={isActive ? theme.accent : theme.text} bold={isActive}>
              {isActive ? "❯ " : "  "}
              {label}
              {detail ? (
                <Text color={theme.muted} bold={false}>
                  {"  "}
                  {detail}
                </Text>
              ) : null}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
