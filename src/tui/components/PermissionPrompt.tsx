/**
 * Claude Code–style permission prompt: vertical dropdown of choices.
 * ↑/↓ or j/k · 1–9 number keys · Enter · y/a/n shortcuts for common picks.
 */
import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  formatRuleLabel,
  suggestPermissionRule,
  type PermissionChoice,
} from "../../core/permissions.js";
import type { PendingPermission } from "../store.js";
import { DiffView } from "./DiffView.js";

export interface PermissionOption {
  key: string;
  label: string;
  detail?: string;
  choice: PermissionChoice;
  /** Special session action handled outside choice (e.g. accept all edits). */
  action?: "accept_edits_session";
}

function buildOptions(request: PendingPermission): PermissionOption[] {
  const tool = request.tool;
  const input = request.input;
  const rule = suggestPermissionRule(tool, input);
  const ruleLabel = formatRuleLabel(rule);
  const isEdit = tool === "write" || tool === "edit";
  const isBash = tool === "bash";

  const opts: PermissionOption[] = [
    { key: "yes", label: "Yes", detail: "allow this once", choice: "once" },
  ];

  if (isEdit) {
    opts.push({
      key: "edits",
      label: "Yes, and allow all edits this session",
      detail: "write + edit",
      choice: "session",
      action: "accept_edits_session",
    });
  }

  if (isBash) {
    opts.push({
      key: "session",
      label: `Yes, and don't ask again for: ${ruleLabel}`,
      detail: "this session only",
      choice: "session",
    });
  } else if (!isEdit) {
    opts.push({
      key: "session",
      label: `Yes, and don't ask again for ${tool}`,
      detail: "this session only",
      choice: "session",
    });
  }

  opts.push({
    key: "always",
    label: `Yes, and always allow ${ruleLabel}`,
    detail: "save to settings.json",
    choice: "always",
  });

  opts.push({
    key: "no",
    label: "No",
    detail: "deny this once",
    choice: "deny",
  });

  opts.push({
    key: "always_deny",
    label: `No, and always deny ${ruleLabel}`,
    detail: "save to settings.json",
    choice: "always_deny",
  });

  return opts;
}

export function PermissionPrompt({
  request,
  onResolve,
  onAcceptEditsSession,
}: {
  request: PendingPermission;
  onResolve: (choice: PermissionChoice) => void;
  /** Called when user picks "allow all edits this session" before resolving session. */
  onAcceptEditsSession?: () => void;
}) {
  const options = useMemo(() => buildOptions(request), [request]);
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setSelected((s) => (s + options.length - 1) % options.length);
      return;
    }
    if (key.downArrow || input === "j" || key.tab) {
      setSelected((s) => (s + 1) % options.length);
      return;
    }
    if (key.return) {
      const opt = options[selected];
      if (!opt) return;
      if (opt.action === "accept_edits_session") onAcceptEditsSession?.();
      onResolve(opt.choice);
      return;
    }
    // Number keys 1–9
    if (input >= "1" && input <= "9") {
      const i = Number(input) - 1;
      if (i < options.length) {
        const opt = options[i];
        if (opt.action === "accept_edits_session") onAcceptEditsSession?.();
        onResolve(opt.choice);
      }
      return;
    }
    // Muscle-memory shortcuts
    if (input === "y") {
      onResolve("once");
      return;
    }
    if (input === "a") {
      // "always" if present, else session
      const always = options.find((o) => o.choice === "always");
      if (always) onResolve("always");
      else onResolve("session");
      return;
    }
    if (input === "n") {
      onResolve("deny");
      return;
    }
  });

  const inp = (request.input ?? {}) as Record<string, unknown>;
  const detailLines = request.detail.split("\n").slice(0, 10);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold>
        Do you want to allow <Text color="yellow">{request.tool}</Text>?
      </Text>
      {request.tool === "edit" && typeof inp.old_string === "string" ? (
        <DiffView oldText={inp.old_string} newText={String(inp.new_string ?? "")} maxLines={12} />
      ) : request.tool === "write" && typeof inp.content === "string" ? (
        <DiffView oldText="" newText={inp.content.split("\n").slice(0, 12).join("\n")} />
      ) : (
        detailLines.map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))
      )}
      <Text dimColor> </Text>
      {options.map((opt, i) => {
        const active = i === selected;
        return (
          <Text key={opt.key} inverse={active} color={active ? undefined : undefined}>
            {active ? "❯ " : "  "}
            <Text bold={active}>{i + 1}. {opt.label}</Text>
            {opt.detail ? (
              <Text dimColor>
                {"  "}
                {opt.detail}
              </Text>
            ) : null}
          </Text>
        );
      })}
      <Text dimColor>↑/↓ · Enter · 1–{options.length} · y yes · a always · n no · Esc deny</Text>
    </Box>
  );
}
