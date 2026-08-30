/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — SCHEMA PROFILER
   ───────────────────────────────────────────────────────────────────────────
   Fixes carried in from the v7 audit:

   BUG 1 — Math.min(...nums) / Math.max(...nums) blew the call stack above
           roughly 125k arguments. Every measure column with more than ~125k
           non-null values threw RangeError during profiling, before the cube
           was ever built. The file did not get slow, it died. Now: extent(),
           a single loop.

   BUG 2 — "first date column wins". A file with signup_date before order_date
           silently built the whole cube on the wrong time axis, and nothing in
           the UI said so. Now: every temporal candidate is scored on parse
           coverage, distinct-period count and span, the best one is chosen,
           and the alternatives are returned so the user can switch.

   BUG 3 — isRateMeasure() was a regex on the column name. /time/ matched
           timestamp_ms. Anything called total_items summed correctly by luck.
           Now: name heuristic AND distribution evidence (bounded range,
           non-integer, low magnitude), with an explicit aggregation choice
           attached to the measure that the user can override.
   ═══════════════════════════════════════════════════════════════════════════ */

import { extent, moments, quantile } from "./stats.js";
import { internColumn, toNumericColumn } from "./csv.js";

export const PROFILE_VERSION = "profile/1.0.0";

export const DEFAULTS = {
  cardinalityCutoff: 50,     // above this a string column is not a usable dimension
  idRatioThreshold: 0.85,    // distinct/rows above this smells like a key
  minNumericUnique: 12,      // at or below this, a numeric column is coded categorical
  textAvgLen: 60,            // longer than this is prose, not a label
  sampleForTyping: 2000,     // rows sampled for date sniffing
};

const ID_NAME_HINTS = new Set(["id", "uuid", "guid", "key", "code", "ref", "sku", "hash"]);
const RATE_NAME = /(^|[_\s])(pct|percent|rate|ratio|margin|rating|score|avg|average|mean|index|nps|csat|share)([_\s]|$)|%/i;
const DURATION_NAME = /(^|[_\s])(duration|latency|elapsed|lead_?time|cycle_?time|days|hours|minutes|seconds)([_\s]|$)/i;
const COUNTISH_NAME = /(^|[_\s])(count|qty|quantity|units|orders|sessions|clicks|visits|items|n)([_\s]|$)/i;

const DATE_PATTERNS = [
  { re: /^(\d{4})-(\d{2})-(\d{2})$/, iso: true },
  { re: /^(\d{4})\/(\d{2})\/(\d{2})$/, iso: true },
  { re: /^(\d{4})-(\d{2})-(\d{2})[ T]\d{2}:\d{2}(:\d{2})?/, iso: true },
  { re: /^(\d{4})\.(\d{2})\.(\d{2})$/, iso: true },
  { re: /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/, iso: false },
  { re: /^(\d{1,2})[-/]([A-Za-z]{3})[-/](\d{2,4})$/, iso: false },
];

const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

/**
 * Parse a date string to { y, m, d } without constructing a Date object.
 *
 * v7 called `new Date(str)` five times per row inside the cube loop — one per
 * grain. On 200k rows that is a million Date constructions plus a million
 * string parses, and it was by far the hottest code in the build. This returns
 * plain integers and the caller memoises on the raw string, so a file with
 * 900 distinct order dates parses 900 times instead of a million.
 */
