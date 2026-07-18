// All versioned provider strings: endpoints, client IDs, beta headers, UA strings.
// Pinned here so protocol drift is a one-file diff.

export const CFG = {
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    apiVersion: "2023-06-01",
    oauthBeta: "oauth-2025-04-20",
    defaultModel: "claude-sonnet-4-5",
    fallbackModels: [
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
    oauth: {
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://platform.claude.com/v1/oauth/token",
      clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      ports: [53692],
      callbackPath: "/callback",
      redirectUri: "http://localhost:53692/callback",
      scopes:
        "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    },
  },
  openai: {
    responsesUrl: "https://api.openai.com/v1/responses",
    defaultModel: "gpt-5",
    fallbackModels: [
      { id: "gpt-5", name: "GPT-5" },
      { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
      { id: "gpt-4.1", name: "GPT-4.1" },
    ],
  },
  openaiCodex: {
    responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
    defaultModel: "gpt-5.1-codex",
    fallbackModels: [
      { id: "gpt-5.1-codex", name: "GPT-5.1 Codex" },
      { id: "gpt-5", name: "GPT-5" },
    ],
    oauth: {
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      ports: [1455, 1457],
      callbackPath: "/auth/callback",
      redirectUri: "http://localhost:1455/auth/callback",
      scopes: "openid profile email offline_access",
      accountIdClaim: "https://api.openai.com/auth.chatgpt_account_id",
      accountIdClaimNamespace: "https://api.openai.com/auth",
      accountIdClaimName: "chatgpt_account_id",
      device: {
        usercodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
        tokenUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
        verificationUrl: "https://auth.openai.com/codex/device",
        deviceRedirectUri: "https://auth.openai.com/deviceauth/callback",
      },
    },
  },
  openrouter: {
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "anthropic/claude-sonnet-4.5",
    referer: "https://devcode.local",
    title: "DevCode",
    fallbackModels: [
      { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      { id: "openai/gpt-5", name: "GPT-5" },
      { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ],
  },
  copilot: {
    deviceCodeUrl: "https://github.com/login/device/code",
    accessTokenUrl: "https://github.com/login/oauth/access_token",
    tokenExchangeUrl: "https://api.github.com/copilot_internal/v2/token",
    clientId: "Iv1.b507a08c87ecfe98",
    scope: "read:user",
    defaultBaseUrl: "https://api.individual.githubcopilot.com",
    defaultModel: "gpt-4.1",
    headers: {
      "Editor-Version": "vscode/1.96.2",
      "Editor-Plugin-Version": "copilot-chat/0.26.7",
      "Copilot-Integration-Id": "vscode-chat",
      "User-Agent": "GitHubCopilotChat/0.35.0",
      "X-GitHub-Api-Version": "2025-04-01",
      "Openai-Intent": "conversation-edits",
    },
    fallbackModels: [
      { id: "gpt-4.1", name: "GPT-4.1" },
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    ],
  },
  google: {
    apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    codeAssistUrl: "https://cloudcode-pa.googleapis.com/v1internal",
    defaultModel: "gemini-2.5-pro",
    fallbackModels: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ],
    oauth: {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      // Do not hardcode OAuth client secrets in the repo (GitHub push protection).
      // Set DEVCODE_GOOGLE_OAUTH_CLIENT_ID / DEVCODE_GOOGLE_OAUTH_CLIENT_SECRET
      // (or GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET) before /login google.
      clientId: process.env.DEVCODE_GOOGLE_OAUTH_CLIENT_ID ?? process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      clientSecret:
        process.env.DEVCODE_GOOGLE_OAUTH_CLIENT_SECRET ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      callbackPath: "/oauth2callback",
      headlessRedirectUri: "https://codeassist.google.com/authcode",
      scopes: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
      ],
    },
  },
} as const;

export const MODELS_DEV_URL = "https://models.dev/api.json";
