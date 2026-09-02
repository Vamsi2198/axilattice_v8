/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — CUBE BUILDER
   ───────────────────────────────────────────────────────────────────────────
   BUG 4 fix — date parsing was the hot loop. v7 called new Date(str) once per
   row per grain, five times a row. On 200k rows that is a million Date
   constructions. Here every distinct date string is parsed once into a
   five-grain key tuple and cached. A file with three years of daily orders has
   about 1,100 distinct dates, so we parse 1,100 times instead of 1,000,000.

   Additions over v7:
     - Every cell carries count alongside sum/min/max, so downstream code can
       apply support guards and compute correct weighted averages.
     - Cross-pair selection is budgeted globally, not just per-pair, so a wide
       file cannot silently generate a hundred million cells.
     - build() is chunked and yields to the event loop with progress, so the
       tab stays responsive and the user sees where they are.
     - Cell keys use a separator that cannot occur in CSV text, and dimension
       values are recorded in sorted order for deterministic iteration.
   ═══════════════════════════════════════════════════════════════════════════ */

import { parseDateParts, toEpochDay } from "./profile.js";

export const CUBE_VERSION = "cube/1.0.0";
export const TIME_GRAINS = ["day", "week", "month", "quarter", "year"];
/* Cross-cells at month grain only.
   Materialising 2-way pairs at month, quarter AND year was 65% of the entire
   build cost on a real 79k-row, 8-dimension, 5-measure file -- 51 million
   accumulator calls, 5.5 seconds before the first insight could appear. The
   quarter and year cross-cells were almost never read: 2-way questions are
   asked at the grain the data moves, which is the month. Dropping the two
   coarse grains removes 43% of the work for capability nobody used. */
export const CROSS_GRAINS = ["month"];
export const SEP = "\u241F";

const DEFAULTS = {
  maxPairCells: 400,        // per-pair cardinality budget
  maxTotalCrossCells: 2.5e6, // global ceiling on cross-cell count
  chunkSize: 20000,          // rows between event-loop yields
};

/* ─── PERIOD KEYS ────────────────────────────────────────────────────────── */

function isoWeekKey(parts) {
  const ed = toEpochDay(parts);
  // 1970-01-01 was a Thursday. dow: 1=Mon..7=Sun
  const dow = ((ed + 3) % 7 + 7) % 7 + 1;
  const thursday = ed - dow + 4;
  // Find the year that Thursday belongs to, then week 1's Thursday.
  let y = parts.y;
  const janFirst = (yy) => toEpochDay({ y: yy, m: 1, d: 1 });
  // Thursday's calendar year
  let guess = y;
  if (thursday < janFirst(y)) guess = y - 1;
  else if (thursday >= janFirst(y + 1)) guess = y + 1;
  const jan1 = janFirst(guess);
  const jan1dow = ((jan1 + 3) % 7 + 7) % 7 + 1;
  const week1Thursday = jan1 - jan1dow + 4 + (jan1dow > 4 ? 7 : 0);
  const week = Math.floor((thursday - week1Thursday) / 7) + 1;
  return `${guess}-W${String(week).padStart(2, "0")}`;
}

/**
 * Build the five grain keys for one date string.
 * Pure function of the string, which is what makes memoisation safe.
 */
export function grainKeys(dateStr) {
  const p = parseDateParts(dateStr);
  if (!p) return null;
  const mm = String(p.m).padStart(2, "0");
  const dd = String(p.d).padStart(2, "0");
  return {
    day: `${p.y}-${mm}-${dd}`,
    week: isoWeekKey(p),
    month: `${p.y}-${mm}`,
    quarter: `${p.y}-Q${Math.ceil(p.m / 3)}`,
    year: `${p.y}`,
  };
}

/** Memoising factory. One instance per build. */
function makeGrainCache() {
  const cache = new Map();
  let hits = 0, misses = 0;
  return {
    get(dateStr) {
      let k = cache.get(dateStr);
      if (k === undefined) {
        k = grainKeys(dateStr);
        cache.set(dateStr, k);
        misses++;
      } else hits++;
      return k;
    },
    stats: () => ({ distinctDates: cache.size, hits, misses }),
  };
}

