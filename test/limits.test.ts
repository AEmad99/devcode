import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatLimitsReport, getLimits } from "../src/core/limits.js";
import { findModelEntry, lookupModelLimits, normalizeModelId } from "../src/providers/models.js";

let home: string;

beforeAll(() => {
  home = mkdtempSync(`${tmpdir().replace(/\\/g, "/")}/devcode-limits-`);
  process.env.DEVCODE_HOME = home;
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "models.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      data: {
        anthropic: {
          models: {
            "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", limit: { context: 1_000_000, output: 128_000 } },
            "claude-opus-4-1": { name: "Claude Opus 4.1", limit: { context: 200_000, output: 32_000 } },
          },
        },
        deepseek: {
          models: {
            "deepseek-chat": { name: "DeepSeek Chat", limit: { context: 1_000_000, output: 384_000 } },
          },
        },
        minimax: {
          models: {
            "MiniMax-M2.7": { name: "MiniMax M2.7", limit: { context: 204_800, output: 131_072 } },
            "MiniMax-M2.5": { name: "MiniMax M2.5", limit: { context: 204_800, output: 131_072 } },
          },
        },
        "kimi-for-coding": {
          models: {
            k2p7: { name: "K2.7", limit: { context: 262_144, output: 32_768 } },
            k3: { name: "K3", limit: { context: 1_048_576, output: 131_072 } },
          },
        },
        xai: {
          models: {
            "grok-4.20-0309-reasoning": { name: "Grok", limit: { context: 1_000_000, output: 30_000 } },
          },
        },
        openrouter: {
          models: {
            "anthropic/claude-sonnet-4.5": { name: "Claude", limit: { context: 200_000, output: 64_000 } },
          },
        },
      },
    }),
  );
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.DEVCODE_HOME;
});

describe("normalizeModelId / findModelEntry", () => {
  test("normalizes punctuation and case", () => {
    expect(normalizeModelId("MiniMax-M2.7")).toBe("minimaxm27");
    expect(normalizeModelId("claude-sonnet-4-6")).toBe("claudesonnet46");
  });

  test("matches exact, case-insensitive, and normalized ids", () => {
    const models = {
      "MiniMax-M2.7": { limit: { context: 204800, output: 1 } },
      "claude-sonnet-4-6": { limit: { context: 1_000_000, output: 1 } },
    };
    expect(findModelEntry(models, "MiniMax-M2.7")?.limit.context).toBe(204800);
    expect(findModelEntry(models, "minimax-m2.7")?.limit.context).toBe(204800);
    expect(findModelEntry(models, "minimaxm2.7")?.limit.context).toBe(204800);
    expect(findModelEntry(models, "claude-sonnet-4-6")?.limit.context).toBe(1_000_000);
  });
});

describe("lookupModelLimits / getLimits (models.dev)", () => {
  test("reads MiniMax-M2.7 context 204800 from cache", () => {
    const lim = getLimits("minimax", "MiniMax-M2.7");
    expect(lim.contextWindow).toBe(204_800);
    expect(lim.maxOutput).toBe(131_072);
    expect(lim.note).toBe("models.dev");
  });

  test("case-insensitive model match", () => {
    expect(getLimits("minimax", "minimax-m2.7").contextWindow).toBe(204_800);
  });

  test("deepseek-chat is 1M not 128k", () => {
    const lim = getLimits("deepseek", "deepseek-chat");
    expect(lim.contextWindow).toBe(1_000_000);
    expect(lim.maxOutput).toBe(384_000);
    expect(lim.note).toBe("models.dev");
  });

  test("claude-sonnet-4-6 is 1M from catalog", () => {
    expect(getLimits("anthropic", "claude-sonnet-4-6").contextWindow).toBe(1_000_000);
  });

  test("kimi-coding maps to kimi-for-coding catalog key", () => {
    expect(getLimits("kimi-coding", "k2p7").contextWindow).toBe(262_144);
    expect(getLimits("kimi-coding", "k3").contextWindow).toBe(1_048_576);
  });

  test("xai grok large window from catalog", () => {
    expect(getLimits("xai", "grok-4.20-0309-reasoning").contextWindow).toBe(1_000_000);
  });

  test("openrouter full id match", () => {
    expect(getLimits("openrouter", "anthropic/claude-sonnet-4.5").contextWindow).toBe(200_000);
  });

  test("unknown model falls back to heuristics", () => {
    const lim = getLimits("deepseek", "totally-unknown-model-xyz");
    expect(lim.note).not.toBe("models.dev");
    expect(lim.contextWindow).toBeGreaterThan(0);
  });

  test("lookupModelLimits returns null when offline", () => {
    // provider with no catalog entry
    expect(lookupModelLimits("radius", "anything")).toBeNull();
  });

  test("formatLimitsReport mentions models.dev source", () => {
    const report = formatLimitsReport("minimax", "MiniMax-M2.7");
    expect(report).toContain("204,800");
    expect(report).toContain("models.dev");
  });
});

describe("heuristic fallbacks (no catalog hit)", () => {
  test("claude-sonnet-4-5 without catalog entry uses 200k heuristic", () => {
    // not in our fixture
    const lim = getLimits("anthropic", "claude-sonnet-4-5");
    expect(lim.contextWindow).toBe(200_000);
  });

  test("provider default when model omitted", () => {
    const lim = getLimits("minimax");
    expect(lim.contextWindow).toBe(204_800);
  });
});
