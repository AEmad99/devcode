import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// DevCode's state directory: sessions, spill files, settings.
// DEVCODE_HOME overrides the default ~/.devcode (used by tests).
export function home(): string {
  const dir = process.env.DEVCODE_HOME ?? join(homedir(), ".devcode");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function sessionsDir(): string {
  const dir = join(home(), "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function tmpDir(): string {
  const dir = join(home(), "tmp");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function settingsPath(): string {
  return join(home(), "settings.json");
}