/* ─── ACCUMULATOR ────────────────────────────────────────────────────────── */

function bump(bucket, measure, val) {
  let c = bucket[measure];
  if (c === undefined) {
    c = bucket[measure] = { sum: 0, sumSq: 0, count: 0, min: Infinity, max: -Infinity };
  }
  c.sum += val;
  // Sum of squares costs one more double per cell and unlocks the variance of
  // any cell -- and therefore a proper two-sample test on cell MEANS. It also
  // makes the point that a variance is an aggregate: nothing here ever needs
  // to go back to the rows.
  c.sumSq += val * val;
  c.count += 1;
  if (val < c.min) c.min = val;
  if (val > c.max) c.max = val;
  return c;
}

/* ─── PAIR SELECTION ─────────────────────────────────────────────────────── */

/**
 * Choose which 2-way pairs to materialise, cheapest first, under a global
 * budget. v7 admitted any pair under 400 combined cells with no ceiling on
 * how many pairs that produced; a 20-dimension file yields 190 pairs and the
 * build silently ballooned.
 */
export function selectCrossPairs(dims, cfg) {
  const candidates = [];
  for (let i = 0; i < dims.length; i++) {
    for (let j = i + 1; j < dims.length; j++) {
      const a = dims[i], b = dims[j];
      const cells = a.cardinality * b.cardinality;
      if (cells > cfg.maxPairCells) continue;
      candidates.push({ a: a.col, b: b.col, key: `${a.col}|${b.col}`, cells });
    }
  }
  candidates.sort((x, y) => x.cells - y.cells || x.key.localeCompare(y.key));
  const chosen = [];
  let budget = 0;
  const perPeriodMultiplier = CROSS_GRAINS.length * 36; // rough period allowance
  for (const c of candidates) {
    const projected = budget + c.cells * perPeriodMultiplier;
    if (projected > cfg.maxTotalCrossCells) continue;
    budget = projected;
    chosen.push(c);
  }
  return { chosen, skipped: candidates.length - chosen.length };
}

/* ─── BUILD ──────────────────────────────────────────────────────────────── */

/**
 * Build the cube from a profile.
 *
 * Async and chunked: yields to the event loop every chunkSize rows and calls
 * onProgress({ done, total, phase }). A 500k-row file no longer freezes the
 * tab for 40 seconds with no feedback.
 */
