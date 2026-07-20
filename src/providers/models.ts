import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "../core/paths.js";
import { MODELS_DEV_URL } from "./config.js";
import type { FetchImpl } from "./openai.js";
import { catalogFallbacks } from "./registry.js";

const TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelInfo {
  id: string;
  name: string;
  /** Context window tokens from models.dev (when known). */
  contextWindow?: number;
  /** Max output tokens from models.dev (when known). */
  maxOutput?: number;
}

export interface CatalogLimits {
  contextWindow: number;
  maxOutput?: number;
}

// Our provider id → models.dev catalog key.
const CATALOG_KEYS: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  "openai-codex": "openai",
  google: "google",
  copilot: "github-copilot",
  openrouter: "openrouter",
  "ollama-cloud": "ollama-cloud",
  xai: "xai",
  deepseek: "deepseek",
  minimax: "minimax",
  "minimax-cn": "minimax-cn",
  "azure-openai-responses": "azure",
  "amazon-bedrock": "amazon-bedrock",
  "google-vertex": "google-vertex",
  "kimi-coding": "kimi-for-coding",
  moonshotai: "moonshotai",
  "moonshotai-cn": "moonshotai-cn",
  opencode: "opencode",
  "opencode-go": "opencode-go",
  zai: "zhipuai",
  "zai-coding-cn": "zhipuai-coding-plan",
  huggingface: "huggingface",
  fireworks: "fireworks-ai",
  together: "togetherai",
  mistral: "mistral",
  groq: "groq",
  cerebras: "cerebras",
  nvidia: "nvidia",
  "cloudflare-workers-ai": "cloudflare-workers-ai",
  "cloudflare-ai-gateway": "cloudflare-ai-gateway",
  "vercel-ai-gateway": "vercel",
};

const cachePath = (): string => join(home(), "models.json");

function readCache(): { fetchedAt: number; data: any } | null {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8"));
  } catch {
    return null;
  }
}

/** Synchronous catalog data from disk cache (null if never fetched). */
export function readCatalogData(): any | null {
  return readCache()?.data ?? null;
}

export function catalogKeyFor(providerId: string): string {
  return CATALOG_KEYS[providerId] ?? providerId;
}

function parseLimit(raw: any): CatalogLimits | null {
  if (!raw || typeof raw !== "object") return null;
  const context = Number(raw.context ?? raw.contextWindow ?? raw.input);
  if (!Number.isFinite(context) || context <= 0) return null;
  const output = Number(raw.output ?? raw.maxOutput ?? raw.max_tokens);
  return {
    contextWindow: Math.floor(context),
    maxOutput: Number.isFinite(output) && output > 0 ? Math.floor(output) : undefined,
  };
}

function limitsFromModelEntry(entry: any): CatalogLimits | null {
  if (!entry || typeof entry !== "object") return null;
  return parseLimit(entry.limit ?? entry.limits ?? entry);
}

/** Normalize model ids for comparison: lowercase alphanumeric only. */
export function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Find a model entry in a models.dev provider.models map.
 * Tries exact → case-insensitive → normalized → date-stripped → longest contains.
 */
export function findModelEntry(models: Record<string, any> | undefined, modelId: string): any | null {
  if (!models || !modelId) return null;
  if (models[modelId] != null) return models[modelId];

  const lower = modelId.toLowerCase();
  const entries = Object.entries(models);
  for (const [id, m] of entries) {
    if (id.toLowerCase() === lower) return m;
  }

  const norm = normalizeModelId(modelId);
  if (!norm) return null;

  for (const [id, m] of entries) {
    if (normalizeModelId(id) === norm) return m;
  }

  // Strip trailing 8-digit date suffixes (e.g. claude-...-20250805)
  const stripDate = (s: string) => s.replace(/\d{8}$/, "");
  const normNoDate = stripDate(norm);
  for (const [id, m] of entries) {
    if (stripDate(normalizeModelId(id)) === normNoDate) return m;
  }

  // Contains match only for reasonably long ids to avoid "k2"/"o3" false hits
  if (norm.length < 6) return null;
  let best: { entry: any; score: number } | null = null;
  for (const [id, m] of entries) {
    const nid = normalizeModelId(id);
    if (nid.length < 6) continue;
    if (nid.includes(norm) || norm.includes(nid)) {
      const score = Math.min(nid.length, norm.length);
      if (!best || score > best.score) best = { entry: m, score };
    }
  }
  return best?.entry ?? null;
}

/**
 * Look up context/output limits for a provider+model from the models.dev cache.
 * Synchronous so StatusLine / getLimits stay free of async.
 */
export function lookupModelLimits(providerId: string, modelId?: string): CatalogLimits | null {
  if (!modelId) return null;
  const data = readCatalogData();
  if (!data) return null;

  const key = catalogKeyFor(providerId);
  const models = data[key]?.models as Record<string, any> | undefined;
  const hit = findModelEntry(models, modelId);
  const lim = limitsFromModelEntry(hit);
  if (lim) return lim;

  // OpenRouter-style ids often include a vendor prefix; try bare name under the same provider
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const bare = modelId.slice(slash + 1);
    const hit2 = findModelEntry(models, bare);
    const lim2 = limitsFromModelEntry(hit2);
    if (lim2) return lim2;
  }

  return null;
}

async function loadCatalog(fetchImpl: FetchImpl): Promise<any | null> {
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.data;
  try {
    const res = await fetchImpl(MODELS_DEV_URL);
    if (!res.ok) throw new Error(`models.dev ${res.status}`);
    const data = await res.json();
    writeFileSync(cachePath(), JSON.stringify({ fetchedAt: Date.now(), data }));
    return data;
  } catch {
    return cached?.data ?? null;
  }
}

export async function modelsFor(providerId: string, fetchImpl: FetchImpl = fetch): Promise<ModelInfo[]> {
  const data = await loadCatalog(fetchImpl);
  const key = catalogKeyFor(providerId);
  const models = data?.[key]?.models;
  if (models && typeof models === "object") {
    return Object.entries(models)
      .map(([id, m]: [string, any]) => {
        const lim = limitsFromModelEntry(m);
        return {
          id,
          name: typeof m?.name === "string" ? m.name : id,
          ...(lim
            ? { contextWindow: lim.contextWindow, maxOutput: lim.maxOutput }
            : {}),
        };
      })
      .slice(0, 50);
  }
  const fallbacks = catalogFallbacks();
  return fallbacks[providerId] ?? [];
}
