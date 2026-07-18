/**
 * Built-in provider catalog aligned with pi (earendil-works/pi) providers.md.
 * Most entries are OpenAI Chat Completions or Anthropic Messages–compatible.
 * Special cases (native Anthropic, Codex OAuth, Google, Copilot) stay in registry.ts.
 */

export type Protocol = "openai-completions" | "anthropic-messages" | "openai-responses";

export type AuthHeader = "bearer" | "api-key" | "x-api-key" | "cf-aig";

export interface CatalogEntry {
  id: string;
  name: string;
  /** Env vars that can supply the API key (first match wins). */
  envKeys: string[];
  protocol: Protocol;
  /**
   * Absolute chat/messages/responses URL, or a template with `{ENV}` placeholders
   * replaced from process.env at create time.
   */
  url: string;
  defaultModel: string;
  fallbackModels: { id: string; name: string }[];
  authHeader?: AuthHeader;
  /** Extra static headers. */
  headers?: Record<string, string>;
  /** For anthropic-messages: base URL without /v1/messages. */
  anthropicBaseUrl?: string;
  /** Extra env vars required (account ids, gateway ids, …). */
  requiredEnv?: string[];
  notes?: string;
}

const m = (id: string, name?: string) => ({ id, name: name ?? id });

/** All pi API-key providers that we can drive with thin fetch adapters. */
export const PI_API_CATALOG: CatalogEntry[] = [
  // --- already had some of these; unified here for fallbacks ---
  {
    id: "deepseek",
    name: "DeepSeek",
    envKeys: ["DEEPSEEK_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.deepseek.com/chat/completions",
    defaultModel: "deepseek-chat",
    fallbackModels: [m("deepseek-chat", "DeepSeek Chat"), m("deepseek-reasoner", "DeepSeek Reasoner"), m("deepseek-v4-flash")],
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    envKeys: ["XAI_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.x.ai/v1/chat/completions",
    defaultModel: "grok-3",
    fallbackModels: [m("grok-3", "Grok 3"), m("grok-4.5", "Grok 4.5"), m("grok-3-mini", "Grok 3 Mini")],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envKeys: ["OPENROUTER_API_KEY"],
    protocol: "openai-completions",
    url: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "anthropic/claude-sonnet-4.5",
    fallbackModels: [
      m("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5"),
      m("openai/gpt-5", "GPT-5"),
      m("google/gemini-2.5-pro", "Gemini 2.5 Pro"),
    ],
    headers: { "HTTP-Referer": "https://devcode.local", "X-Title": "DevCode" },
  },

  // --- pi API-key list ---
  {
    id: "ant-ling",
    name: "Ant Ling",
    envKeys: ["ANT_LING_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.ant-ling.com/v1/chat/completions",
    defaultModel: "Ling-2.6-flash",
    fallbackModels: [m("Ling-2.6-flash"), m("Ling-2.6-1T"), m("Ring-2.6-1T")],
  },
  {
    id: "azure-openai-responses",
    name: "Azure OpenAI (Responses)",
    envKeys: ["AZURE_OPENAI_API_KEY"],
    protocol: "openai-responses",
    // Resolved dynamically in registry (resource name / base URL).
    url: "azure",
    defaultModel: "gpt-4.1",
    fallbackModels: [m("gpt-4.1"), m("gpt-4o"), m("gpt-4")],
    authHeader: "api-key",
    requiredEnv: [], // either AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME
    notes: "Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    envKeys: ["NVIDIA_API_KEY"],
    protocol: "openai-completions",
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    defaultModel: "meta/llama-3.1-70b-instruct",
    fallbackModels: [m("meta/llama-3.1-70b-instruct"), m("meta/llama-3.1-8b-instruct")],
  },
  {
    id: "mistral",
    name: "Mistral",
    envKeys: ["MISTRAL_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.mistral.ai/v1/chat/completions",
    defaultModel: "mistral-large-latest",
    fallbackModels: [m("mistral-large-latest", "Mistral Large"), m("codestral-latest", "Codestral"), m("devstral-latest", "Devstral")],
  },
  {
    id: "groq",
    name: "Groq",
    envKeys: ["GROQ_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "llama-3.3-70b-versatile",
    fallbackModels: [m("llama-3.3-70b-versatile"), m("llama-3.1-8b-instant")],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    envKeys: ["CEREBRAS_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.cerebras.ai/v1/chat/completions",
    defaultModel: "gpt-oss-120b",
    fallbackModels: [m("gpt-oss-120b"), m("llama3.1-8b"), m("llama-3.3-70b")],
  },
  {
    id: "cloudflare-ai-gateway",
    name: "Cloudflare AI Gateway",
    envKeys: ["CLOUDFLARE_API_KEY"],
    protocol: "openai-completions",
    url: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat/chat/completions",
    defaultModel: "openai/gpt-4o",
    fallbackModels: [m("openai/gpt-4o"), m("anthropic/claude-sonnet-4-5")],
    authHeader: "cf-aig",
    requiredEnv: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
  },
  {
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    envKeys: ["CLOUDFLARE_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions",
    defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    fallbackModels: [m("@cf/meta/llama-3.3-70b-instruct-fp8-fast"), m("@cf/moonshotai/kimi-k2.6")],
    requiredEnv: ["CLOUDFLARE_ACCOUNT_ID"],
  },
  {
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    envKeys: ["AI_GATEWAY_API_KEY"],
    protocol: "openai-completions",
    url: "https://ai-gateway.vercel.sh/v1/chat/completions",
    defaultModel: "anthropic/claude-sonnet-4.5",
    fallbackModels: [m("anthropic/claude-sonnet-4.5"), m("openai/gpt-5")],
  },
  {
    id: "zai",
    name: "ZAI Coding Plan (Global)",
    envKeys: ["ZAI_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    defaultModel: "glm-4.7",
    fallbackModels: [m("glm-4.7"), m("glm-4.5-air"), m("glm-5-turbo")],
  },
  {
    id: "zai-coding-cn",
    name: "ZAI Coding Plan (China)",
    envKeys: ["ZAI_CODING_CN_API_KEY"],
    protocol: "openai-completions",
    url: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    defaultModel: "glm-4.7",
    fallbackModels: [m("glm-4.7"), m("glm-4.5-air"), m("glm-5-turbo")],
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    envKeys: ["OPENCODE_API_KEY"],
    protocol: "openai-completions",
    url: "https://opencode.ai/zen/v1/chat/completions",
    defaultModel: "claude-sonnet-4-5",
    fallbackModels: [m("claude-sonnet-4-5"), m("gpt-5"), m("big-pickle")],
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    envKeys: ["OPENCODE_API_KEY"],
    protocol: "openai-completions",
    url: "https://opencode.ai/zen/go/v1/chat/completions",
    defaultModel: "glm-5.1",
    fallbackModels: [m("glm-5.1"), m("deepseek-v4-flash"), m("deepseek-v4-pro")],
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    envKeys: ["HF_TOKEN"],
    protocol: "openai-completions",
    url: "https://router.huggingface.co/v1/chat/completions",
    defaultModel: "MiniMaxAI/MiniMax-M2",
    fallbackModels: [m("MiniMaxAI/MiniMax-M2"), m("Qwen/Qwen2.5-72B-Instruct")],
  },
  {
    id: "fireworks",
    name: "Fireworks",
    envKeys: ["FIREWORKS_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.fireworks.ai/inference/v1/chat/completions",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    fallbackModels: [
      m("accounts/fireworks/models/llama-v3p3-70b-instruct"),
      m("accounts/fireworks/models/deepseek-v4-flash"),
    ],
  },
  {
    id: "together",
    name: "Together AI",
    envKeys: ["TOGETHER_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.together.ai/v1/chat/completions",
    defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
    fallbackModels: [
      m("meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo"),
      m("Qwen/Qwen2.5-7B-Instruct-Turbo"),
    ],
  },
  {
    id: "kimi-coding",
    name: "Kimi For Coding",
    envKeys: ["KIMI_API_KEY"],
    protocol: "anthropic-messages",
    url: "https://api.kimi.com/coding",
    anthropicBaseUrl: "https://api.kimi.com/coding",
    defaultModel: "kimi-for-coding",
    fallbackModels: [m("kimi-for-coding"), m("k3"), m("k2p7")],
    authHeader: "bearer",
  },
  {
    id: "minimax",
    name: "MiniMax",
    envKeys: ["MINIMAX_API_KEY"],
    protocol: "anthropic-messages",
    url: "https://api.minimax.io/anthropic",
    anthropicBaseUrl: "https://api.minimax.io/anthropic",
    defaultModel: "MiniMax-M2.7",
    fallbackModels: [m("MiniMax-M2.7"), m("MiniMax-M3"), m("MiniMax-M2.7-highspeed")],
    authHeader: "bearer",
  },
  {
    id: "minimax-cn",
    name: "MiniMax (China)",
    envKeys: ["MINIMAX_CN_API_KEY"],
    protocol: "anthropic-messages",
    url: "https://api.minimaxi.com/anthropic",
    anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
    defaultModel: "MiniMax-M2.7",
    fallbackModels: [m("MiniMax-M2.7"), m("MiniMax-M3")],
    authHeader: "bearer",
  },
  {
    id: "moonshotai",
    name: "Moonshot AI (Kimi)",
    envKeys: ["MOONSHOT_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.moonshot.ai/v1/chat/completions",
    defaultModel: "kimi-k2-0905-preview",
    fallbackModels: [m("kimi-k2-0905-preview"), m("kimi-k2-thinking"), m("kimi-k2-0711-preview")],
  },
  {
    id: "moonshotai-cn",
    name: "Moonshot AI China",
    envKeys: ["MOONSHOT_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.moonshot.cn/v1/chat/completions",
    defaultModel: "kimi-k2-0905-preview",
    fallbackModels: [m("kimi-k2-0905-preview"), m("kimi-k2-thinking")],
  },
  {
    id: "xiaomi",
    name: "Xiaomi MiMo",
    envKeys: ["XIAOMI_API_KEY"],
    protocol: "openai-completions",
    url: "https://api.xiaomimimo.com/v1/chat/completions",
    defaultModel: "mimo-v2-pro",
    fallbackModels: [m("mimo-v2-pro"), m("mimo-v2-flash"), m("mimo-v2-omni")],
  },
  {
    id: "xiaomi-token-plan-cn",
    name: "Xiaomi MiMo Token Plan (China)",
    envKeys: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
    protocol: "openai-completions",
    url: "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
    defaultModel: "mimo-v2-pro",
    fallbackModels: [m("mimo-v2-pro"), m("mimo-v2.5"), m("mimo-v2.5-pro")],
  },
  {
    id: "xiaomi-token-plan-ams",
    name: "Xiaomi MiMo Token Plan (Amsterdam)",
    envKeys: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
    protocol: "openai-completions",
    url: "https://token-plan-ams.xiaomimimo.com/v1/chat/completions",
    defaultModel: "mimo-v2-pro",
    fallbackModels: [m("mimo-v2-pro"), m("mimo-v2.5")],
  },
  {
    id: "xiaomi-token-plan-sgp",
    name: "Xiaomi MiMo Token Plan (Singapore)",
    envKeys: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
    protocol: "openai-completions",
    url: "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions",
    defaultModel: "mimo-v2-pro",
    fallbackModels: [m("mimo-v2-pro"), m("mimo-v2.5")],
  },
  {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    envKeys: ["AWS_BEARER_TOKEN_BEDROCK"],
    protocol: "openai-completions",
    // Bedrock's native stream is ConverseStream; many proxies expose OpenAI-compat.
    // Prefer AWS_ENDPOINT_URL_BEDROCK_RUNTIME when set; otherwise use bearer against a proxy.
    url: "{AWS_ENDPOINT_URL_BEDROCK_RUNTIME}/openai/v1/chat/completions",
    defaultModel: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    fallbackModels: [
      m("us.anthropic.claude-sonnet-4-20250514-v1:0", "Claude Sonnet 4 (Bedrock)"),
      m("amazon.nova-lite-v1:0", "Nova Lite"),
    ],
    notes: "Bearer token or set AWS_ENDPOINT_URL_BEDROCK_RUNTIME to an OpenAI-compatible proxy. Full AWS SDK auth is not bundled.",
  },
  {
    id: "google-vertex",
    name: "Google Vertex AI",
    envKeys: ["GOOGLE_CLOUD_API_KEY", "GEMINI_API_KEY"],
    protocol: "openai-completions",
    // OpenAI-compat endpoint on Vertex (when API key auth is enabled).
    url: "https://{GOOGLE_CLOUD_LOCATION}-aiplatform.googleapis.com/v1/projects/{GOOGLE_CLOUD_PROJECT}/locations/{GOOGLE_CLOUD_LOCATION}/endpoints/openapi/chat/completions",
    defaultModel: "google/gemini-2.5-pro",
    fallbackModels: [m("google/gemini-2.5-pro"), m("google/gemini-2.5-flash")],
    requiredEnv: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
    notes: "API key path. For ADC (gcloud auth application-default login) use the Google Gemini OAuth provider instead.",
  },
  {
    id: "radius",
    name: "Radius",
    envKeys: ["RADIUS_API_KEY"],
    protocol: "openai-completions",
    url: "{RADIUS_GATEWAY_URL}/v1/chat/completions",
    defaultModel: "default",
    fallbackModels: [m("default", "Gateway default")],
    notes: "Optional RADIUS_GATEWAY_URL (default https://radius.pi.dev). OAuth login not yet wired.",
  },
];

export function expandUrlTemplate(template: string): string {
  return template.replace(/\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    if (name === "RADIUS_GATEWAY_URL") {
      return (process.env.RADIUS_GATEWAY_URL ?? "https://radius.pi.dev").replace(/\/$/, "");
    }
    if (name === "AWS_ENDPOINT_URL_BEDROCK_RUNTIME") {
      const v = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
      if (!v) {
        throw new Error(
          "amazon-bedrock: set AWS_ENDPOINT_URL_BEDROCK_RUNTIME to an OpenAI-compatible Bedrock proxy, or use OpenRouter/Anthropic directly",
        );
      }
      return v.replace(/\/$/, "");
    }
    if (name === "GOOGLE_CLOUD_LOCATION") {
      return process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
    }
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env ${name} for provider URL`);
    return v;
  });
}

export function resolveAzureResponsesUrl(): string {
  let base = process.env.AZURE_OPENAI_BASE_URL?.replace(/\/$/, "");
  if (!base) {
    const resource = process.env.AZURE_OPENAI_RESOURCE_NAME;
    if (!resource) throw new Error("azure-openai-responses: set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME");
    base = `https://${resource}.openai.azure.com`;
  }
  // Accept resource root, /openai, or /openai/v1 — always land on .../openai/v1/responses
  if (base.endsWith("/responses")) return base;
  if (base.endsWith("/openai/v1")) return `${base}/responses`;
  if (base.endsWith("/openai")) return `${base}/v1/responses`;
  return `${base}/openai/v1/responses`;
}
