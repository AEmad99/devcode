import React, { useCallback } from "react";
import type { SessionInfo } from "../../core/session.js";
import type { Theme } from "../theme.js";
import { SearchablePicker } from "./SearchablePicker.js";

export function ResumePicker({
  theme,
  sessions,
  currentId,
  loading,
  windowSize,
  onPick,
  onCancel,
}: {
  theme: Theme;
  sessions: SessionInfo[];
  currentId?: string;
  loading?: boolean;
  windowSize?: number;
  onPick: (s: SessionInfo) => void;
  onCancel: () => void;
}) {
  const fieldsOf = useCallback((s: SessionInfo) => [s.id, s.preview, s.createdAt, s.name ?? ""], []);
  const keyOf = useCallback((s: SessionInfo) => s.id, []);
  const labelOf = useCallback((s: SessionInfo) => {
    const cur = s.id === currentId ? " · current" : "";
    const name = s.name ? `[${s.name}] ` : "";
    return `${name}${s.preview || "(empty)"}${cur}`;
  }, [currentId]);
  const detailOf = useCallback((s: SessionInfo) => {
    const date = s.createdAt ? s.createdAt.slice(0, 19).replace("T", " ") : "";
    return `${date} · ${s.messageCount} msgs · ${s.id}`;
  }, []);
  const isCurrent = useCallback((s: SessionInfo) => s.id === currentId, [currentId]);

  return (
    <SearchablePicker
      theme={theme}
      title="Resume session"
      items={sessions}
      fieldsOf={fieldsOf}
      keyOf={keyOf}
      labelOf={labelOf}
      detailOf={detailOf}
      isCurrent={isCurrent}
      initialKey={currentId}
      loading={loading}
      windowSize={windowSize}
      emptyMessage="No sessions for this project"
      onPick={onPick}
      onCancel={onCancel}
      footerHint="↑/↓ · Enter resume · Esc cancel"
    />
  );
}
