import { AnthropicProvider } from "./anthropic.js";
import { REFRESH_FNS } from "./auth/flows.js";
import { getCred, getValidOAuth, type OAuthCred } from "./auth/storage.js";
import {
  expandUrlTemplate,
  PI_API_CATALOG,
  resolveAzureResponsesUrl,
  type CatalogEntry,
} from "./catalog.js";
import { CFG } from "./config.js";
import { CopilotProvider } from "./copilot.js";
import {
  AnthropicCompatProvider,
  ChatCompletionsProvider,
  ResponsesCompatProvider,
} from "./generic.js";
import { GoogleProvider } from "./google.js";
import type { FetchImpl } from "./openai.js";
import { OpenAIProvider } from "./openai.js";
import { OpenAICodexProvider } from "./openai-codex.js";
import type { Provider } from "./types.js";

export type ResolvedAuth =
  | { kind: "env" }
  | { kind: "apiKey"; key: string }
  | { kind: "oauth"; cred: OAuthCred; getAuth: () => Promise<OAuthCred> }
  | { kind: "none" };

export interface ProviderSpec {
  id: string;
  name: string;
  defaultModel: string;
  envKeys: string[];
  /** When true (default), /login offers "Paste API key". */
  apiKey?: boolean;
  oauth?: { flowId: keyof typeof REFRESH_FNS; tosWarning?: boolean; label?: string };
  create(auth: ResolvedAuth, opts?: { model?: string; fetchImpl?: FetchImpl }): Provider;
}

function oauthAuth(providerId: string, flowId: keyof typeof REFRESH_FNS): ResolvedAuth {
  const cred = getCred(providerId);
  if (!cred || cred.type !== "oauth") return { kind: "none" };
  const getAuth = async (): Promise<OAuthCred> => {
    await getValidOAuth(providerId, (c) => REFRESH_FNS[flowId](c));
    return getCred(providerId) as OAuthCred;
  };
  return { kind: "oauth", cred, getAuth };
}

function apiKeyFrom(auth: ResolvedAuth, envKeys: string[]): string | undefined {
  if (auth.kind === "apiKey") return auth.key;
  for (const k of envKeys) {
    const v = process.env[k];
    if (v) return v;
  }
  return undefined;
}

function requireKey(auth: ResolvedAuth, envKeys: string[], id: string): string {
  const key = apiKeyFrom(auth, envKeys);
  if (!key) {
    throw new Error(`${id}: no API key. Pass via /login ${id} or set ${envKeys.join(" / ")}.`);
  }
  return key;
}

function createFromCatalog(entry: CatalogEntry, auth: ResolvedAuth, opts?: { model?: string; fetchImpl?: FetchImpl }): Provider {
  const key = requireKey(auth, entry.envKeys, entry.id);
  for (const req of entry.requiredEnv ?? []) {
    if (!process.env[req]) throw new Error(`${entry.id}: missing required env ${req}`);
  }
  const model = opts?.model ?? entry.defaultModel;
  const fetchImpl = opts?.fetchImpl;

  if (entry.protocol === "openai-responses") {
    const url = entry.id === "azure-openai-responses" ? resolveAzureResponsesUrl() : expandUrlTemplate(entry.url);
    return new ResponsesCompatProvider({
      id: entry.id,
      url,
      apiKey: key,
      model,
      authHeader: entry.authHeader === "api-key" ? "api-key" : "bearer",
      fetchImpl,
    });
  }

  if (entry.protocol === "anthropic-messages") {
    const base = entry.anthropicBaseUrl ?? expandUrlTemplate(entry.url);
    return new AnthropicCompatProvider({
      id: entry.id,
      baseUrl: base,
      apiKey: key,
      model,
      authStyle: entry.authHeader === "x-api-key" ? "x-api-key" : "bearer",
      fetchImpl,
    });
  }

  // openai-completions
  const url = expandUrlTemplate(entry.url);
  return new ChatCompletionsProvider({
    id: entry.id,
    url,
    apiKey: key,
    model,
    authHeader: entry.authHeader,
    fetchImpl,
    extraHeaders: entry.headers,
  });
}

function catalogSpec(entry: CatalogEntry): ProviderSpec {
  return {
    id: entry.id,
    name: entry.name,
    defaultModel: entry.defaultModel,
    envKeys: entry.envKeys,
    apiKey: true,
    create: (auth, opts) => createFromCatalog(entry, auth, opts),
  };
}

// --- First-class / OAuth / special providers (not pure catalog) ---

