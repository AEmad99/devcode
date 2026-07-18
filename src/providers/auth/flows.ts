import { CFG } from "../config.js";
import type { FetchImpl } from "../openai.js";
import { extractJwtClaim, generatePKCE, parsePastedCode, pollDeviceFlow, withCallbackServer, type CallbackResult } from "./oauth.js";
import { expiryFromNow, type Cred, type OAuthCred } from "./storage.js";

export interface FlowOpts {
  openUrl: (url: string) => void;
  promptPaste: () => Promise<string>;
  onStatus: (msg: string) => void;
  headless?: boolean;
  fetchImpl?: FetchImpl;
}

export interface OAuthFlow {
  id: "anthropic" | "openai" | "google" | "copilot";
  start(opts: FlowOpts): Promise<Cred>;
}

type FlowId = OAuthFlow["id"];

async function postToken(
  url: string,
  fields: Record<string, string>,
  formEncoded: boolean,
  fetchImpl?: FetchImpl,
): Promise<any> {
  const res = await (fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: {
      "content-type": formEncoded ? "application/x-www-form-urlencoded" : "application/json",
      accept: "application/json",
    },
    body: formEncoded ? new URLSearchParams(fields).toString() : JSON.stringify(fields),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token request failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Race the loopback callback against a manual paste; empty paste cancels.
async function codeViaCallbackOrPaste(
  opts: FlowOpts,
  ports: readonly number[],
  path: string,
  buildUrl: (redirectUri: string) => string,
): Promise<{ code: string; state: string | null; redirectUri: string }> {
  return withCallbackServer(ports, path, async (redirectUri, waitForCode) => {
    const url = buildUrl(redirectUri);
    opts.onStatus(`Open this URL to log in:\n${url}`);
    opts.openUrl(url);
    opts.onStatus("Waiting for callback… (or paste the code/redirect URL into the login prompt)");
    const pasted = opts.promptPaste().then((raw): CallbackResult => {
      const { code, state } = parsePastedCode(raw);
      if (!code) throw new Error("Login cancelled");
      return { code, state: state ?? null };
    });
    const result = await Promise.race([waitForCode(), pasted]);
    return { ...result, redirectUri };
  });
}

export const anthropicFlow: OAuthFlow = {
  id: "anthropic",
  async start(opts) {
    const cfg = CFG.anthropic.oauth;
    const { verifier, challenge } = generatePKCE();
    const state = verifier;
    const { code } = await codeViaCallbackOrPaste(opts, cfg.ports, cfg.callbackPath, (redirectUri) => {
      const q = new URLSearchParams({
        code: "true",
        response_type: "code",
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        scope: cfg.scopes,
        code_challenge_method: "S256",
        code_challenge: challenge,
        state,
      });
      return `${cfg.authorizeUrl}?${q}`;
    });
    const json = await postToken(
      cfg.tokenUrl,
      { grant_type: "authorization_code", client_id: cfg.clientId, code, state, redirect_uri: cfg.redirectUri, code_verifier: verifier },
      false,
      opts.fetchImpl,
    );
    return { type: "oauth", access: json.access_token, refresh: json.refresh_token, expires: expiryFromNow(json.expires_in ?? 3600) };
  },
};

export function extractOpenAIAccountId(idToken?: string, accessToken?: string): string | undefined {
  const cfg = CFG.openaiCodex.oauth;
  for (const token of [idToken, accessToken]) {
    if (!token) continue;
    const dotted = extractJwtClaim(token, cfg.accountIdClaim);
    if (dotted) return dotted;
    const parts = token.split(".");
    if (parts.length < 2) continue;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      const nested = payload?.[cfg.accountIdClaimNamespace]?.[cfg.accountIdClaimName];
      if (nested) return nested;
    } catch {
      // not a JWT payload we can read
    }
  }
  return undefined;
}

export const openAIFlow: OAuthFlow = {
  id: "openai",
  async start(opts) {
    const cfg = CFG.openaiCodex.oauth;
    if (opts.headless) return openAIDeviceFlow(opts);
    const { verifier, challenge } = generatePKCE();
    const state = randomState();
    const { code } = await codeViaCallbackOrPaste(opts, cfg.ports, cfg.callbackPath, (redirectUri) => {
      const q = new URLSearchParams({
        response_type: "code",
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        scope: cfg.scopes,
        code_challenge_method: "S256",
        code_challenge: challenge,
        state,
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "devcode",
      });
      return `${cfg.authorizeUrl}?${q}`;
    });
    const json = await postToken(
      cfg.tokenUrl,
      { grant_type: "authorization_code", client_id: cfg.clientId, code, redirect_uri: CFG.openaiCodex.oauth.redirectUri, code_verifier: verifier },
      true,
      opts.fetchImpl,
    );
    return {
      type: "oauth",
      access: json.access_token,
      refresh: json.refresh_token,
      expires: expiryFromNow(json.expires_in ?? 3600),
      accountId: extractOpenAIAccountId(json.id_token, json.access_token),
    };
  },
};

function randomState(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

async function openAIDeviceFlow(opts: FlowOpts): Promise<Cred> {
  const cfg = CFG.openaiCodex.oauth.device;
  const doFetch = opts.fetchImpl ?? fetch;
  const start = await postToken(cfg.usercodeUrl, { client_id: CFG.openaiCodex.oauth.clientId }, false, opts.fetchImpl);
  opts.onStatus(`Go to ${cfg.verificationUrl} and enter code: ${start.user_code}`);
  const deadline = Date.now() + 10 * 60 * 1000;
  const interval = Math.max(1, start.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const res = await doFetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ device_auth_id: start.device_auth_id, user_code: start.user_code }),
    });
    if (res.status === 403 || res.status === 404) continue; // not yet authorized
    if (!res.ok) throw new Error(`Device authorization failed (${res.status})`);
    const granted = await res.json();
    const json = await postToken(
      CFG.openaiCodex.oauth.tokenUrl,
      {
        grant_type: "authorization_code",
        client_id: CFG.openaiCodex.oauth.clientId,
        code: granted.authorization_code,
        redirect_uri: cfg.deviceRedirectUri,
        code_verifier: granted.code_verifier,
      },
      true,
      opts.fetchImpl,
    );
    return {
      type: "oauth",
      access: json.access_token,
      refresh: json.refresh_token,
      expires: expiryFromNow(json.expires_in ?? 3600),
      accountId: extractOpenAIAccountId(json.id_token, json.access_token),
    };
  }
  throw new Error("Device authorization timed out");
}

