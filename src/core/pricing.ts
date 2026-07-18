import type { Usage } from "./types.js";

// Approximate public API prices in USD per million tokens (2025-2026 era).
// Cache reads are billed at 0.1x input, cache writes at 1.25x input.
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const FALLBACK = PRICING["claude-sonnet-4-5"];

export function estimateCost(model: string, usage: Usage): number {
  const key = Object.keys(PRICING).find((k) => model === k || model.startsWith(k));
  const p = key ? PRICING[key] : FALLBACK;
  const dollars =
    usage.input * p.input +
    usage.output * p.output +
    usage.cacheRead * p.input * 0.1 +
    usage.cacheWrite * p.input * 1.25;
  return dollars / 1_000_000;
}
