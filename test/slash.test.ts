import { describe, expect, test } from "bun:test";
import {
  fuzzyScore,
  longestCommonPrefix,
  matchSlashCommands,
  parseSlash,
  rankSlashCommands,
  SLASH_COMMANDS,
} from "../src/tui/slash.js";

describe("parseSlash", () => {
  test("parses a bare command", () => {
    expect(parseSlash("/help")).toEqual({ cmd: "help", args: "" });
  });

  test("parses a command with args", () => {
    expect(parseSlash("/model claude-opus-4-1")).toEqual({ cmd: "model", args: "claude-opus-4-1" });
  });

  test("returns null for non-commands", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("/")).toBeNull();
    expect(parseSlash(" /help")).toBeNull();
  });
});

describe("fuzzy slash ranking", () => {
  test("prefix matching still finds clear/compact/cost for 'c'", () => {
    const names = matchSlashCommands("c").map((c) => c.name);
    expect(names).toContain("clear");
    expect(names).toContain("compact");
    expect(names).toContain("cost");
    // multiple options, not just one
    expect(names.length).toBeGreaterThan(1);
  });

  test("subsequence match: thm → theme, thinking", () => {
    const ranked = rankSlashCommands("thm", SLASH_COMMANDS);
    const names = ranked.map((r) => r.cmd.name);
    expect(names).toContain("theme");
    expect(names).toContain("thinking");
    expect(names.length).toBeGreaterThan(1);
  });

  test("exact and prefix score higher than loose", () => {
    expect(fuzzyScore("theme", "theme")).toBeGreaterThan(fuzzyScore("thm", "theme"));
    expect(fuzzyScore("th", "theme")).toBeGreaterThan(fuzzyScore("th", "thinking"));
  });

  test("longest common prefix", () => {
    expect(longestCommonPrefix(["clear", "compact", "cost"])).toBe("c");
  });

  test("empty query returns commands", () => {
    expect(rankSlashCommands("", SLASH_COMMANDS).length).toBeGreaterThan(5);
  });
});
