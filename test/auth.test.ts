import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOpenAIAccountId, parseCopilotBaseUrl, refreshCopilot } from "../src/providers/auth/flows.js";
import { generatePKCE, parsePastedCode, pollDeviceFlow } from "../src/providers/auth/oauth.js";
import { clearCred, expiryFromNow, getCred, getValidOAuth, loadAuth, saveCred, type OAuthCred } from "../src/providers/auth/storage.js";
import { modelsFor } from "../src/providers/models.js";

let home: string;
beforeAll(() => {
  home = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-auth-`);
  process.env.DEVCODE_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
});

describe("auth storage", () => {
  test("save / load / clear roundtrip", () => {
    saveCred("p1", { type: "api", key: "sk-1" });
    expect(getCred("p1")).toEqual({ type: "api", key: "sk-1" });
    const oauth: OAuthCred = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 1e6 };
    saveCred("p2", oauth);
    expect(getCred("p2")).toEqual(oauth);
    clearCred("p1");
    expect(getCred("p1")).toBeUndefined();
  });

  test("getValidOAuth returns fresh token without calling refresh", async () => {
    saveCred("fresh", { type: "oauth", access: "good", refresh: "r", expires: Date.now() + 60_000 });
    let refreshes = 0;
    const token = await getValidOAuth("fresh", async (c) => {
      refreshes++;
      return c;
    });
    expect(token).toBe("good");
    expect(refreshes).toBe(0);
  });

  test("expired cred refreshes once (single-flight) and persists rotation", async () => {
    saveCred("exp", { type: "oauth", access: "old", refresh: "r1", expires: Date.now() - 1000 });
    let refreshes = 0;
    const refreshFn = async (cred: OAuthCred): Promise<OAuthCred> => {
      refreshes++;
      await new Promise((r) => setTimeout(r, 50));
      return { ...cred, access: "new", refresh: "r2", expires: Date.now() + 60_000 };
    };
    const [t1, t2, t3] = await Promise.all([
      getValidOAuth("exp", refreshFn),
      getValidOAuth("exp", refreshFn),
      getValidOAuth("exp", refreshFn),
    ]);
    expect([t1, t2, t3]).toEqual(["new", "new", "new"]);
    expect(refreshes).toBe(1);
    expect((getCred("exp") as OAuthCred).refresh).toBe("r2"); // rotated token persisted
  });

  test("refresh failure clears the cred and demands re-login", async () => {
    saveCred("bad", { type: "oauth", access: "old", refresh: "r", expires: Date.now() - 1000 });
    await expect(
      getValidOAuth("bad", async () => {
        throw new Error("400 invalid_grant");
      }),
    ).rejects.toThrow("re-login required");
    expect(getCred("bad")).toBeUndefined();
  });

  test("expiryFromNow includes the 5-minute buffer", () => {
    const before = Date.now();
    const exp = expiryFromNow(3600);
    expect(exp).toBeGreaterThanOrEqual(before + 3600_000 - 300_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 3600_000 - 300_000);
  });

  test("corrupted auth.json is treated as empty and renamed to .bak", () => {
    const path = join(home, "auth.json");
    writeFileSync(path, "{not valid json!!!", "utf8");
    expect(loadAuth()).toEqual({});
    expect(existsSync(path)).toBe(false);
    const bak = readdirSync(home).find((f) => f.startsWith("auth.json.bak-"));
    expect(bak).toBeDefined();
    // subsequent save still works
    saveCred("after-corrupt", { type: "api", key: "k" });
    expect(getCred("after-corrupt")).toEqual({ type: "api", key: "k" });
  });
});

describe("oauth plumbing", () => {
  test("generatePKCE: base64url verifier, sha256 challenge", () => {
    const { verifier, challenge } = generatePKCE();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toBe(verifier);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
  });

  test("parsePastedCode variants", () => {
    expect(parsePastedCode("abc")).toEqual({ code: "abc" });
    expect(parsePastedCode("abc#st")).toEqual({ code: "abc", state: "st" });
    expect(parsePastedCode("http://localhost:53692/callback?code=xyz&state=s1")).toEqual({ code: "xyz", state: "s1" });
    expect(parsePastedCode("http://localhost/cb?code=only")).toEqual({ code: "only" });
    expect(parsePastedCode("  ")).toEqual({ code: "" });
  });

  test("pollDeviceFlow: pending then success", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 });
      return new Response(JSON.stringify({ access_token: "gh-tok" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await pollDeviceFlow({
      tokenUrl: "https://example.com/token",
      clientId: "cid",
      deviceCode: "dc",
      intervalMs: 1,
      timeoutMs: 5000,
      fetchImpl,
    });
    expect(result.access_token).toBe("gh-tok");
    expect(calls).toBe(3);
  });

  test("pollDeviceFlow: slow_down backs off then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: "slow_down" }), { status: 200 });
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }) as unknown as typeof fetch;
    const started = Date.now();
    const result = await pollDeviceFlow({
      tokenUrl: "https://example.com/token",
      clientId: "cid",
      deviceCode: "dc",
      intervalMs: 1,
      timeoutMs: 15000,
      fetchImpl,
    });
    expect(result.access_token).toBe("tok");
    expect(Date.now() - started).toBeGreaterThanOrEqual(4900); // +5s backoff applied
  }, 15000);

  test("pollDeviceFlow: openai-style 403 pending", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response("forbidden", { status: 403 });
      return new Response(JSON.stringify({ authorization_code: "code-1", code_verifier: "v" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await pollDeviceFlow({
      tokenUrl: "https://example.com/token",
      clientId: "cid",
      deviceCode: "dc",
      intervalMs: 1,
      timeoutMs: 5000,
      fetchImpl,
    });
    expect(result.authorization_code).toBe("code-1");
  });
});

const unsignedJwt = (payload: object): string => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;
};

describe("provider-specific helpers", () => {
  test("extractOpenAIAccountId reads nested and dotted claims", () => {
    const nested = unsignedJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" } });
    expect(extractOpenAIAccountId(nested)).toBe("acct-nested");
    const dotted = unsignedJwt({ "https://api.openai.com/auth.chatgpt_account_id": "acct-dotted" });
    expect(extractOpenAIAccountId(dotted)).toBe("acct-dotted");
    expect(extractOpenAIAccountId("not-a-jwt")).toBeUndefined();
  });

  test("parseCopilotBaseUrl from proxy-ep", () => {
    expect(parseCopilotBaseUrl("tid=x;proxy-ep=proxy.business.githubcopilot.com;exp=1")).toBe(
      "https://api.business.githubcopilot.com",
    );
    expect(parseCopilotBaseUrl("tid=x;exp=1")).toBeUndefined();
  });

  test("refreshCopilot exchanges ghToken for a copilot token + baseUrl", async () => {
    const fetchImpl = (async (url: any, init?: any) => {
      expect(String(url)).toContain("copilot_internal/v2/token");
      expect((init?.headers as any).authorization).toBe("Bearer gh-1");
      return new Response(
        JSON.stringify({ token: "tid=1;proxy-ep=proxy.individual.githubcopilot.com", expires_at: Math.floor(Date.now() / 1000) + 1800 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const next = await refreshCopilot({ type: "oauth", access: "", refresh: "gh-1", expires: 0 }, fetchImpl);
    expect(next.access).toContain("tid=1");
    expect(next.baseUrl).toBe("https://api.individual.githubcopilot.com");
    expect(next.expires).toBeLessThan(Date.now() + 1800_000);
  });
});

describe("models catalog", () => {
  test("modelsFor parses the catalog and caches it", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ anthropic: { models: { "claude-test-1": { name: "Claude Test 1" } } } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const models = await modelsFor("anthropic", fetchImpl);
    expect(models).toEqual([{ id: "claude-test-1", name: "Claude Test 1" }]);
    const cached = JSON.parse(await Bun.file(`${home}/models.json`).text());
    expect(cached.data.anthropic.models["claude-test-1"]).toBeTruthy();
  });

  test("modelsFor maps openai-codex to the openai catalog", async () => {
    rmSync(`${home}/models.json`, { force: true }); // ignore the cache written by the previous test
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ openai: { models: { "gpt-x": { name: "GPT X" } } } }), { status: 200 })) as unknown as typeof fetch;
    expect(await modelsFor("openai-codex", fetchImpl)).toEqual([{ id: "gpt-x", name: "GPT X" }]);
  });

  test("modelsFor falls back to static lists when fetch fails with no cache", async () => {
    const { mkdtempSync } = await import("node:fs");
    const isolated = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-models-`);
    const saved = process.env.DEVCODE_HOME;
    process.env.DEVCODE_HOME = isolated;
    try {
      const failing = (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
      const models = await modelsFor("google", failing);
      expect(models.length).toBeGreaterThan(0);
      expect(models[0].id).toBe("gemini-2.5-pro");
    } finally {
      process.env.DEVCODE_HOME = saved;
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});
