import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { FLOWS } from "../../providers/auth/flows.js";
import { openBrowser } from "../../providers/auth/oauth.js";
import { saveCred } from "../../providers/auth/storage.js";
import {
  listProviders,
  supportsApiKey,
  type AuthState,
  type ProviderSpec,
} from "../../providers/registry.js";
import { THEMES, type Theme } from "../theme.js";
import { ProviderPicker, type ProviderRow } from "./ProviderPicker.js";

export interface LoginResult {
  providerId: string;
  method: "oauth" | "api";
}

type Stage = "provider" | "method" | "busy";

function methodsFor(spec: ProviderSpec): { id: "oauth" | "api"; label: string }[] {
  const methods: { id: "oauth" | "api"; label: string }[] = [];
  if (spec.oauth) {
    methods.push({
      id: "oauth",
      label: spec.oauth.label ?? "OAuth (browser) — Recommended",
    });
  }
  if (supportsApiKey(spec)) {
    const envHint = spec.envKeys.filter((k) => !k.includes("OAUTH")).join(" / ") || "API key";
    methods.push({ id: "api", label: `Paste API key (${envHint})` });
  }
  return methods;
}

export function LoginFlow({
  initialProviderId,
  providers,
  onDone,
  theme,
}: {
  initialProviderId?: string;
  providers?: { spec: ProviderSpec; auth: AuthState }[];
  onDone: (result: LoginResult | null) => void;
  theme?: Theme;
}) {
  const t = theme ?? THEMES.dev;
  const list: ProviderRow[] = providers ?? listProviders();
  const [selected, setSelected] = useState<ProviderSpec | null>(() => {
    if (!initialProviderId) return null;
    return list.find((p) => p.spec.id === initialProviderId)?.spec ?? null;
  });
  const [stage, setStage] = useState<Stage>(initialProviderId && selected ? "method" : "provider");
  const [methodIndex, setMethodIndex] = useState(0);
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [pasteResolve, setPasteResolve] = useState<((value: string) => void) | null>(null);
  const [pasteValue, setPasteValue] = useState("");
  const doneRef = useRef(false);

  const methods = selected ? methodsFor(selected) : [];

  const finish = (result: LoginResult | null): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(result);
  };

  const runOAuth = async (spec: ProviderSpec): Promise<void> => {
    if (!spec.oauth) {
      setStatusLines(["This provider has no OAuth flow."]);
      return;
    }
    setStage("busy");
    setStatusLines(["Starting OAuth…"]);
    try {
      const flow = FLOWS[spec.oauth.flowId];
      const cred = await flow.start({
        openUrl: (url) => openBrowser(url),
        promptPaste: () =>
          new Promise<string>((resolve) => {
            setPasteValue("");
            setPasteResolve(() => resolve);
          }),
        onStatus: (msg) => setStatusLines((l) => [...l, msg]),
      });
      saveCred(spec.id, cred);
      finish({ providerId: spec.id, method: "oauth" });
    } catch (err) {
      setStatusLines((l) => [...l, `Login failed: ${err instanceof Error ? err.message : String(err)}`]);
      // Stay on busy so the user can read the error; Esc cancels.
    }
  };

  const startApiKey = (spec: ProviderSpec): void => {
    setStage("busy");
    const envHint = spec.envKeys.filter((k) => !k.includes("OAUTH")).join(" or ");
    setStatusLines(
      [
        `Paste API key for ${spec.name}`,
        envHint ? `(env fallback: ${envHint})` : "",
        "Stored in ~/.devcode/auth.json (mode 0600). Enter to save, Esc cancel.",
      ].filter(Boolean),
    );
    setPasteValue("");
    setPasteResolve(() => (raw: string) => {
      const key = raw.trim();
      if (!key) {
        setStatusLines((l) => [...l, "Empty key — login cancelled"]);
        finish(null);
        return;
      }
      saveCred(spec.id, { type: "api", key });
      finish({ providerId: spec.id, method: "api" });
    });
  };

  const pickMethod = (spec: ProviderSpec, method: { id: "oauth" | "api" } | undefined): void => {
    if (!method) return;
    if (method.id === "oauth") void runOAuth(spec);
    else startApiKey(spec);
  };

  const pickProvider = (row: ProviderRow): void => {
    const spec = row.spec;
    setSelected(spec);
    const next = methodsFor(spec);
    if (next.length === 1) {
      pickMethod(spec, next[0]);
    } else {
      setMethodIndex(0);
      setStage("method");
    }
  };

  useInput((input, key) => {
    // Provider stage input is owned by ProviderPicker / SearchablePicker.
    if (stage === "provider") return;

    if (key.escape) {
      if (pasteResolve) {
        pasteResolve("");
        setPasteResolve(null);
        finish(null);
        return;
      }
      if (stage === "method") {
        setStage("provider");
        setSelected(null);
        return;
      }
      finish(null);
      return;
    }

    if (pasteResolve) {
      if (key.return) {
        const resolve = pasteResolve;
        setPasteResolve(null);
        const value = pasteValue;
        setPasteValue("");
        resolve(value);
      } else if (key.backspace || key.delete) setPasteValue((v) => v.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setPasteValue((v) => v + input);
      return;
    }

    if (stage === "method" && selected) {
      if (key.upArrow) setMethodIndex((i) => (i + methods.length - 1) % Math.max(1, methods.length));
      else if (key.downArrow) setMethodIndex((i) => (i + 1) % Math.max(1, methods.length));
      else if (key.leftArrow) {
        setStage("provider");
        setSelected(null);
      } else if (key.return) pickMethod(selected, methods[methodIndex]);
    } else if (stage === "busy" && key.return && !pasteResolve) {
      // After a failed OAuth, Enter returns to method/provider picker.
      doneRef.current = false;
      setStatusLines([]);
      setStage(methods.length > 1 ? "method" : "provider");
    }
  });

  if (stage === "provider") {
    return (
      <ProviderPicker
        theme={t}
        providers={list}
        currentId={initialProviderId}
        title="Log in to a provider"
        onPick={pickProvider}
        onCancel={() => finish(null)}
      />
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.border} paddingX={1}>
      {stage === "method" && selected ? (
        <Box flexDirection="column">
          <Text bold color={t.accent}>
            Log in to <Text color={t.highlight}>{selected.name}</Text>
          </Text>
          <Text color={t.muted}>{selected.id}</Text>
          {selected.oauth?.tosWarning ? (
            <Text color={t.warn}>
              ⚠ Subscription OAuth reuses a first-party client and may violate the provider&apos;s ToS. API keys are the
              sanctioned path.
            </Text>
          ) : null}
          {methods.length === 0 ? <Text color={t.error}>No login methods configured for this provider.</Text> : null}
          {methods.map((m, i) => (
            <Text key={m.id} color={i === methodIndex ? t.accent : t.text} bold={i === methodIndex}>
              {i === methodIndex ? "❯ " : "  "}
              {m.label}
            </Text>
          ))}
          <Text color={t.muted}>↑/↓ select · Enter choose · ← back · Esc cancel</Text>
        </Box>
      ) : null}
      {stage === "busy" ? (
        <Box flexDirection="column">
          <Text bold color={t.accent}>
            {selected ? selected.name : "Login"}
          </Text>
          {statusLines.map((line, i) => (
            <Text key={i} color={i === 0 ? t.text : t.muted}>
              {line}
            </Text>
          ))}
          {pasteResolve ? (
            <Text>
              {"> "}
              {"*".repeat(Math.min(pasteValue.length, 48))}
              {pasteValue.length > 48 ? "…" : ""}
              <Text color={t.muted}>{pasteValue.length === 0 ? " (paste key / code, then Enter)" : ""}</Text>
            </Text>
          ) : (
            <Text color={t.muted}>Esc cancel · Enter to go back after an error</Text>
          )}
        </Box>
      ) : null}
    </Box>
  );
}
