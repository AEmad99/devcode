/**
 * Context windows and rough rate-limit hints per provider/model.
 * Prefer live numbers from the models.dev cache (limit.context / limit.output);
 * fall back to static provider/model heuristics when the catalog misses.
 */

import { lookupModelLimits } from "../providers/models.js";

export interface LimitInfo {
  /** Context window tokens */
  contextWindow: number;
  /** Optional output cap */
  maxOutput?: number;
  /** Human-readable rate limit note */
  rateLimit?: string;
  /** Source of the numbers */
  note?: string;
}

const DEFAULT: LimitInfo = {
  contextWindow: 128_000,
  maxOutput: 16_384,
  rateLimit: "see provider dashboard",
  note: "heuristic default",
};

/** Provider-level defaults (used when models.dev has no match) */
const BY_PROVIDER: Record<string, LimitInfo> = {
  anthropic: { contextWindow: 200_000, maxOutput: 64_000, rateLimit: "tier-based (RPM/ITPM on console.anthropic.com)" },
  openai: { contextWindow: 128_000, maxOutput: 16_384, rateLimit: "tier-based (platform.openai.com/settings/organization/limits)" },
  "openai-codex": { contextWindow: 200_000, maxOutput: 32_000, rateLimit: "ChatGPT plan usage limits" },
  google: { contextWindow: 1_000_000, maxOutput: 65_536, rateLimit: "Gemini API free/paid quotas" },
  copilot: { contextWindow: 128_000, maxOutput: 16_384, rateLimit: "Copilot subscription + premium request quotas" },
  openrouter: { contextWindow: 128_000, maxOutput: 16_384, rateLimit: "varies by model + OpenRouter credits" },
  xai: { contextWindow: 131_072, maxOutput: 32_768, rateLimit: "xAI API rate limits" },
  deepseek: { contextWindow: 128_000, maxOutput: 8_192, rateLimit: "DeepSeek API rate limits" },
  minimax: { contextWindow: 204_800, maxOutput: 131_072, rateLimit: "MiniMax coding plan / API quotas" },
  "minimax-cn": { contextWindow: 204_800, maxOutput: 131_072, rateLimit: "MiniMax CN quotas" },
  "kimi-coding": { contextWindow: 262_144, maxOutput: 32_768, rateLimit: "Kimi for Coding plan limits" },
  moonshotai: { contextWindow: 262_144, maxOutput: 8_192, rateLimit: "Moonshot API limits" },
  groq: { contextWindow: 128_000, maxOutput: 8_192, rateLimit: "Groq free/dev RPM limits" },
  cerebras: { contextWindow: 64_000, maxOutput: 8_192, rateLimit: "Cerebras API limits" },
  mistral: { contextWindow: 128_000, maxOutput: 16_384, rateLimit: "Mistral API tier limits" },
  together: { contextWindow: 128_000, maxOutput: 8_192, rateLimit: "Together AI rate limits" },
  fireworks: { contextWindow: 128_000, maxOutput: 8_192, rateLimit: "Fireworks rate limits" },
  huggingface: { contextWindow: 32_000, maxOutput: 4_096, rateLimit: "HF Inference rate limits" },
  nvidia: { contextWindow: 128_000, maxOutput: 4_096, rateLimit: "NVIDIA NIM rate limits" },
  opencode: { contextWindow: 200_000, maxOutput: 32_000, rateLimit: "OpenCode Zen plan" },
  "opencode-go": { contextWindow: 128_000, maxOutput: 16_384, rateLimit: "OpenCode Go plan" },
  zai: { contextWindow: 128_000, maxOutput: 16_384, rateLimit: "ZAI coding plan" },
  "zai-coding-cn": { contextWindow: 128_000, maxOutput: 16_384, rateLimit: "ZAI CN coding plan" },
  "amazon-bedrock": { contextWindow: 200_000, maxOutput: 32_000, rateLimit: "AWS account service quotas" },
  "google-vertex": { contextWindow: 1_000_000, maxOutput: 65_536, rateLimit: "GCP project quotas" },
  "azure-openai-responses": { contextWindow: 128_000, maxOutput: 16_384, rateLimit: "Azure OpenAI deployment quotas" },
  "cloudflare-workers-ai": { contextWindow: 32_000, maxOutput: 4_096, rateLimit: "Workers AI quotas" },
  "cloudflare-ai-gateway": { contextWindow: 128_000, maxOutput: 16_384, rateLimit: "AI Gateway + upstream limits" },
  "vercel-ai-gateway": { contextWindow: 128_000, maxOutput: 16_384, rateLimit: "Vercel AI Gateway limits" },
  radius: { contextWindow: 200_000, maxOutput: 32_000, rateLimit: "Radius gateway plan" },
};

