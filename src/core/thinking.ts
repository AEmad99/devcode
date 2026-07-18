/** Thinking / reasoning effort levels (Claude, OpenAI o-series, Grok, …). */
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high", "max"];

export function parseThinkingLevel(raw: string | undefined): ThinkingLevel | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if ((THINKING_LEVELS as string[]).includes(v)) return v as ThinkingLevel;
  // aliases
  if (v === "none" || v === "0") return "off";
  if (v === "min" || v === "minimal") return "low";
  if (v === "mid" || v === "default" || v === "normal") return "medium";
  if (v === "full" || v === "ultra") return "max";
  return undefined;
}

export interface ThinkingCapability {
  supported: boolean;
  /** Provider wire format hint */
  kind: "anthropic" | "openai" | "google" | "xai" | "unknown" | "none";
  /** Why we think it supports (or not) */
  reason: string;
}

/**
 * Detect whether a model id is known to support extended thinking / reasoning.
 * Heuristic on model name — catalogs drift; prefer over-enabling and letting the API reject.
 */
export function detectThinking(model: string, providerId?: string): ThinkingCapability {
  const m = model.toLowerCase();
  const p = (providerId ?? "").toLowerCase();

  // Explicit non-thinking
  if (m.includes("haiku") && !m.includes("thinking")) {
    return { supported: false, kind: "none", reason: "Haiku models typically lack extended thinking" };
  }
  if (m.includes("instant") || m.includes("lite") && !m.includes("thinking")) {
    return { supported: false, kind: "none", reason: "Lightweight model — no thinking tier" };
  }

  // Anthropic Claude 4+ / thinking variants
  if (m.includes("claude") || p === "anthropic") {
    if (m.includes("opus") || m.includes("sonnet") || m.includes("thinking") || m.includes("fable")) {
      return { supported: true, kind: "anthropic", reason: "Claude extended thinking" };
    }
    return { supported: false, kind: "anthropic", reason: "Claude model without thinking support" };
  }

  // OpenAI o-series / gpt-5 reasoning
  if (
    /^o[1-9]/.test(m) ||
    m.includes("o1-") ||
    m.includes("o3") ||
    m.includes("o4") ||
    m.includes("gpt-5") ||
    m.includes("codex") ||
    m.includes("reason")
  ) {
    return { supported: true, kind: "openai", reason: "OpenAI reasoning model" };
  }

  // DeepSeek reasoner
  if (m.includes("reasoner") || m.includes("r1") || m.includes("deepseek-r")) {
    return { supported: true, kind: "openai", reason: "DeepSeek reasoner" };
  }

  // Google Gemini thinking / 2.5
  if (m.includes("gemini") && (m.includes("2.5") || m.includes("thinking") || m.includes("exp"))) {
    return { supported: true, kind: "google", reason: "Gemini thinking" };
  }

  // xAI Grok
  if (m.includes("grok") || p === "xai") {
    if (m.includes("mini") && !m.includes("reason")) {
      return { supported: false, kind: "xai", reason: "Grok mini — no thinking" };
    }
    return { supported: true, kind: "xai", reason: "Grok reasoning" };
  }

  // Kimi / Moonshot thinking
  if (m.includes("thinking") || m.includes("k2p") || m.includes("k3")) {
    return { supported: true, kind: "anthropic", reason: "Kimi / thinking-tagged model" };
  }

  // Explicit thinking in name
  if (m.includes("thinking") || m.includes("reason")) {
    return { supported: true, kind: "unknown", reason: "Model name suggests thinking" };
  }

  return { supported: false, kind: "none", reason: "No thinking signal in model id" };
}

/** Anthropic budget_tokens for each level (rough). */
export function anthropicBudget(level: ThinkingLevel): number | null {
  switch (level) {
    case "off":
      return null;
    case "low":
      return 4_000;
    case "medium":
      return 10_000;
    case "high":
      return 32_000;
    case "max":
      return 64_000;
  }
}

/** OpenAI reasoning.effort for each level. */
export function openaiEffort(level: ThinkingLevel): "low" | "medium" | "high" | null {
  switch (level) {
    case "off":
      return null;
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "max":
      return "high";
  }
}

export function thinkingLabel(level: ThinkingLevel, cap: ThinkingCapability): string {
  if (level === "off" || !cap.supported) return "thinking:off";
  return `thinking:${level}`;
}
