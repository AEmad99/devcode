/**
 * Update detection — compare the locally installed version against the version
 * published on GitHub.
 *
 * The source of truth for "latest" is the `version` field in `package.json` on
 * the repo's default branch, fetched via raw.githubusercontent.com. This lets
 * a new push land immediately (no release/tag ceremony required). If GitHub
 * Releases exist, the latest release tag is used as a secondary signal so a
 * tagged release always wins over a lower pre-release `package.json`.
 *
 * Network is optional: every function degrades gracefully offline (returns a
 * "could not reach GitHub" result) so the TUI never blocks on a network blip.
 */

import { appVersion } from "../tui/brand.js";

export const GITHUB_REPO = "AEmad99/devcode";
export const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
/** raw package.json on the default branch — the primary "latest" signal. */
const RAW_PACKAGE_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/package.json`;
/** GitHub Releases latest — secondary signal (tag wins if higher). */
const RELEASES_LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

export interface UpdateCheckResult {
  /** True when a newer version is available on GitHub. */
  hasUpdate: boolean;
  /** Currently installed version. */
  current: string;
  /** Latest version detected on GitHub (if reachable). */
  latest?: string;
  /** Why the check could not complete (offline / rate limited / etc.). */
  reason?: string;
  /** Where `latest` came from, for display. */
  source?: "package.json" | "release" | "both";
}

export interface UpdateInfo {
  current: string;
  latest?: string;
  hasUpdate: boolean;
  reason?: string;
  githubUrl: string;
}

/**
 * Fetch the version string from raw package.json on the default branch.
 * Returns undefined on any network/parse failure.
 */
async function fetchPackageVersion(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(RAW_PACKAGE_URL, {
      signal,
      headers: { "user-agent": "devcode-update-check" },
      // Always fetch fresh; CDN edge caching is fine but never use a stale
      // browser-style cache for an update probe.
      cache: "no-store",
    });
    if (!res.ok) return undefined;
    const pkg = (await res.json()) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch the latest GitHub Release tag (secondary signal). Returns undefined
 * when there are no releases or the API is unreachable / rate limited.
 */
async function fetchReleaseVersion(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(RELEASES_LATEST_URL, {
      signal,
      headers: {
        "user-agent": "devcode-update-check",
        accept: "application/vnd.github+json",
      },
      cache: "no-store",
    });
    if (!res.ok) return undefined;
    const rel = (await res.json()) as { tag_name?: string };
    if (!rel.tag_name) return undefined;
    // Strip an optional leading "v" so "v0.2.0" compares as "0.2.0".
    return rel.tag_name.replace(/^v/i, "").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compare two dotted version strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 * Handles pre-release suffixes by treating a missing suffix as higher than a
 * present one (i.e. 1.0.0 > 1.0.0-rc1), matching semver-ish ordering well enough
 * for an update probe without pulling in a full semver dependency.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/);
  const pb = b.split(/[-+]/);
  const va = pa[0].split(".").map((n) => Number(n) || 0);
  const vb = pb[0].split(".").map((n) => Number(n) || 0);
  const len = Math.max(va.length, vb.length);
  for (let i = 0; i < len; i++) {
    const da = va[i] ?? 0;
    const db = vb[i] ?? 0;
    if (da !== db) return da - db;
  }
  // Core versions equal: a pre-release suffix means an EARLIER version.
  const sa = pa[1];
  const sb = pb[1];
  if (sa && !sb) return -1;
  if (!sa && sb) return 1;
  if (sa && sb) return sa < sb ? -1 : sa > sb ? 1 : 0;
  return 0;
}

/**
 * Probe GitHub for the latest published version and compare to the locally
 * installed version. Never throws — offline / rate-limited returns hasUpdate
 * false with a `reason`.
 */
export async function checkForUpdate(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<UpdateCheckResult> {
  const current = appVersion();
  const [pkgVer, relVer] = await Promise.all([
    fetchPackageVersion(fetchImpl, signal),
    fetchReleaseVersion(fetchImpl, signal),
  ]);
  if (!pkgVer && !relVer) {
    return { hasUpdate: false, current, reason: "Could not reach GitHub (offline or rate limited)" };
  }
  // Prefer the higher of the two signals: a tagged release should win over a
  // lower pre-release package.json, and vice versa.
  let latest: string | undefined;
  let source: UpdateCheckResult["source"];
  if (pkgVer && relVer) {
    if (compareVersions(relVer, pkgVer) >= 0) {
      latest = relVer;
      source = "both";
    } else {
      latest = pkgVer;
      source = "both";
    }
  } else {
    latest = pkgVer ?? relVer;
    source = pkgVer ? "package.json" : "release";
  }
  const hasUpdate = latest ? compareVersions(latest, current) > 0 : false;
  return { hasUpdate, current, latest, source };
}

/**
 * One-shot helper for the CLI / slash command: returns a compact object the
 * caller can render however it likes.
 */
export async function getUpdateInfo(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<UpdateInfo> {
  const r = await checkForUpdate(fetchImpl, signal);
  return {
    current: r.current,
    latest: r.latest,
    hasUpdate: r.hasUpdate,
    reason: r.reason,
    githubUrl: GITHUB_URL,
  };
}

/**
 * Human-readable update message for the TUI / CLI.
 */
export function formatUpdateInfo(info: UpdateInfo): string {
  if (info.reason) {
    return `DevCode v${info.current} — ${info.reason}`;
  }
  if (info.hasUpdate) {
    return [
      `DevCode update available: v${info.current} → v${info.latest}`,
      `  Upgrade: irm https://raw.githubusercontent.com/${GITHUB_REPO}/main/install.ps1 | iex`,
      `  Release:  ${GITHUB_URL}/releases/latest`,
    ].join("\n");
  }
  return `DevCode v${info.current} is up to date${info.latest ? ` (latest v${info.latest})` : ""}`;
}