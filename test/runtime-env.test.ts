import { afterEach, describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/core/prompt.js";
import {
  detectRuntimeEnv,
  findGitRoot,
  findPosixShell,
  formatRuntimePromptBlock,
  gitPathExtras,
  resetRuntimeEnvCache,
  shellEnv,
} from "../src/core/runtime-env.js";
import { looksLikeWindowsCmd, shellArgv } from "../src/core/tools/bash.js";
import { bashTool } from "../src/core/tools/bash.js";

afterEach(() => {
  resetRuntimeEnvCache();
});

describe("detectRuntimeEnv", () => {
  test("reports platform and shell", () => {
    const env = detectRuntimeEnv();
    expect(env.platform).toBe(process.platform);
    expect(env.osLabel.length).toBeGreaterThan(0);
    expect(env.cwd).toBe(process.cwd());
    expect(env.shellPath.length).toBeGreaterThan(0);
    expect(["bash", "sh", "cmd", "powershell", "unknown"]).toContain(env.shellKind);
  });

  test("Windows: finds Git root and PATH extras when Git is installed", () => {
    if (process.platform !== "win32") return;
    const root = findGitRoot();
    // CI may lack Git; local DevCode machines typically have it
    if (!root) {
      expect(findPosixShell()).toBeNull();
      return;
    }
    expect(root.toLowerCase()).toContain("git");
    const extras = gitPathExtras(root);
    expect(extras.length).toBeGreaterThan(0);
    const env = detectRuntimeEnv();
    expect(env.posixShell).toBeTruthy();
    expect(env.pathExtras.length).toBeGreaterThan(0);
    // shuf lives under Git usr/bin on Git for Windows
    expect(env.available.shuf || env.available.git).toBe(true);
  });

  test("shellEnv prepends extras onto PATH", () => {
    const extras = ["C:\\fake-git\\usr\\bin", "C:\\fake-git\\bin"];
    const env = shellEnv(extras);
    const path = env.PATH ?? env.Path ?? "";
    expect(path.startsWith(extras[0]) || path.includes(extras[0])).toBe(true);
  });
});

describe("formatRuntimePromptBlock / system prompt", () => {
  test("includes authoritative host OS section", () => {
    const block = formatRuntimePromptBlock(detectRuntimeEnv());
    expect(block).toContain("Host environment");
    expect(block).toMatch(/Windows|macOS|Linux/);
    expect(block).toContain("OS command policy");
  });

  test("buildSystemPrompt embeds runtime block and tool policy", () => {
    const prompt = buildSystemPrompt({
      cwd: process.cwd(),
      platform: process.platform,
      shell: "test-shell",
      date: "2026-01-01",
      isGitRepo: false,
      runtime: detectRuntimeEnv(),
    });
    expect(prompt).toContain("Host environment");
    expect(prompt).toContain("authoritative");
    expect(prompt).toContain(process.platform);
    expect(prompt).toMatch(/not recognized|command not found|Prefer DevCode tools/i);
    expect(prompt).toContain("File tools");
    expect(prompt).toContain(process.cwd());
    expect(prompt).toMatch(/never pass a directory|Never pass a directory/i);
    expect(prompt).toMatch(/\bread\b/);
    expect(prompt).toMatch(/\bglob\b/);
  });
});

describe("shellArgv / looksLikeWindowsCmd", () => {
  test("routes dir /b to cmd on Windows", () => {
    if (process.platform !== "win32") return;
    expect(looksLikeWindowsCmd("dir /b")).toBe(true);
    const argv = shellArgv("dir /b");
    expect(argv[0].toLowerCase()).toContain("cmd");
  });

  test("routes ls / POSIX pipelines to bash when available", () => {
    if (process.platform !== "win32") return;
    const env = detectRuntimeEnv();
    if (!env.posixShell) return;
    expect(looksLikeWindowsCmd("ls -la src")).toBe(false);
    expect(looksLikeWindowsCmd("shuf -n 1")).toBe(false);
    const argv = shellArgv("ls -la", env);
    expect(argv[0].toLowerCase()).toContain("bash");
    expect(argv).toContain("-c");
  });

  test("Unix always uses sh/bash -c", () => {
    if (process.platform === "win32") return;
    const argv = shellArgv("echo hi");
    expect(argv).toContain("-c");
    expect(argv).toContain("echo hi");
  });
});

describe("bash tool host awareness", () => {
  const signal = new AbortController().signal;

  test("echo works under OS-correct shell", async () => {
    const res = await bashTool.execute("1", { command: "echo host-ok" }, signal);
    expect(res.is_error).toBeUndefined();
    expect(res.content).toContain("host-ok");
  });

  test("Windows: shuf is available via Git PATH injection when Git is installed", async () => {
    if (process.platform !== "win32") return;
    const env = detectRuntimeEnv();
    if (!env.available.shuf && !env.posixShell) return;
    // printf one line into shuf -n 1
    const res = await bashTool.execute(
      "1",
      { command: "printf 'a\\nb\\n' | shuf -n 1" },
      signal,
    );
    // Should not be the classic cmd "not recognized" failure
    expect(res.content).not.toMatch(/is not recognized as an internal or external command/i);
    if (!res.is_error) {
      expect(["a", "b"]).toContain(res.content.trim());
    }
  });

  test("description mentions host OS", () => {
    expect(bashTool.description).toMatch(/Windows|macOS|Linux|Host:/i);
  });
});
