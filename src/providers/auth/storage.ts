import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "../../core/paths.js";

export interface OAuthCred {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number; // epoch ms, already includes the 5-minute safety buffer
  accountId?: string;
  projectId?: string;
  baseUrl?: string;
}
export interface ApiCred {
  type: "api";
  key: string;
}
export type Cred = OAuthCred | ApiCred;
type AuthFile = Record<string, Cred>;

const authPath = (): string => join(home(), "auth.json");

export function loadAuth(): AuthFile {
  const path = authPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {}; // missing file is fine
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as AuthFile;
    throw new Error("auth.json root must be an object");
  } catch {
    // Corrupted file: preserve a copy for inspection and start fresh.
    try {
      if (existsSync(path)) renameSync(path, `${path}.bak-${Date.now()}`);
    } catch {
      // nothing to preserve
    }
    return {};
  }
}

export function saveCred(id: string, cred: Cred): void {
  const auth = loadAuth();
  auth[id] = cred;
  writeFileSync(authPath(), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export function clearCred(id: string): void {
  const auth = loadAuth();
  delete auth[id];
  writeFileSync(authPath(), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export function getCred(id: string): Cred | undefined {
  return loadAuth()[id];
}

// expires = now + expires_in*1000 - 5-minute safety buffer
export function expiryFromNow(expiresInSec: number): number {
  return Date.now() + expiresInSec * 1000 - 5 * 60 * 1000;
}

const inflight = new Map<string, Promise<string>>();

// Returns a valid access token, refreshing (single-flight) when expired.
// On refresh failure the stored cred is cleared and re-login is required.
export async function getValidOAuth(id: string, refreshFn: (cred: OAuthCred) => Promise<OAuthCred>): Promise<string> {
  const cred = getCred(id);
  if (!cred || cred.type !== "oauth") throw new Error(`No OAuth credentials for ${id} — run /login ${id}`);
  if (cred.expires > Date.now()) return cred.access;
  const pending = inflight.get(id);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const next = await refreshFn(cred);
      saveCred(id, next); // persist rotated refresh token immediately
      return next.access;
    } catch (err) {
      clearCred(id);
      throw new Error(`OAuth refresh for ${id} failed — re-login required: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, promise);
  return promise;
}
