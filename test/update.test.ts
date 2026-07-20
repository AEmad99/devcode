import { describe, expect, test } from "bun:test";
import { compareVersions, checkForUpdate, formatUpdateInfo, getUpdateInfo } from "../src/core/update.js";
import { appVersion } from "../src/tui/brand.js";

function fakeFetch(map: Record<string, unknown>, ok = true): typeof fetch {
  return ((input: any) => {
    const url = typeof input === "string" ? input : input?.url;
    const body = map[url];
    if (body === undefined || !ok) {
      const res = {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "",
      } as any;
      return Promise.resolve(res);
    }
    const res = {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    } as any;
    return Promise.resolve(res);
  }) as typeof fetch;
}

describe("compareVersions", () => {
  test("equal versions compare as 0", () => {
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
  test("higher numeric wins", () => {
    expect(compareVersions("0.2.0", "0.1.1")).toBeGreaterThan(0);
    expect(compareVersions("0.1.1", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
  test("leading v is stripped", () => {
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("v0.2.0", "v0.1.0")).toBeGreaterThan(0);
  });
  test("different segment counts are padded with zeros", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
  });
  test("pre-release suffix is an earlier version", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-rc1", "1.0.0")).toBeLessThan(0);
  });
  test("non-numeric segments fall back to 0", () => {
    expect(compareVersions("0.x.0", "0.0.0")).toBe(0);
  });
});

describe("checkForUpdate", () => {
  test("reports an update when remote package.json version is higher", async () => {
    const current = appVersion();
    const higher = "99.9.9";
    const fetchImpl = fakeFetch({
      "https://raw.githubusercontent.com/AEmad99/devcode/main/package.json": { version: higher },
      "https://api.github.com/repos/AEmad99/devcode/releases/latest": { tag_name: "v0.0.0" },
    });
    const r = await checkForUpdate(fetchImpl as any);
    expect(r.hasUpdate).toBe(true);
    expect(r.current).toBe(current);
    expect(r.latest).toBe(higher);
  });
  test("reports no update when remote version equals current", async () => {
    const current = appVersion();
    const fetchImpl = fakeFetch({
      "https://raw.githubusercontent.com/AEmad99/devcode/main/package.json": { version: current },
      "https://api.github.com/repos/AEmad99/devcode/releases/latest": { tag_name: current },
    });
    const r = await checkForUpdate(fetchImpl as any);
    expect(r.hasUpdate).toBe(false);
    expect(r.latest).toBe(current);
  });
  test("release tag wins when higher than package.json", async () => {
    const current = appVersion();
    const fetchImpl = fakeFetch({
      "https://raw.githubusercontent.com/AEmad99/devcode/main/package.json": { version: "0.0.1" },
      "https://api.github.com/repos/AEmad99/devcode/releases/latest": { tag_name: "v99.0.0" },
    });
    const r = await checkForUpdate(fetchImpl as any);
    expect(r.hasUpdate).toBe(true);
    expect(r.latest).toBe("99.0.0");
  });
  test("falls back to package.json when releases API 404s", async () => {
    const current = appVersion();
    const higher = "99.9.9";
    const fetchImpl = fakeFetch({
      "https://raw.githubusercontent.com/AEmad99/devcode/main/package.json": { version: higher },
      "https://api.github.com/repos/AEmad99/devcode/releases/latest": {},
    });
    const r = await checkForUpdate(fetchImpl as any);
    expect(r.hasUpdate).toBe(true);
    expect(r.latest).toBe(higher);
    expect(r.source).toBe("package.json");
  });
  test("offline (all fetches fail) returns hasUpdate false with a reason", async () => {
    const fetchImpl = fakeFetch({}, false);
    const r = await checkForUpdate(fetchImpl as any);
    expect(r.hasUpdate).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(r.latest).toBeUndefined();
  });
  test("missing version field in package.json is treated as unreachable", async () => {
    const fetchImpl = fakeFetch({
      "https://raw.githubusercontent.com/AEmad99/devcode/main/package.json": { name: "devcode" },
      "https://api.github.com/repos/AEmad99/devcode/releases/latest": {},
    });
    const r = await checkForUpdate(fetchImpl as any);
    expect(r.hasUpdate).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});

describe("formatUpdateInfo", () => {
  test("up-to-date message includes current version", () => {
    const s = formatUpdateInfo({ current: "0.2.0", latest: "0.2.0", hasUpdate: false, githubUrl: "x" });
    expect(s).toContain("up to date");
    expect(s).toContain("0.2.0");
  });
  test("update-available message includes both versions and the upgrade command", () => {
    const s = formatUpdateInfo({
      current: "0.1.1",
      latest: "0.2.0",
      hasUpdate: true,
      githubUrl: "https://github.com/AEmad99/devcode",
    });
    expect(s).toContain("0.1.1");
    expect(s).toContain("0.2.0");
    expect(s).toContain("install.ps1");
  });
  test("offline reason is rendered verbatim", () => {
    const s = formatUpdateInfo({
      current: "0.2.0",
      hasUpdate: false,
      reason: "Could not reach GitHub",
      githubUrl: "x",
    });
    expect(s).toContain("Could not reach GitHub");
  });
});

describe("getUpdateInfo", () => {
  test("returns a compact object with githubUrl", async () => {
    const info = await getUpdateInfo(fakeFetch({}, false) as any);
    expect(info.current).toBe(appVersion());
    expect(info.githubUrl).toContain("github.com/AEmad99/devcode");
    expect(info.reason).toBeTruthy();
  });
});