export const googleFlow: OAuthFlow = {
  id: "google",
  async start(opts) {
    const cfg = CFG.google.oauth;
    const { verifier, challenge } = generatePKCE();
    let code: string;
    let redirectUri: string;
    if (opts.headless) {
      redirectUri = cfg.headlessRedirectUri;
      const q = new URLSearchParams({
        response_type: "code",
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        scope: cfg.scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        code_challenge_method: "S256",
        code_challenge: challenge,
      });
      const url = `${cfg.authorizeUrl}?${q}`;
      opts.onStatus(`Open this URL to log in:\n${url}`);
      opts.openUrl(url);
      const pasted = parsePastedCode(await opts.promptPaste());
      if (!pasted.code) throw new Error("Login cancelled");
      code = pasted.code;
    } else {
      // Random free port on 127.0.0.1; client_secret instead of PKCE on this path.
      const result = await codeViaCallbackOrPaste(opts, [0], cfg.callbackPath, (uri) => {
        const q = new URLSearchParams({
          response_type: "code",
          client_id: cfg.clientId,
          redirect_uri: uri,
          scope: cfg.scopes.join(" "),
          access_type: "offline",
          prompt: "consent",
        });
        return `${cfg.authorizeUrl}?${q}`;
      });
      code = result.code;
      redirectUri = result.redirectUri;
    }
    const token = await postToken(
      cfg.tokenUrl,
      {
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      true,
      opts.fetchImpl,
    );
    const access = token.access_token as string;
    const projectId = await resolveGoogleProject(access, opts);
    return {
      type: "oauth",
      access,
      refresh: token.refresh_token,
      expires: expiryFromNow(token.expires_in ?? 3600),
      projectId,
    };
  },
};

async function resolveGoogleProject(access: string, opts: FlowOpts): Promise<string | undefined> {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = CFG.google.codeAssistUrl;
  const headers = { authorization: `Bearer ${access}`, "content-type": "application/json" };
  const metadata = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
  const load = await doFetch(`${base}:loadCodeAssist`, { method: "POST", headers, body: JSON.stringify({ metadata }) });
  if (!load.ok) return process.env.GOOGLE_CLOUD_PROJECT;
  const info: any = await load.json();
  if (info.currentTier) return info.cloudaicompanionProject ?? process.env.GOOGLE_CLOUD_PROJECT;
  const tierId = info.allowedTiers?.[0]?.id ?? "free-tier";
  const onboard = await doFetch(`${base}:onboardUser`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tierId, cloudaicompanionProject: process.env.GOOGLE_CLOUD_PROJECT, metadata }),
  });
  if (!onboard.ok) return process.env.GOOGLE_CLOUD_PROJECT;
  const op: any = await onboard.json();
  const deadline = Date.now() + 30_000;
  while (op.name && !op.done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await doFetch(`${base}/${op.name}`, { headers });
    if (poll.ok) Object.assign(op, await poll.json());
  }
  return op.response?.cloudaicompanionProject ?? process.env.GOOGLE_CLOUD_PROJECT;
}

