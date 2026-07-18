import { describe, expect, test } from "bun:test";
import { layoutFromTerminal } from "../src/tui/layout.js";

describe("layoutFromTerminal", () => {
  test("defaults when dimensions missing", () => {
    const l = layoutFromTerminal(undefined, undefined);
    expect(l.columns).toBe(80);
    expect(l.rows).toBe(24);
    expect(l.messageWindow).toBeGreaterThan(0);
    expect(l.inputWidth).toBeGreaterThanOrEqual(40);
  });

  test("grows message window with taller terminal", () => {
    const small = layoutFromTerminal(80, 20);
    const large = layoutFromTerminal(80, 60);
    expect(large.messageWindow).toBeGreaterThan(small.messageWindow);
    expect(large.scrollStep).toBeGreaterThanOrEqual(small.scrollStep);
  });

  test("widens input with wider terminal (capped)", () => {
    const narrow = layoutFromTerminal(50, 24);
    const wide = layoutFromTerminal(200, 24);
    expect(wide.inputWidth).toBeGreaterThan(narrow.inputWidth);
    expect(wide.inputWidth).toBeLessThanOrEqual(72);
  });

  test("clamps tiny sizes", () => {
    const l = layoutFromTerminal(10, 5);
    expect(l.columns).toBeGreaterThanOrEqual(40);
    expect(l.rows).toBeGreaterThanOrEqual(10);
  });
});