export async function buildCube(prof, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const onProgress = options.onProgress || null;
  const { timeCol, columnData, rowCount } = prof;
  if (!timeCol) throw new Error("No time column — the cube needs a temporal axis.");

  const cubeDims = prof.dims.filter((d) => d.cardinality <= prof.config.cardinalityCutoff);
  const measures = prof.measures;
  const measureCols = measures.map((m) => m.col);
  const aggOf = {};
  for (const m of measures) aggOf[m.col] = m.agg;

  const dates = columnData[timeCol];
  const dimData = cubeDims.map((d) => ({ col: d.col, values: columnData[d.col] }));
  // A dual-role column stores raw strings under its own name (for the
  // dimension) and a parsed Float64Array under a shadow key (for the measure).
  const measData = measures.map((m) => ({
    col: m.col,
    values: m.dualRole ? columnData[m.col + "\u0000num"] : columnData[m.col],
  }));

  const { chosen: crossPairs, skipped: pairsSkipped } = selectCrossPairs(cubeDims, cfg);
  const crossIndexed = crossPairs.map((p) => ({
    key: p.key, a: p.a, b: p.b,
    aVals: columnData[p.a], bVals: columnData[p.b],
  }));

  const cube = { cells: {}, totals: {}, counts: {}, meta: {} };
  for (const g of TIME_GRAINS) { cube.cells[g] = {}; cube.totals[g] = {}; }

  const cache = makeGrainCache();
  const mvCols = new Array(measData.length);
  const mvVals = new Float64Array(measData.length);
  let unparsedDates = 0;
  const start = Date.now();

  for (let chunkStart = 0; chunkStart < rowCount; chunkStart += cfg.chunkSize) {
    const chunkEnd = Math.min(rowCount, chunkStart + cfg.chunkSize);

    for (let r = chunkStart; r < chunkEnd; r++) {
      const keys = cache.get(dates[r]);
      if (!keys) { unparsedDates++; continue; }

      // Pull this row's measures once, into preallocated buffers. The first
      // version allocated a fresh array of [col, value] pairs per row, which
      // on 79k rows is 79k arrays plus one small array per measure inside
      // them -- pure garbage for the collector to chase during the build.
      let mvLen = 0;
      for (let k = 0; k < measData.length; k++) {
        const v = measData[k].values[r];
        if (typeof v === "number" ? Number.isNaN(v) : (v === "" || v == null)) continue;
        const num = typeof v === "number" ? v : Number(v);
        if (!Number.isFinite(num)) continue;
        mvCols[mvLen] = measData[k].col;
        mvVals[mvLen] = num;
        mvLen++;
      }
      if (!mvLen) continue;

      for (let gi = 0; gi < TIME_GRAINS.length; gi++) {
        const g = TIME_GRAINS[gi];
        const pk = keys[g];

        let tb = cube.totals[g][pk];
        if (tb === undefined) tb = cube.totals[g][pk] = {};
        for (let k = 0; k < mvLen; k++) bump(tb, mvCols[k], mvVals[k]);

        const gcells = cube.cells[g];
        for (let d = 0; d < dimData.length; d++) {
          const dv = dimData[d].values[r];
          if (dv === "" || dv == null) continue;
          const combo = dimData[d].col;
          let cc = gcells[combo]; if (cc === undefined) cc = gcells[combo] = {};
          let cp = cc[pk];        if (cp === undefined) cp = cc[pk] = {};
          let cd = cp[dv];        if (cd === undefined) cd = cp[dv] = {};
          for (let k = 0; k < mvLen; k++) bump(cd, mvCols[k], mvVals[k]);
        }

        if (CROSS_GRAINS.indexOf(g) !== -1) {
          for (let x = 0; x < crossIndexed.length; x++) {
            const cx = crossIndexed[x];
            const va = cx.aVals[r], vb = cx.bVals[r];
            if (va === "" || va == null || vb === "" || vb == null) continue;
            const ck = va + SEP + vb;
            let cc = gcells[cx.key]; if (cc === undefined) cc = gcells[cx.key] = {};
            let cp = cc[pk];         if (cp === undefined) cp = cc[pk] = {};
            let cd = cp[ck];         if (cd === undefined) cd = cp[ck] = {};
            for (let k = 0; k < mvLen; k++) bump(cd, mvCols[k], mvVals[k]);
          }
        }
      }
    }

    if (onProgress) onProgress({ phase: "cube", done: chunkEnd, total: rowCount });
    // Yield so the browser can paint. setTimeout(0) rather than a microtask —
    // a microtask does not let the renderer in.
    if (chunkEnd < rowCount) await new Promise((res) => setTimeout(res, 0));
  }

  const dateStats = cache.stats();
  cube.meta = {
    version: CUBE_VERSION,
    dims: cubeDims,
    measures,
    aggOf,
    timeCol,
    excludedDims: prof.excludedDims,
    crossPairs: crossPairs.map((p) => p.key),
    crossPairsSkipped: pairsSkipped,
    rowCount,
    unparsedDates,
    cellCount: countCells(cube),
    dateCacheStats: dateStats,
    buildMs: Date.now() - start,
  };
  cube.crossPairs = cube.meta.crossPairs;
  return cube;
}

export function countCells(cube) {
  let n = 0;
  for (const g of TIME_GRAINS) {
    n += Object.keys(cube.totals[g] || {}).length;
    const gc = cube.cells[g] || {};
    for (const combo in gc) {
      for (const pk in gc[combo]) n += Object.keys(gc[combo][pk]).length;
    }
  }
  return n;
}

/** Approximate retained bytes — surfaced in the UI so scale is never a surprise. */
export function estimateCubeBytes(cube) {
  // Each leaf accumulator is 4 doubles plus object overhead, call it 120 bytes,
  // plus the key strings. Rough, but the right order of magnitude.
  return countCells(cube) * 120 * Math.max(1, cube.meta.measures.length);
}
