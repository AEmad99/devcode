import React, { useCallback } from "react";
import { authMethodsLabel, type AuthState, type ProviderSpec } from "../../providers/registry.js";
import type { Theme } from "../theme.js";
import { SearchablePicker } from "./SearchablePicker.js";

export type ProviderRow = { spec: ProviderSpec; auth: AuthState };

/**
 * Searchable provider list used by /login and /provider.
 */
export function ProviderPicker({
  theme,
  providers,
  currentId,
  title = "Select provider",
  windowSize,
  onPick,
  onCancel,
}: {
  theme: Theme;
  providers: ProviderRow[];
  currentId?: string;
  title?: string;
  windowSize?: number;
  onPick: (row: ProviderRow) => void;
  onCancel: () => void;
}) {
  const fieldsOf = useCallback(
    (p: ProviderRow) => [p.spec.id, p.spec.name, p.auth, authMethodsLabel(p.spec), ...(p.spec.envKeys ?? [])],
    [],
  );

  return (
    <SearchablePicker<ProviderRow>
      theme={theme}
      title={title}
      items={providers}
      fieldsOf={fieldsOf}
      keyOf={(p) => p.spec.id}
      labelOf={(p) => p.spec.name}
      detailOf={(p) => `[${p.auth}] · ${authMethodsLabel(p.spec)} · ${p.spec.id}`}
      isCurrent={(p) => p.spec.id === currentId}
      initialKey={currentId}
      emptyMessage="No providers registered"
      noMatchMessage="No providers match"
      placeholder="search providers…  e.g. anthropic, openai, minimax"
      windowSize={windowSize ?? 14}
      onPick={onPick}
      onCancel={onCancel}
      footerHint="id · name · auth"
    />
  );
}