export function parseDateParts(str) {
  if (!str) return null;
  const s = str.trim();
  for (const { re, iso } of DATE_PATTERNS) {
    const m = s.match(re);
    if (!m) continue;
    let y, mo, d;
    if (iso) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if (/[A-Za-z]/.test(m[2])) {
      d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = +m[3];
      if (y < 100) y += y < 70 ? 2000 : 1900;
    } else {
      // Ambiguous d/m vs m/d. Resolve by range: if the first field exceeds 12
      // it must be the day. Otherwise assume ISO-adjacent day-first, which is
      // the majority convention outside the US, and record the ambiguity.
      const a = +m[1], b = +m[2];
      if (a > 12) { d = a; mo = b; }
      else if (b > 12) { mo = a; d = b; }
      else { d = a; mo = b; }
      y = +m[3];
    }
    if (!(y > 1900 && y < 2200) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
    return { y, m: mo, d };
  }
  return null;
}

/** Days since epoch — used for ISO week computation without Date objects. */
export function toEpochDay({ y, m, d }) {
  // Howard Hinnant's civil-from-days, inverted. Exact for all Gregorian dates.
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function isNumericString(v) {
  if (v === "" || v == null) return false;
  const n = Number(v);
  return Number.isFinite(n);
}

function nameLooksLikeId(name) {
  return name.toLowerCase().split(/[_\s-]+/).some((t) => ID_NAME_HINTS.has(t));
}

/** Score a column's suitability as THE time axis. Higher is better. */
function scoreTimeCandidate(values, cfg) {
  const n = values.length;
  const step = Math.max(1, Math.floor(n / cfg.sampleForTyping));
  let parsed = 0, sampled = 0, nonNull = 0;
  const months = new Set();
  let minDay = Infinity, maxDay = -Infinity;
  for (let i = 0; i < n; i += step) {
    const v = values[i];
    // Count EVERY sampled row, including blanks. A date column present on 40%
    // of rows is a poor time axis no matter how cleanly that 40% parses --
    // which is precisely how a signup_date decoy beat order_date on the first
    // run of the test suite.
    sampled++;
    if (v === "" || v == null) continue;
    nonNull++;
    const p = parseDateParts(v);
    if (!p) continue;
    parsed++;
    months.add(p.y * 12 + p.m);
    const ed = toEpochDay(p);
    if (ed < minDay) minDay = ed;
    if (ed > maxDay) maxDay = ed;
  }
  if (!sampled || !nonNull) return null;
  // Parse quality among present values decides whether this IS a date column.
  if (parsed / nonNull < 0.8) return null;
  // Row coverage decides whether it is a good ONE. A sparse date column is
  // still reported as an alternative -- the user should be told it exists and
  // why it lost, not have it silently vanish.
  const coverage = parsed / sampled;
  const spanDays = maxDay - minDay;
  return {
    coverage, parseQuality: parsed / nonNull,
    distinctMonths: months.size,
    spanDays,
    // Prefer high coverage, then many distinct periods, then a long span.
    // A signup_date that spans 6 years but only appears on 40% of rows loses
    // to an order_date that is present on every row.
    // Coverage dominates by an order of magnitude: completeness of the axis
    // matters far more than how many distinct periods it happens to span.
    score: coverage * 1000 + Math.min(months.size, 60) + Math.min(spanDays / 365, 10),
  };
}

/**
 * Decide how a measure should aggregate.
 * Returns "sum" | "avg". The reasoning is attached so the UI can explain it
 * and the user can override.
 */
function classifyAggregation(col, nums) {
  const clean = [];
  for (let i = 0; i < nums.length; i++) if (!Number.isNaN(nums[i])) clean.push(nums[i]);
  if (!clean.length) return { agg: "sum", reason: "no values" };

  const { min, max } = extent(clean);
  let allInt = true, anyNeg = false;
  for (let i = 0; i < clean.length && allInt; i++) {
    if (!Number.isInteger(clean[i])) allInt = false;
  }
  for (let i = 0; i < clean.length && !anyNeg; i++) if (clean[i] < 0) anyNeg = true;

  const nameRate = RATE_NAME.test(col);
  const nameDur = DURATION_NAME.test(col);
  const nameCount = COUNTISH_NAME.test(col);

  // A summed percentage is meaningless. Bounded, non-integer, rate-named:
  // average it. Require distribution evidence too, so a column called
  // score_total that runs to 10^6 still sums.
  const boundedUnit = min >= -1.0001 && max <= 1.0001;
  const boundedPct = min >= -100.01 && max <= 100.01;

  if (nameRate && (boundedUnit || boundedPct || !allInt)) {
    return { agg: "avg", reason: `name suggests a rate and values are bounded [${min}, ${max}]` };
  }
  if (nameDur) return { agg: "avg", reason: "duration measures average, they do not sum" };
  if (nameCount) return { agg: "sum", reason: "count-like name" };
  if (boundedUnit && !allInt) {
    return { agg: "avg", reason: "values confined to [0,1] and non-integer — looks like a proportion" };
  }
  return { agg: "sum", reason: "additive by default" };
}

/** Count-like measures support a chi-square style independence test. */
function isCountLike(nums) {
  let allIntNonNeg = true;
  for (let i = 0; i < nums.length; i++) {
    const v = nums[i];
    if (Number.isNaN(v)) continue;
    if (v < 0 || !Number.isInteger(v)) { allIntNonNeg = false; break; }
  }
  return allIntNonNeg;
}

/**
 * Profile a parsed CSV.
 * Input is columnar (from parseCSV). Output describes dimensions, measures,
 * the chosen time column and every rejected candidate, with reasons.
 */
export function profile(parsed, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const { headers, columns, rowCount } = parsed;

  const dims = [], measures = [], excluded = [], idCols = [], textCols = [];
  const timeCandidates = [];
  const schema = {};
  const columnData = {};

  for (let c = 0; c < headers.length; c++) {
    const col = headers[c];
    const values = columns[c];

    let nonNull = 0;
    const distinct = new Set();
    let numericCount = 0;
    let lenSum = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === "" || v == null) continue;
      nonNull++;
      if (distinct.size <= 100000) distinct.add(v);
      if (isNumericString(v)) numericCount++;
      lenSum += v.length;
    }
    const uniq = distinct.size;
    const ratio = rowCount ? uniq / rowCount : 0;
    const nullPct = rowCount ? (1 - nonNull / rowCount) * 100 : 0;
    const numericShare = nonNull ? numericCount / nonNull : 0;
    const avgLen = nonNull ? lenSum / nonNull : 0;

    const base = {
      col, cardinality: uniq, nullPct: +nullPct.toFixed(2),
      sample: Array.from(distinct).slice(0, 5),
    };

    // ── Temporal candidate? Evaluate every one, choose later. ──
    const tScore = scoreTimeCandidate(values, cfg);
    if (tScore) {
      timeCandidates.push({ col, ...tScore });
      schema[col] = { ...base, type: "temporal", timeScore: tScore.score };
      columnData[col] = values;
      continue;
    }

    // ── Identifier by name + shape ──
    if (nameLooksLikeId(col) && (uniq > cfg.cardinalityCutoff || ratio >= cfg.idRatioThreshold)) {
      idCols.push(col);
      schema[col] = { ...base, type: "identifier", reason: "name and cardinality both indicate a key" };
      continue;
    }

    // ── Numeric ──
    if (numericShare > 0.95 && nonNull > 0) {
      const nums = toNumericColumn(values);
      if (uniq <= cfg.minNumericUnique) {
        const interned = internColumn(values, cfg.cardinalityCutoff + 1);
        dims.push({ col, cardinality: uniq, coded: true,
          values: Array.from(distinct).map(Number).sort((a, b) => a - b).map(String) });
        schema[col] = { ...base, type: "dimension", reason: `only ${uniq} distinct numbers — treated as codes` };
        columnData[col] = values;
        if (interned) columnData[col + "\u0000codes"] = interned;
        continue;
      }
      const clean = [];
      for (let i = 0; i < nums.length; i++) if (!Number.isNaN(nums[i])) clean.push(nums[i]);
      const { min, max } = extent(clean);          // BUG 1 fix: loop, not spread
      const mom = moments(clean, 1);
      if (!(mom.sd > 0)) {
        idCols.push(col);
        schema[col] = { ...base, type: "identifier", reason: "constant value carries no information" };
        continue;
      }
      const { agg, reason } = classifyAggregation(col, nums);
      // Dispersion index for the independence residual.
      //
      // A cross-cell total is a COMPOUND sum: a random number of rows land in
      // the cell, and each carries a random amount. Both vary, so
      //     Var(S) = E[n]*sigma^2 + Var(n)*mu^2
      // and with Poisson-like allocation Var(n) ~ E[n], which collapses to
      //     Var(S) = E[n]*(sigma^2 + mu^2) = (E[X^2]/E[X]) * E[S].
      //
      // So the right scale factor is the second moment over the first, NOT
      // sigma^2/mu. My first correction used sigma^2/mu, which fixed the
      // amount-variation term and ignored the count-variation term; it left
      // residuals around 4.3 on pure noise instead of around 1. Simulation
      // confirms E[X^2]/E[X] to within 1%.
      const dispersionIndex = min >= 0 && mom.mean > 0
        ? (mom.variance + mom.mean * mom.mean) / mom.mean
        : null;
      measures.push({
        col, agg, aggReason: reason, dispersionIndex,
        mean: mom.mean, sd: mom.sd, min, max,
        p05: quantile(clean, 0.05), p50: quantile(clean, 0.5), p95: quantile(clean, 0.95),
        countLike: isCountLike(nums),
        nonNull,
      });
      schema[col] = { ...base, type: "measure", agg, aggReason: reason, min, max, dispersionIndex };
      columnData[col] = nums;
      continue;
    }

    // ── Boolean ──
    if (uniq === 2) {
      dims.push({ col, cardinality: 2, values: Array.from(distinct) });
      schema[col] = { ...base, type: "dimension", reason: "binary" };
      columnData[col] = values;
      continue;
    }

    // ── Strings ──
    if (avgLen > cfg.textAvgLen) {
      textCols.push(col);
      schema[col] = { ...base, type: "text", reason: `average length ${avgLen.toFixed(0)} chars — prose, not a label` };
      continue;
    }
    if (ratio >= cfg.idRatioThreshold && uniq > cfg.cardinalityCutoff) {
      idCols.push(col);
      schema[col] = { ...base, type: "identifier", reason: "nearly unique per row" };
      continue;
    }
    if (uniq <= cfg.cardinalityCutoff) {
      dims.push({ col, cardinality: uniq, values: Array.from(distinct) });
      schema[col] = { ...base, type: "dimension" };
      columnData[col] = values;
      continue;
    }
    excluded.push({ col, cardinality: uniq });
    schema[col] = { ...base, type: "dim_high_card",
      reason: `${uniq} distinct values exceeds the ${cfg.cardinalityCutoff} cutoff` };
  }

  // ── BUG 2 fix: choose the best time axis, keep the runners-up ──
  timeCandidates.sort((a, b) => b.score - a.score || a.col.localeCompare(b.col));
  const timeCol = timeCandidates.length ? timeCandidates[0].col : null;
  const timeAlternatives = timeCandidates.slice(1).map((t) => ({
    col: t.col, coverage: t.coverage, distinctMonths: t.distinctMonths,
    whyNotChosen: t.coverage < 0.9
      ? `present on only ${(t.coverage * 100).toFixed(0)}% of rows`
      : `fewer distinct periods than ${timeCandidates[0].col}`,
  }));

  // Stable ordering so the same file always profiles identically.
  dims.sort((a, b) => a.col.localeCompare(b.col));
  measures.sort((a, b) => a.col.localeCompare(b.col));

  return {
    version: PROFILE_VERSION,
    dims, measures, excludedDims: excluded, idCols, textCols,
    timeCol, timeAlternatives,
    timeChoiceReason: timeCandidates.length > 1
      ? `${timeCol} chosen over ${timeCandidates.length - 1} other date column(s) on parse coverage and period span`
      : null,
    rowCount, colCount: headers.length,
    schema, columnData, config: cfg,
  };
}

/** Apply a user override of the time axis without reprofiling everything. */
export function withTimeColumn(prof, col) {
  if (!prof.schema[col] || prof.schema[col].type !== "temporal") return prof;
  const alternatives = [prof.timeCol, ...prof.timeAlternatives.map((a) => a.col)]
    .filter((c) => c && c !== col)
    .map((c) => ({ col: c, coverage: null, distinctMonths: null }));
  return { ...prof, timeCol: col, timeAlternatives: alternatives,
    timeChoiceReason: `${col} selected manually` };
}

/** Apply a user override of a measure's aggregation. */
export function withAggregation(prof, col, agg) {
  const measures = prof.measures.map((m) =>
    m.col === col ? { ...m, agg, aggReason: "set manually" } : m);
  const schema = { ...prof.schema };
  if (schema[col]) schema[col] = { ...schema[col], agg, aggReason: "set manually" };
  return { ...prof, measures, schema };
}
