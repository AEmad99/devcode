import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { FetchImpl } from "../openai.js";

export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface CallbackResult {
  code: string;
  state: string | null;
}

const CLOSE_TAB_HTML =
  "<html><body style=\"font-family:sans-serif;text-align:center;padding-top:4em\">" +
  "<h2>DevCode login complete</h2><p>You can close this tab and return to the terminal.</p></body></html>";

// Start a loopback callback server (trying ports in order) and run fn with the
// redirectUri plus a waitForCode() that resolves with the captured code/state.
export async function withCallbackServer<T>(
  ports: readonly number[],
  path: string,
  fn: (redirectUri: string, waitForCode: () => Promise<CallbackResult>) => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (const port of ports) {
    try {
      return await runOnPort(port, path, fn);
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw err;
    }
  }
  throw lastErr;
}

function runOnPort<T>(
  port: number,
  path: string,
  fn: (redirectUri: string, waitForCode: () => Promise<CallbackResult>) => Promise<T>,
): Promise<T> {
  let server: Server | undefined;
  return new Promise<T>((resolve, reject) => {
    let resolveCode: (r: CallbackResult) => void;
    let rejectCode: (err: Error) => void;
    const codePromise = new Promise<CallbackResult>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    // Swallow late arrivals after settlement (double taps on the OAuth page).
    codePromise.catch(() => {});

    const timeout = setTimeout(() => {
      rejectCode(new Error("OAuth callback timed out (5 minutes)"));
    }, 5 * 60 * 1000);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== path) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      res.setHeader("content-type", "text/html");
      res.end(CLOSE_TAB_HTML);
      if (error) {
        const desc = url.searchParams.get("error_description");
        const msg =
          error === "access_denied"
            ? "Login cancelled or denied by the provider"
            : `OAuth error: ${error}${desc ? ` — ${desc}` : ""}`;
        rejectCode(new Error(msg));
      } else if (code) resolveCode({ code, state: url.searchParams.get("state") });
      else rejectCode(new Error("OAuth callback carried no code"));
    });
    server.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      const redirectUri = `http://localhost:${(server!.address() as AddressInfo).port}${path}`;
      fn(redirectUri, () => codePromise).then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      );
    });
  }).finally(() => {
    server?.close();
  });
}

export function openBrowser(url: string): void {
  try {
    const cmd =
      process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : process.platform === "darwin"
          ? ["open", url]
          : ["xdg-open", url];
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // The TUI always shows the URL for manual copy; ignore spawn failures.
  }
}

// Accepts a bare code, `code#state`, or a full redirect URL.
export function parsePastedCode(input: string): { code: string; state?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { code: "" };
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? undefined;
      return state ? { code, state } : { code };
    } catch {
      // fall through to plain handling
    }
  }
  if (trimmed.includes("#")) {
    const [code, state] = trimmed.split("#", 2);
    return state ? { code, state } : { code };
  }
  return { code: trimmed };
}

export interface DeviceFlowOpts {
  tokenUrl: string;
  clientId: string;
  deviceCode: string;
  intervalMs: number;
  timeoutMs: number;
  formEncoded?: boolean;
  extra?: Record<string, string>;
  fetchImpl?: FetchImpl;
}

// RFC 8628-ish polling: authorization_pending waits, slow_down backs off 5s.
// Also tolerates OpenAI-style 403/404 "not yet authorized" responses.
export async function pollDeviceFlow(opts: DeviceFlowOpts): Promise<any> {
  const doFetch = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + opts.timeoutMs;
  let interval = opts.intervalMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const fields: Record<string, string> = {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: opts.clientId,
      device_code: opts.deviceCode,
      ...opts.extra,
    };
    const res = await doFetch(opts.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": opts.formEncoded ? "application/x-www-form-urlencoded" : "application/json",
        accept: "application/json",
      },
      body: opts.formEncoded ? new URLSearchParams(fields).toString() : JSON.stringify(fields),
    });
    const json: any = await res.json().catch(() => ({}));
    if (json.access_token || json.authorization_code) return json;
    const errCode: string = json.error ?? "";
    if (errCode === "slow_down") {
      interval += 5000;
      continue;
    }
    if (errCode === "expired_token") throw new Error("Device flow expired — restart login");
    if (errCode === "authorization_pending") continue;
    if (!res.ok && (res.status === 403 || res.status === 404 || res.status === 428)) continue; // not yet authorized
    if (errCode) throw new Error(`Device flow failed: ${json.error_description ?? errCode}`);
    if (!res.ok) throw new Error(`Device flow failed (HTTP ${res.status})`);
  }
  throw new Error("Device flow timed out");
}

// Decode a JWT payload claim without verifying the signature (id_token from our own exchange).
export function extractJwtClaim(jwt: string, claim: string): string | undefined {
  const parts = jwt.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload[claim];
  } catch {
    return undefined;
  }
}
