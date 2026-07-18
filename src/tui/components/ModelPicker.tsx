import React, { useCallback } from "react";
import type { ModelInfo } from "../../providers/models.js";
import type { Theme } from "../theme.js";
import { SearchablePicker } from "./SearchablePicker.js";

/**
 * Searchable model list — type to filter, arrows + Enter to pick.
 */
export function ModelPicker({
  theme,
  models,
  current,
  loading,
  windowSize,
  onPick,
  onCancel,
}: {
  theme: Theme;
  models: ModelInfo[];
  current?: string;
  loading?: boolean;
  windowSize?: number;
  onPick: (modelId: string) => void;
  onCancel: () => void;
}) {
  const fieldsOf = useCallback(
    (m: ModelInfo) => [m.id, m.name, m.contextWindow ? `${m.contextWindow}` : ""].filter(Boolean),
    [],
  );

  return (
    <SearchablePicker<ModelInfo>
      theme={theme}
      title="Select model"
      items={models}
      fieldsOf={fieldsOf}
      keyOf={(m) => m.id}
      labelOf={(m) => m.id}
      detailOf={(m) => {
        const bits: string[] = [];
        if (m.name && m.name !== m.id) bits.push(m.name);
        if (m.contextWindow) {
          const k = m.contextWindow >= 1000 ? `${Math.round(m.contextWindow / 1000)}k` : String(m.contextWindow);
          bits.push(`${k} ctx`);
        }
        return bits.length ? bits.join(" · ") : undefined;
      }}
      isCurrent={(m) => m.id === current}
      initialKey={current}
      loading={loading}
      emptyMessage="No models found for this provider"
      noMatchMessage="No models match"
      placeholder="search models…  e.g. sonnet, gpt-5, deepseek"
      windowSize={windowSize ?? 14}
      onPick={(m) => onPick(m.id)}
      onCancel={onCancel}
    />
  );
}