const SPECIALS: ProviderSpec[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    defaultModel: CFG.anthropic.defaultModel,
    envKeys: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    apiKey: true,
    oauth: { flowId: "anthropic", tosWarning: true, label: "Claude Pro/Max (OAuth)" },
    create: (auth, opts) => {
      if (auth.kind === "oauth") return new AnthropicProvider({ oauthToken: auth.cred.access, model: opts?.model, oauthBeta: true });
      if (auth.kind === "apiKey") return new AnthropicProvider({ apiKey: auth.key, model: opts?.model });
      return new AnthropicProvider({ model: opts?.model });
    },
  },
  {
    id: "openai-codex",
    name: "OpenAI Codex (ChatGPT)",
    defaultModel: CFG.openaiCodex.defaultModel,
    envKeys: [],
    apiKey: false,
    oauth: { flowId: "openai", tosWarning: true, label: "ChatGPT / Codex (OAuth)" },
    create: (auth, opts) => {
      if (auth.kind !== "oauth") throw new Error("OpenAI Codex requires OAuth — run /login openai-codex");
      return new OpenAICodexProvider({
        getAuth: auth.getAuth,
        accountId: auth.cred.accountId,
        model: opts?.model,
        fetchImpl: opts?.fetchImpl,
      });
    },
  },
  {
    id: "openai",
    name: "OpenAI (API key)",
    defaultModel: CFG.openai.defaultModel,
    envKeys: ["OPENAI_API_KEY"],
    apiKey: true,
    create: (auth, opts) =>
      new OpenAIProvider({
        apiKey: apiKeyFrom(auth, ["OPENAI_API_KEY"]),
        model: opts?.model,
        fetchImpl: opts?.fetchImpl,
      }),
  },
  {
    id: "google",
    name: "Google Gemini",
    defaultModel: CFG.google.defaultModel,
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    apiKey: true,
    oauth: { flowId: "google", label: "Google account (OAuth)" },
    create: (auth, opts) => {
      if (auth.kind === "oauth") {
        return new GoogleProvider({
          oauth: auth.getAuth,
          projectId: auth.cred.projectId,
          model: opts?.model,
          fetchImpl: opts?.fetchImpl,
        });
      }
      return new GoogleProvider({
        apiKey: apiKeyFrom(auth, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
        model: opts?.model,
        fetchImpl: opts?.fetchImpl,
      });
    },
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    defaultModel: CFG.copilot.defaultModel,
    envKeys: ["COPILOT_GITHUB_TOKEN"],
    apiKey: false,
    oauth: { flowId: "copilot", label: "GitHub device login (OAuth)" },
    create: (auth, opts) => {
      // Ambient COPILOT_GITHUB_TOKEN can stand in as OAuth refresh via env — still needs OAuth-shaped cred.
      if (auth.kind !== "oauth") throw new Error("GitHub Copilot requires OAuth — run /login copilot");
      return new CopilotProvider({ getAuth: auth.getAuth, model: opts?.model, fetchImpl: opts?.fetchImpl });
    },
  },
];

// Avoid duplicate ids if catalog ever overlaps specials.
const specialIds = new Set(SPECIALS.map((s) => s.id));
const catalogSpecs = PI_API_CATALOG.filter((e) => !specialIds.has(e.id)).map(catalogSpec);

// Order: specials first (OAuth + big names), then full pi catalog alphabetically by name for /login UX.
catalogSpecs.sort((a, b) => a.name.localeCompare(b.name));

export const REGISTRY: ProviderSpec[] = [...SPECIALS, ...catalogSpecs];

export type AuthState = "env" | "oauth" | "key" | "none";

export function supportsApiKey(spec: ProviderSpec): boolean {
  return spec.apiKey !== false;
}

export function authMethodsLabel(spec: ProviderSpec): string {
  const parts: string[] = [];
  if (spec.oauth) parts.push("oauth");
  if (supportsApiKey(spec)) parts.push("key");
  return parts.join("+") || "—";
}

export function authState(spec: ProviderSpec): AuthState {
  if (spec.envKeys.some((k) => process.env[k])) return "env";
  const cred = getCred(spec.id);
  if (cred?.type === "oauth") return "oauth";
  if (cred?.type === "api") return "key";
  return "none";
}

export function resolveAuth(id: string): ResolvedAuth {
  const spec = REGISTRY.find((s) => s.id === id);
  if (!spec) return { kind: "none" };
  if (spec.envKeys.some((k) => process.env[k])) return { kind: "env" };
  if (spec.oauth) {
    const oauth = oauthAuth(id, spec.oauth.flowId);
    if (oauth.kind === "oauth") return oauth;
  }
  const cred = getCred(id);
  if (cred?.type === "api") return { kind: "apiKey", key: cred.key };
  return { kind: "none" };
}

export function makeProvider(id: string, opts?: { model?: string; fetchImpl?: FetchImpl }): Provider {
  const spec = REGISTRY.find((s) => s.id === id);
  if (!spec) throw new Error(`Unknown provider: ${id}. Try /provider for the full list.`);
  return spec.create(resolveAuth(id), opts);
}

export function listProviders(): { spec: ProviderSpec; auth: AuthState }[] {
  return REGISTRY.map((spec) => ({ spec, auth: authState(spec) }));
}

export function getProviderSpec(id: string): ProviderSpec | undefined {
  return REGISTRY.find((s) => s.id === id);
}

/**
 * Pick the provider to use on startup.
 * Preference: explicit CLI flag → last saved provider (always, even if auth is none so login can fix it)
 * → first provider that already has auth → anthropic.
 */
export function preferredProviderId(explicit?: string, saved?: string): string {
  if (explicit && REGISTRY.some((s) => s.id === explicit)) return explicit;
  if (saved && REGISTRY.some((s) => s.id === saved)) return saved;
  return listProviders().find((p) => p.auth !== "none")?.spec.id ?? "anthropic";
}

export async function refreshStoredOAuth(id: string): Promise<void> {
  const spec = REGISTRY.find((s) => s.id === id);
  const cred = getCred(id);
  if (!spec?.oauth || !cred || cred.type !== "oauth" || cred.expires > Date.now()) return;
  try {
    await getValidOAuth(id, (c) => REFRESH_FNS[spec.oauth!.flowId](c));
  } catch {
    // cleared already
  }
}

/** Fallback model lists for models.dev offline mode (specials + catalog). */
export function catalogFallbacks(): Record<string, { id: string; name: string }[]> {
  const out: Record<string, { id: string; name: string }[]> = {
    anthropic: [...CFG.anthropic.fallbackModels],
    openai: [...CFG.openai.fallbackModels],
    "openai-codex": [...CFG.openaiCodex.fallbackModels],
    google: [...CFG.google.fallbackModels],
    copilot: [...CFG.copilot.fallbackModels],
  };
  for (const e of PI_API_CATALOG) out[e.id] = [...e.fallbackModels];
  return out;
}
