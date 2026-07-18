import { describe, expect, test } from "bun:test";
import { fuzzyScore, rankByFuzzy } from "../src/tui/fuzzy.js";

describe("fuzzyScore / rankByFuzzy", () => {
  test("exact and prefix beat subsequence", () => {
    expect(fuzzyScore("openai", "openai")).toBeGreaterThan(fuzzyScore("openai", "openrouter"));
    expect(fuzzyScore("gpt", "gpt-5")).toBeGreaterThan(fuzzyScore("gpt", "deepseek"));
  });

  test("ranks providers by id or name", () => {
    const items = [
      { id: "anthropic", name: "Anthropic (Claude)" },
      { id: "openai", name: "OpenAI (API key)" },
      { id: "minimax", name: "MiniMax" },
      { id: "openrouter", name: "OpenRouter" },
    ];
    const ranked = rankByFuzzy(items, "mini", (i) => [i.id, i.name]);
    expect(ranked[0]?.item.id).toBe("minimax");
    expect(ranked.every((r) => r.item.id !== "anthropic" || r.score > 0)).toBe(true);
    expect(ranked.map((r) => r.item.id)).not.toContain("openai");
  });

  test("empty query preserves order", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const ranked = rankByFuzzy(items, "", (i) => [i.id]);
    expect(ranked.map((r) => r.item.id)).toEqual(["a", "b", "c"]);
  });
});
