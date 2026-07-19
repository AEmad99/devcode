import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Writable } from "node:stream";
import {
  enterFullScreen,
  installScreenCleanupOnce,
  leaveFullScreen,
} from "../src/tui/screen-mode.js";

/**
 * Tests run with `process.stdout.isTTY === false`, so the screen-mode helpers
 * short-circuit and never write anything. We override that with a fake TTY
 * stream injected via mock and capture what gets written.
 *
 * The tests assert byte-for-byte against the documented alt-screen recipe so
 * future changes that "tweak the escape" can only land by also updating the
 * test (and by extension the spec comment at the top of screen-mode.ts).
 */

// Canonical sequences from the doc-comment at the top of screen-mode.ts.
// Keep these in sync if you ever change the recipe — they encode the contract.
const SEQ_ENTER = "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J\x1b[H";
const SEQ_LEAVE = "\x1b[?1049l\x1b[?25h\x1b[?7h";

class FakeStdout extends Writable {
  buf = "";
  constructor() {
    super({ decodeStrings: false });
  }
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    cb();
  }
}

let fakeOut: FakeStdout;
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  fakeOut = new FakeStdout();
  // process.stdout.isTTY drives the short-circuit inside enterFullScreen/leaveFullScreen.
  originalIsTTY = (process.stdout as unknown as { isTTY?: boolean }).isTTY;
  (process.stdout as unknown as { isTTY?: boolean }).isTTY = true;
  // Spy on stdout.write so we can see what the helpers actually emitted.
  process.stdout.write = ((chunk: unknown) => {
    fakeOut._write(chunk as Buffer | string, "utf8", () => {});
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  (process.stdout as unknown as { isTTY?: boolean }).isTTY = originalIsTTY;
  // Remove all listeners the cleanup helper attached so test runs are isolated.
  process.removeAllListeners("exit");
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  mock.restore();
});

describe("enterFullScreen", () => {
  test("writes the alt-screen + hide cursor + clear+home sequence when stdout is a TTY", () => {
    enterFullScreen();
    expect(fakeOut.buf).toBe(SEQ_ENTER);
  });

  test("writes nothing when stdout is not a TTY (piped, redirected, CI)", () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = false;
    enterFullScreen();
    expect(fakeOut.buf).toBe("");
  });
});

describe("leaveFullScreen", () => {
  test("writes the inverse sequence (restore alt-screen, show cursor, re-enable wrap)", () => {
    enterFullScreen();
    fakeOut.buf = "";
    leaveFullScreen();
    expect(fakeOut.buf).toBe(SEQ_LEAVE);
  });

  test("writes nothing when stdout is not a TTY", () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = false;
    leaveFullScreen();
    expect(fakeOut.buf).toBe("");
  });
});

describe("installScreenCleanupOnce", () => {
  test("hooks exit, SIGINT, SIGTERM so any of them restores the terminal", () => {
    installScreenCleanupOnce();
    // After install, each event must trigger leaveFullScreen (i.e. SEQ_LEAVE on stdout).
    expect(process.listenerCount("exit")).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount("SIGINT")).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount("SIGTERM")).toBeGreaterThanOrEqual(1);
    expect(process.listenerCount("uncaughtException")).toBeGreaterThanOrEqual(1);

    fakeOut.buf = "";
    process.emit("SIGINT");
    expect(fakeOut.buf).toBe(SEQ_LEAVE);
    fakeOut.buf = "";
    process.emit("SIGTERM");
    expect(fakeOut.buf).toBe(SEQ_LEAVE);
    fakeOut.buf = "";
    process.emit("exit", 0);
    expect(fakeOut.buf).toBe(SEQ_LEAVE);
  });

  test("does nothing harmful when there is no TTY (no escape leak on signals)", () => {
    (process.stdout as unknown as { isTTY?: boolean }).isTTY = false;
    installScreenCleanupOnce();
    fakeOut.buf = "";
    process.emit("SIGINT");
    process.emit("SIGTERM");
    process.emit("exit", 0);
    expect(fakeOut.buf).toBe(""); // short-circuit kept the terminal clean
  });
});
