/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — QUERY API
   ───────────────────────────────────────────────────────────────────────────
   Every result carries `n` — the number of source rows behind the number.
   That single field is what lets the insight layer refuse to report a 400%
   swing that rests on three rows. v7 threw the count away at query time, so
   nothing downstream could tell a real move from a small-sample artefact.
   ═══════════════════════════════════════════════════════════════════════════ */

import { TIME_GRAINS, SEP } from "./cube.js";

export const QUERY_VERSION = "query/1.0.0";

function aggOf(cube, measure) {
  return cube.meta.aggOf?.[measure] || "sum";
}

/** Reduce a stored accumulator to a scalar under the measure's aggregation. */
function reduceCell(cell, measure, agg) {
  const c = cell?.[measure];
  if (!c || !c.count) return { value: null, n: 0 };
  return { value: agg === "avg" ? c.sum / c.count : c.sum, n: c.count };
}

export function allPeriods(cube, grain) {
  return Object.keys(cube.totals[grain] || {}).sort();
}

export function latestPeriod(cube, grain) {
  const ps = allPeriods(cube, grain);
  return ps.length ? ps[ps.length - 1] : null;
}

/** Grains that actually hold enough periods to reason about. */
export function usableGrains(cube, minPeriods = 3) {
  return TIME_GRAINS.filter((g) => allPeriods(cube, g).length >= minPeriods);
}

export function resolveGrain(cube, requested, minPeriods = 3) {
  const order = ["month", "quarter", "year", "week", "day"];
  if (requested && allPeriods(cube, requested).length >= minPeriods) return requested;
  for (const g of order) if (allPeriods(cube, g).length >= minPeriods) return g;
  for (const g of order) if (allPeriods(cube, g).length >= 1) return g;
  return requested || "month";
}

/** Breakdown of a measure across a dimension's members for one period. */
export function queryBreakdown(cube, dim, measure, grain, period) {
  const pk = period || latestPeriod(cube, grain);
  if (!pk) return [];
  const bucket = cube.cells[grain]?.[dim]?.[pk] || {};
  const agg = aggOf(cube, measure);
  const out = [];
  for (const label of Object.keys(bucket)) {
    const { value, n } = reduceCell(bucket[label], measure, agg);
    if (value === null) continue;
    out.push({ label, value, n });
  }
  // Deterministic: value desc, then label asc to break ties reproducibly.
  out.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  return out;
}

/** Time series for a measure, optionally sliced to one dimension member. */
export function queryTrend(cube, measure, grain, nPeriods = 12, dim = null, dimValue = null) {
  const periods = allPeriods(cube, grain);
  const slice = nPeriods ? periods.slice(-nPeriods) : periods;
  const agg = aggOf(cube, measure);
  return slice.map((pk) => {
    const cell = dim && dimValue != null
      ? cube.cells[grain]?.[dim]?.[pk]?.[dimValue]
      : cube.totals[grain]?.[pk];
    const { value, n } = reduceCell(cell, measure, agg);
    return { period: pk, value: value === null ? 0 : value, n, present: value !== null };
  });
}

export function queryTotal(cube, measure, grain, period) {
  const pk = period || latestPeriod(cube, grain);
  if (!pk) return { value: null, delta: null, period: null, n: 0 };
  const agg = aggOf(cube, measure);
  const cur = reduceCell(cube.totals[grain]?.[pk], measure, agg);
  const periods = allPeriods(cube, grain);
  const idx = periods.indexOf(pk);
  let delta = null, prevValue = null;
  if (idx > 0) {
    const prev = reduceCell(cube.totals[grain]?.[periods[idx - 1]], measure, agg);
    prevValue = prev.value;
    if (prev.value) delta = (cur.value - prev.value) / prev.value;
  }
  return { value: cur.value, n: cur.n, delta, prevValue, period: pk, agg };
}

export function queryTopK(cube, dim, measure, grain, k = 5, period) {
  return queryBreakdown(cube, dim, measure, grain, period).slice(0, k);
}

export function queryDelta(cube, dim, dimValue, measure, grain, period) {
  const periods = allPeriods(cube, grain);
  if (periods.length < 2) return null;
  const pk = period || periods[periods.length - 1];
  const idx = periods.indexOf(pk);
  if (idx < 1) return null;
  const agg = aggOf(cube, measure);
  const get = (p) => reduceCell(cube.cells[grain]?.[dim]?.[p]?.[dimValue], measure, agg).value ?? 0;
  const cur = get(pk), prev = get(periods[idx - 1]);
  return prev ? (cur - prev) / prev : null;
}

/** Locate the materialised combo key for an unordered dimension pair. */
export function findCrossCombo(cube, dimA, dimB) {
  const pairs = cube.crossPairs || [];
  for (const c of pairs) {
    const [a, b] = c.split("|");
    if ((a === dimA && b === dimB) || (a === dimB && b === dimA)) return c;
  }
  return null;
}

export function queryCrossBreakdown(cube, dimA, dimB, measure, grain, period) {
  const pk = period || latestPeriod(cube, grain);
  if (!pk) return [];
  const combo = findCrossCombo(cube, dimA, dimB);
  if (!combo) return [];
  const [firstCol] = combo.split("|");
  const flip = firstCol !== dimA;
  const bucket = cube.cells[grain]?.[combo]?.[pk] || {};
  const agg = aggOf(cube, measure);
  const out = [];
  for (const key of Object.keys(bucket)) {
    const idx = key.indexOf(SEP);
    const v1 = key.slice(0, idx), v2 = key.slice(idx + 1);
    const { value, n } = reduceCell(bucket[key], measure, agg);
    if (value === null) continue;
    out.push({ a: flip ? v2 : v1, b: flip ? v1 : v2, value, n });
  }
  out.sort((x, y) => y.value - x.value || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return out;
}

export function queryCrossCell(cube, dimA, dimB, valA, valB, measure, grain, period) {
  const rows = queryCrossBreakdown(cube, dimA, dimB, measure, grain, period);
  const hit = rows.find((r) => r.a === valA && r.b === valB);
  return hit || { a: valA, b: valB, value: null, n: 0 };
}

/** Every member of a dimension paired across two periods — feeds decomposition. */
export function queryPeriodPair(cube, dim, measure, grain, periodA, periodB) {
  const agg = aggOf(cube, measure);
  const bucketA = cube.cells[grain]?.[dim]?.[periodA] || {};
  const bucketB = cube.cells[grain]?.[dim]?.[periodB] || {};
  const labels = new Set([...Object.keys(bucketA), ...Object.keys(bucketB)]);
  const out = [];
  for (const label of Array.from(labels).sort()) {
    const a = reduceCell(bucketA[label], measure, agg);
    const b = reduceCell(bucketB[label], measure, agg);
    out.push({
      key: label,
      before: a.value ?? 0, after: b.value ?? 0,
      nBefore: a.n, nAfter: b.n,
    });
  }
  return out;
}

/** Raw sum/count pair — needed for mix/rate decomposition of averages. */
export function queryRaw(cube, dim, measure, grain, period) {
  const bucket = cube.cells[grain]?.[dim]?.[period] || {};
  const out = [];
  for (const label of Object.keys(bucket).sort()) {
    const c = bucket[label]?.[measure];
    if (!c || !c.count) continue;
    out.push({ key: label, sum: c.sum, count: c.count, mean: c.sum / c.count });
  }
  return out;
}