/**
 * Model-id heuristic overrides (substring match, first hit wins).
 * Only used when models.dev has no entry for the model.
 */
const BY_MODEL: { match: RegExp; info: Partial<LimitInfo> }[] = [
  { match: /claude-(opus|sonnet).*4-[6-9]|claude-(opus|sonnet).*4\.[6-9]/i, info: { contextWindow: 1_000_000, maxOutput: 128_000 } },
  { match: /claude-(opus|sonnet)/i, info: { contextWindow: 200_000, maxOutput: 64_000 } },
  { match: /claude-haiku/i, info: { contextWindow: 200_000, maxOutput: 8_192 } },
  { match: /gpt-5\.5|gpt-5\.4|gpt-5-codex/i, info: { contextWindow: 400_000, maxOutput: 128_000 } },
  { match: /gpt-5|o3|o4/i, info: { contextWindow: 200_000, maxOutput: 32_000 } },
  { match: /gpt-4\.1|gpt-4o/i, info: { contextWindow: 128_000, maxOutput: 16_384 } },
  { match: /gemini.*3|gemini.*2\.5|gemini.*pro/i, info: { contextWindow: 1_000_000, maxOutput: 65_536 } },
  { match: /gemini.*flash/i, info: { contextWindow: 1_000_000, maxOutput: 65_536 } },
  { match: /minimax|m2\.7|m2\.5|m3/i, info: { contextWindow: 204_800, maxOutput: 131_072 } },
  { match: /kimi|k2p7|k2\.7|k3/i, info: { contextWindow: 262_144, maxOutput: 32_768 } },
  { match: /deepseek/i, info: { contextWindow: 1_000_000, maxOutput: 64_000 } },
  { match: /grok-4|grok-3/i, info: { contextWindow: 256_000, maxOutput: 32_768 } },
  { match: /grok/i, info: { contextWindow: 131_072, maxOutput: 32_768 } },
];

function heuristicLimits(providerId: string, model?: string): LimitInfo {
  const base: LimitInfo = {
    ...DEFAULT,
    ...(BY_PROVIDER[providerId] ?? {}),
    note: "heuristic default",
  };
  if (model) {
    for (const row of BY_MODEL) {
      if (row.match.test(model)) {
        return { ...base, ...row.info, note: "heuristic model match" };
      }
    }
  }
  return base;
}

/**
 * Resolve context/output limits for a provider+model.
 * Priority: models.dev cache → static model regex → provider default → 128k.
 */
export function getLimits(providerId: string, model?: string): LimitInfo {
  const catalog = lookupModelLimits(providerId, model);
  const base = heuristicLimits(providerId, model);
  if (catalog) {
    return {
      ...base,
      contextWindow: catalog.contextWindow,
      maxOutput: catalog.maxOutput ?? base.maxOutput,
      note: "models.dev",
    };
  }
  return base;
}

/** Format used/limit for the status bar, e.g. "12.4k/200k 6%" */
export function formatContextUsage(usedTokens: number, window: number): string {
  const pct = window > 0 ? Math.min(100, Math.round((usedTokens / window) * 100)) : 0;
  const u = usedTokens >= 1000 ? `${(usedTokens / 1000).toFixed(1)}k` : String(usedTokens);
  const w = window >= 1000 ? `${Math.round(window / 1000)}k` : String(window);
  return `${u}/${w} ${pct}%`;
}

export function formatLimitsReport(providerId: string, model: string): string {
  const lim = getLimits(providerId, model);
  const source =
    lim.note === "models.dev"
      ? "Source:   models.dev catalog (cached in ~/.devcode/models.json)"
      : `Source:   ${lim.note ?? "heuristic defaults"} (models.dev miss or offline)`;
  const lines = [
    `Provider: ${providerId}`,
    `Model:    ${model}`,
    `Context:  ${lim.contextWindow.toLocaleString()} tokens`,
    lim.maxOutput ? `Max out:  ${lim.maxOutput.toLocaleString()} tokens` : null,
    lim.rateLimit ? `Rate:     ${lim.rateLimit}` : null,
    source,
    "",
    "Context windows come from models.dev when available; rate limits are best-effort.",
  ];
  return lines.filter((l) => l !== null).join("\n");
}