export const copilotFlow: OAuthFlow = {
  id: "copilot",
  async start(opts) {
    const cfg = CFG.copilot;
    const device = await postToken(cfg.deviceCodeUrl, { client_id: cfg.clientId, scope: cfg.scope }, false, opts.fetchImpl);
    opts.onStatus(`Go to ${device.verification_uri} and enter code: ${device.user_code}`);
    const token = await pollDeviceFlow({
      tokenUrl: cfg.accessTokenUrl,
      clientId: cfg.clientId,
      deviceCode: device.device_code,
      intervalMs: Math.max(1, device.interval ?? 5) * 1000,
      timeoutMs: 10 * 60 * 1000,
      fetchImpl: opts.fetchImpl,
    });
    // Copilot has two tokens: this GitHub token ("refresh") exchanges lazily for
    // short-lived copilot tokens ("access") via the v2/token endpoint.
    return { type: "oauth", access: "", refresh: token.access_token, expires: 0 };
  },
};

// --- Refresh functions (used by getValidOAuth) ---

export async function refreshAnthropic(cred: OAuthCred, fetchImpl?: FetchImpl): Promise<OAuthCred> {
  const cfg = CFG.anthropic.oauth;
  const json = await postToken(cfg.tokenUrl, { grant_type: "refresh_token", client_id: cfg.clientId, refresh_token: cred.refresh }, false, fetchImpl);
  return { ...cred, access: json.access_token, refresh: json.refresh_token ?? cred.refresh, expires: expiryFromNow(json.expires_in ?? 3600) };
}

export async function refreshOpenAI(cred: OAuthCred, fetchImpl?: FetchImpl): Promise<OAuthCred> {
  const cfg = CFG.openaiCodex.oauth;
  const json = await postToken(cfg.tokenUrl, { grant_type: "refresh_token", client_id: cfg.clientId, refresh_token: cred.refresh }, true, fetchImpl);
  return { ...cred, access: json.access_token, refresh: json.refresh_token ?? cred.refresh, expires: expiryFromNow(json.expires_in ?? 3600) };
}

export async function refreshGoogle(cred: OAuthCred, fetchImpl?: FetchImpl): Promise<OAuthCred> {
  const cfg = CFG.google.oauth;
  const json = await postToken(
    cfg.tokenUrl,
    { grant_type: "refresh_token", client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cred.refresh },
    true,
    fetchImpl,
  );
  return { ...cred, access: json.access_token, refresh: json.refresh_token ?? cred.refresh, expires: expiryFromNow(json.expires_in ?? 3600) };
}

// token like "tid=..;exp=..;proxy-ep=proxy.business.githubcopilot.com;.."
export function parseCopilotBaseUrl(token: string): string | undefined {
  const m = /(?:^|;)proxy-ep=proxy\.([^;]+)/.exec(token);
  return m ? `https://api.${m[1]}` : undefined;
}

export async function refreshCopilot(cred: OAuthCred, fetchImpl?: FetchImpl): Promise<OAuthCred> {
  const res = await (fetchImpl ?? fetch)(CFG.copilot.tokenExchangeUrl, {
    headers: { authorization: `Bearer ${cred.refresh}`, accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Copilot token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json: any = await res.json();
  return {
    ...cred,
    access: json.token,
    expires: json.expires_at * 1000 - 5 * 60 * 1000,
    baseUrl: parseCopilotBaseUrl(json.token) ?? CFG.copilot.defaultBaseUrl,
  };
}

export const FLOWS: Record<FlowId, OAuthFlow> = {
  anthropic: anthropicFlow,
  openai: openAIFlow,
  google: googleFlow,
  copilot: copilotFlow,
};

export const REFRESH_FNS: Record<FlowId, (cred: OAuthCred, fetchImpl?: FetchImpl) => Promise<OAuthCred>> = {
  anthropic: refreshAnthropic,
  openai: refreshOpenAI,
  google: refreshGoogle,
  copilot: refreshCopilot,
};
