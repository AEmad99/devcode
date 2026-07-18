/**
 * Fuzzy ranking shared by slash menus, login provider picker, and model picker.
 * Higher score = better match; 0 = no match.
 */

export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  if (t === q) return 10_000;
  if (t.startsWith(q)) return 5_000 + q.length * 10 - (t.length - q.length);
  if (t.includes(q)) return 1_000 + q.length * 5 - t.indexOf(q);

  let ti = 0;
  let score = 0;
  let consecutive = 0;
  let first = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === ch) {
        found = j;
        break;
      }
    }
    if (found < 0) return 0;
    if (first < 0) first = found;
    if (found === ti) consecutive++;
    else consecutive = 0;
    score += 10 + consecutive * 15;
    if (found === 0 || t[found - 1] === "-" || t[found - 1] === "_" || t[found - 1] === " " || t[found - 1] === "/") {
      score += 25;
    }
    ti = found + 1;
  }
  score += Math.max(0, 50 - first * 3);
  score += Math.max(0, 40 - (t.length - q.length));
  return score;
}

/** Best score across multiple searchable fields for one item. */
export function fuzzyScoreMulti(query: string, fields: string[]): number {
  let best = 0;
  for (const f of fields) {
    if (!f) continue;
    const s = fuzzyScore(query, f);
    if (s > best) best = s;
  }
  return best;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/**
 * Rank items by fuzzy match. Empty query preserves input order.
 * Non-empty query drops score-0 rows and sorts best-first.
 */
export function rankByFuzzy<T>(items: T[], query: string, fieldsOf: (item: T) => string[]): Ranked<T>[] {
  const q = query.trim();
  if (!q) return items.map((item) => ({ item, score: 1 }));

  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    const score = fuzzyScoreMulti(q, fieldsOf(item));
    if (score > 0) ranked.push({ item, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}
