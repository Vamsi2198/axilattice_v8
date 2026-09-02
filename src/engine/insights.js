/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — INSIGHT DISCOVERY
   ───────────────────────────────────────────────────────────────────────────
   This is where the v7 audit findings become behaviour.

   BUG 2 (dead zone) — replaced the fixed z >= 1.5 threshold with Grubbs' test.
   Small dimensions can now produce findings, and untestable ones say so.

   BUG 3 (noise) — v7 scored cells as |sibZ| + 0.8|tempZ| + 3.0|drop| with a
   cutoff of 1.0. The 3.0 weight meant a 33% period-over-period move cleared
   the bar unaided, and there was no support guard on the single-dimension
   path, so a cell holding four rows outranked one holding forty thousand.
   Now every candidate must clear a minimum row count and a minimum share of
   the period before it is even tested.

   NEW — multiplicity control. A full traversal runs thousands of tests. At
   alpha = 0.05, a thousand tests on pure noise yield fifty "findings". Every
   BI tool that ranks by raw score and shows the top six is, most of the time,
   showing you six random numbers. We apply Benjamini-Hochberg across the whole
   traversal and report q-values, plus how many tests were run to get there.

   The honest consequence: on genuinely flat data this returns nothing, and
   says "3,412 cells tested, none survived correction at q < 0.10". That is a
   real answer. Manufacturing six insights from noise is not.
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  grubbsTest, lastPointTest, benjaminiHochberg, robustZScores,
  cohenD, contributionDecomposition, mixRateDecomposition,
  persistenceTest, welchFromStats,
} from "./stats.js";
import {
  queryBreakdown, queryTrend, allPeriods,
  latestPeriod, resolveGrain, queryPeriodPair, queryRaw, findCrossCombo,
} from "./query.js";
import { SEP } from "./cube.js";

export const INSIGHTS_VERSION = "insights/1.0.0";

export const DISCOVERY_DEFAULTS = {
  fdrQ: 0.10,          // false discovery rate we are willing to accept
  minCellRows: 30,     // a cell backed by fewer rows is not evidence
  minShare: 0.005,     // and it must be at least 0.5% of the period
  // Grubbs is formally defined from n = 3, but at n = 3 the maximum
  // attainable G is 1.155 and the statistic explodes whenever two of the
  // three members happen to sit close together -- which on random data
  // produced a confident-looking p on a 3-member dimension of pure noise.
  // The parametric test is used only where it has power. Small dimensions
  // are covered by the exact binomial persistence test instead, which has
  // MORE power there, not less.
  minMembers: 6,
  minPersistPeriods: 6,// panel length before a rank-persistence test is run
  minHistory: 5,       // periods of history before a temporal claim
  maxTests: 200000,    // safety valve on pathological schemas
  maxFeed: 30,         // cards produced on connect
  maxPerPair: 2,       // findings per measure per dimension (or dimension pair)
  maxPerValue: 3,      // findings per measure mentioning the same member
};

/* ─── SUPPORT FILTERING ──────────────────────────────────────────────────── */

/**
 * Drop members that cannot carry a claim, and report what was dropped.
 * Returning the exclusions matters: "12 of 19 regions had fewer than 30 rows
 * and were not tested" is information the analyst needs, not noise to hide.
 */
function applySupport(rows, cfg) {
  let total = 0;
  for (const r of rows) total += Math.abs(r.value);
  const kept = [], dropped = [];
  for (const r of rows) {
    const share = total > 0 ? Math.abs(r.value) / total : 0;
    if (r.n < cfg.minCellRows || share < cfg.minShare) {
      dropped.push({ ...r, share, reason: r.n < cfg.minCellRows ? "low row count" : "negligible share" });
    } else kept.push({ ...r, share });
  }
  return { kept, dropped, total };
}

/* ─── SIGNAL 1: SIBLING DEVIATION ────────────────────────────────────────── */

function siblingCandidates(cube, measure, dim, grain, period, cfg) {
  const raw = queryBreakdown(cube, dim, measure, grain, period);
  if (raw.length < 2) return [];
  const { kept, dropped } = applySupport(raw, cfg);
  if (kept.length < cfg.minMembers) {
    return [{
      kind: "sibling", untestable: true, measure, dim, grain, period,
      members: kept.length, droppedMembers: dropped.length,
      reason: kept.length < 2
        ? `only ${kept.length} member(s) of ${dim} clear the support floor`
        : `${kept.length} testable members of ${dim} — Grubbs needs ${cfg.minMembers}`,
    }];
  }
  const values = kept.map((k) => k.value);
  const g = grubbsTest(values, { minN: cfg.minMembers });
  if (!g.testable) {
    return [{ kind: "sibling", untestable: true, measure, dim, grain, period,
      members: kept.length, reason: g.reason }];
  }
  const rz = robustZScores(values);
  const target = kept[g.index];
  const others = values.filter((_, i) => i !== g.index);
  return [{
    kind: "sibling",
    measure, dim, value: target.label, grain, period,
    val: target.value, n: target.n, share: target.share,
    test: "grubbs-two-sided", statistic: g.G, ceiling: g.ceiling,
    p: g.p, members: kept.length, droppedMembers: dropped.length,
    robustZ: rz.z[g.index], robustBasis: rz.basis,
    // Cohen's d against a handful of points is not an effect size, it is an
    // artefact of the denominator. Suppress it below 5 comparison members.
    effect: others.length >= 5 ? cohenD(target.value, others) : null,
    lowPower: g.lowPower, degenerate: g.degenerate,
    siblingMean: g.mean, siblingSd: g.sd,
    direction: target.value > g.mean ? "above" : "below",
    peers: kept,
  }];
}

/* ─── SIGNAL 2: TEMPORAL DEVIATION ───────────────────────────────────────── */

function temporalCandidates(cube, measure, dim, grain, period, cfg) {
  const raw = queryBreakdown(cube, dim, measure, grain, period);
  const { kept } = applySupport(raw, cfg);
  const out = [];
  const periods = allPeriods(cube, grain);
  const endIdx = periods.indexOf(period);
  if (endIdx < cfg.minHistory) return out;
  const window = Math.min(13, endIdx + 1);

  for (const member of kept) {
    const tr = queryTrend(cube, measure, grain, null, dim, member.label)
      .filter((t) => periods.indexOf(t.period) <= endIdx)
      .slice(-window);
    // Require the history to be genuinely observed, not zero-filled.
    const observed = tr.filter((t) => t.present);
    if (observed.length < cfg.minHistory + 1) continue;
    const series = tr.map((t) => t.value);
    const t = lastPointTest(series, { minHistory: cfg.minHistory });
    if (!t.testable) continue;
    const prev = series[series.length - 2];
    out.push({
      kind: "temporal",
      measure, dim, value: member.label, grain, period,
      val: member.value, n: member.n, share: member.share,
      test: "studentized-deviation", statistic: t.t, p: t.p,
      histMean: t.histMean, histSd: t.histSd, historyN: t.n,
      pctChange: prev ? (t.latest - prev) / prev : null,
      direction: t.latest > t.histMean ? "above" : "below",
      series: tr,
    });
  }
  return out;
}

/* ─── SIGNAL 2b: RANK PERSISTENCE (the small-dimension rescue) ───────────── */

/**
 * Grubbs on a 3-member dimension has a hard arithmetic ceiling of G = 1.155,
 * so even a genuine 3x effect tops out around p = 0.07. That is not a defect
 * in the test, it is what three numbers are worth.
 *
 * But three members watched over eighteen periods is not three numbers. If
 * Enterprise is the largest segment in all eighteen months, the probability
 * of that under exchangeable members is (1/3)^18. The evidence lives in the
 * panel, not the cross-section, and an exact binomial test reads it directly.
 *
 * This is why the segment effect in the test suite is found with overwhelming
 * confidence while the single-period test could only manage borderline.
 */
function persistenceCandidates(cube, measure, dim, grain, period, cfg) {
  const periods = allPeriods(cube, grain);
  const endIdx = periods.indexOf(period);
  if (endIdx < cfg.minPersistPeriods - 1) return [];
  const window = periods.slice(Math.max(0, endIdx - 23), endIdx + 1);

  const topHits = new Map(), bottomHits = new Map();
  let observed = 0, memberCount = 0;
  const lastSeen = new Map();

  for (const pk of window) {
    const rows = queryBreakdown(cube, dim, measure, grain, pk);
    const { kept } = applySupport(rows, cfg);
    if (kept.length < 2) continue;
    observed++;
    memberCount = Math.max(memberCount, kept.length);
    // kept is already sorted by value descending.
    const top = kept[0].label, bottom = kept[kept.length - 1].label;
    topHits.set(top, (topHits.get(top) || 0) + 1);
    bottomHits.set(bottom, (bottomHits.get(bottom) || 0) + 1);
    for (const k of kept) lastSeen.set(k.label, k);
  }
  if (observed < cfg.minPersistPeriods || memberCount < 2) return [];

  const out = [];
  const emit = (label, hits, extreme) => {
    const t = persistenceTest(hits, observed, memberCount);
    if (!t.testable || t.p >= 0.5) return;
    const cell = lastSeen.get(label);
    if (!cell) return;
    out.push({
      kind: "persistence",
      measure, dim, value: label, grain, period,
      val: cell.value, n: cell.n, share: cell.share,
      test: "binomial-persistence", statistic: hits / observed, p: t.p,
      hits, observedPeriods: observed, members: memberCount,
      expectedHits: t.expected, extreme,
      direction: extreme === "top" ? "above" : "below",
    });
  };
  for (const [label, hits] of Array.from(topHits.entries()).sort()) emit(label, hits, "top");
  // On a two-member dimension the bottom is the complement of the top, so
  // "Standard is always highest" and "Express is always lowest" are one fact
  // written twice. Emitting both put four cards on the feed that were really
  // two. Above two members the bottom is genuinely separate information.
  if (memberCount > 2) {
    for (const [label, hits] of Array.from(bottomHits.entries()).sort()) emit(label, hits, "bottom");
  }
  return out;
}

/* ─── SIGNAL 3: CROSS-CELL INTERACTION ───────────────────────────────────── */

/**
 * v7 computed expected = (A_total x B_total) / grand_total and reported
 * log2 lift as an insight. That expectation is the chi-square independence
 * model, which is only distributionally valid for counts. Revenue is not a
 * count, so no p-value can be attached to its residual without assuming a
 * distribution nobody checked.
 *
 * So: count-like measures get a Pearson residual and a real p-value.
 * Everything else gets the lift as a labelled DESCRIPTIVE effect, with no
 * p-value and no place in the FDR pool. It appears on the card marked as such.
 */
function crossCandidates(cube, measure, dimA, dimB, grain, period, cfg, meta) {
  const combo = findCrossCombo(cube, dimA, dimB);
  if (!combo) return [];
  const pk = period || latestPeriod(cube, grain);
  const bucket = cube.cells[grain]?.[combo]?.[pk] || {};
  const keys = Object.keys(bucket);
  if (keys.length < 4) return [];

  /* WHY THIS TEST CHANGED.
   *
   * The previous version compared each cell's measure TOTAL against what
   * independence of the marginal totals predicts. On a real file that produced
   * six near-identical cards: DS-07 x rating=2 was "over-represented" on
   * order_value at 6.4x, on delivery_min at 4.3x, and on items at 5.9x.
   *
   * Those are not three findings. They are one finding -- more rows land in
   * that cell than independence predicts -- restated once per measure, because
   * every additive total inherits the row-count imbalance. Reporting it three
   * times both clutters the feed and implies three independent pieces of
   * evidence for something the data said once.
   *
   * So the test now asks the question people actually mean: conditional on how
   * many rows are in this cell, is the AVERAGE unusual? "Deliveries from DS-07
   * at night take longer" is a claim about a mean. A Welch t-test of the cell
   * against everything else answers it directly, is correctly specified for a
   * continuous measure, and is computable entirely from the aggregates the
   * cube already holds. Row-count imbalance is a separate fact and gets its
   * own separate test below.
   */
  const grand = { n: 0, sum: 0, sumSq: 0 };
  const cells = [];
  for (const key of keys) {
    const c = bucket[key]?.[measure];
    if (!c || !c.count) continue;
    grand.n += c.count; grand.sum += c.sum; grand.sumSq += c.sumSq || 0;
    const idx = key.indexOf(SEP);
    cells.push({ key, a: key.slice(0, idx), b: key.slice(idx + 1), c });
  }
  if (!grand.n || !(grand.sumSq > 0)) return [];

  const out = [];
  for (const cell of cells) {
    if (cell.c.count < cfg.minCellRows) continue;
    const rest = {
      n: grand.n - cell.c.count,
      sum: grand.sum - cell.c.sum,
      sumSq: grand.sumSq - (cell.c.sumSq || 0),
    };
    const w = welchFromStats(
      { n: cell.c.count, sum: cell.c.sum, sumSq: cell.c.sumSq || 0 }, rest);
    if (!w.testable) continue;
    out.push({
      kind: "cross", measure, dimA, dimB, a: cell.a, b: cell.b, grain, period: pk,
      val: w.mean1, restMean: w.mean2, n: cell.c.count,
      share: grand.sum ? cell.c.sum / grand.sum : 0,
      test: "welch-t", statistic: w.t, p: w.p, effect: w.effect,
      lift: w.mean2 ? w.mean1 / w.mean2 : null,
      direction: w.diff > 0 ? "above" : "below",
    });
  }
  /* EVERY tested cell goes into the pool, including the boring ones.
   *
   * The first version of this sorted by effect size and kept the top three,
   * then handed their raw p-values to the FDR step. That is selection: you
   * cannot go looking for the largest of forty cells and then report its
   * nominal p-value as though you had picked it in advance. It is the same
   * error the fixed z-threshold made, one level up -- and the null-dataset
   * test caught it immediately, firing on region=East x segment=Mid in data
   * with no planted effect at all.
   *
   * Returning everything is the honest fix: the tests were genuinely run, so
   * they belong in the denominator. Benjamini-Hochberg then prices the search
   * correctly, and the feed's diversity selector decides what gets DISPLAYED
   * from among what survived -- which is a presentation choice made after the
   * statistics, not a shortcut taken before them.
   */
  return out;
}

function normalCdfLocal(z) {
  // local copy to avoid a circular import cost in the hot path
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/* ─── THE TRAVERSAL ──────────────────────────────────────────────────────── */

/**
 * Walk the cube, test every eligible cell, correct for multiplicity, return
 * ranked findings plus a full audit of what was tested and what was skipped.
 */
export function discoverInsights(cube, options = {}) {
  const cfg = { ...DISCOVERY_DEFAULTS, ...options };
  const grain = resolveGrain(cube, options.grain);
  const period = options.period || latestPeriod(cube, grain);
  const measures = cube.meta.measures;
  const dims = cube.meta.dims.map((d) => d.col);

  const candidates = [];
  const untestable = [];
  let tests = 0;

  for (const m of measures) {
    const measure = m.col;
    for (const dim of dims) {
      if (tests > cfg.maxTests) break;
      // A dual-role column must never be tested against itself. "tip = 30 is
      // extreme on tip" is true by construction and tells you nothing.
      if (dim === measure) continue;
      for (const c of siblingCandidates(cube, measure, dim, grain, period, cfg)) {
        if (c.untestable) untestable.push(c); else { candidates.push(c); tests++; }
      }
      for (const c of temporalCandidates(cube, measure, dim, grain, period, cfg)) {
        candidates.push(c); tests++;
      }
      for (const c of persistenceCandidates(cube, measure, dim, grain, period, cfg)) {
        candidates.push(c); tests++;
      }
    }
    for (let i = 0; i < dims.length; i++) {
      for (let j = i + 1; j < dims.length; j++) {
        if (dims[i] === measure || dims[j] === measure) continue;
        for (const c of crossCandidates(cube, measure, dims[i], dims[j], grain, period, cfg, m)) {
          candidates.push(c);
          if (c.p != null) tests++;
        }
      }
    }
  }

  // ── Multiplicity correction over everything that carries a p-value ──
  const tested = candidates.filter((c) => c.p != null);
  const descriptive = candidates.filter((c) => c.p == null);
  const qs = benjaminiHochberg(tested.map((c) => c.p));
  tested.forEach((c, i) => { c.q = qs[i]; c.significant = qs[i] <= cfg.fdrQ; });

  const survivors = tested.filter((c) => c.significant);

  // ── The feed: everything, tiered, deduped, ranked ──
  const lowCeiling = Math.max(cfg.fdrQ, 0.35);
  const feedPool = [
    ...tested.filter((c) => c.q <= lowCeiling),
    ...descriptive,
  ];
  const feed = dedupeBySubject(feedPool).map((c) => {
    const t = assignTier(c, cfg);
    return { ...c, ...t };
  });

  // Within a tier, rank by effect size rather than p-value. A tiny p on a
  // trivial effect is a large sample, not an important fact.
  const rank = { high: 0, medium: 1, low: 2 };
  const strength = (c) =>
    Math.abs(c.effect ?? 0) * 2 + Math.abs(c.share ?? 0) + Math.abs(c.statistic ?? 0) * 0.05;
  feed.sort((a, b) =>
    rank[a.tier] - rank[b.tier] ||
    strength(b) - strength(a) ||
    (a.q ?? 1) - (b.q ?? 1) ||
    String(a.value ?? a.a).localeCompare(String(b.value ?? b.a)));

  /* DIVERSITY.
   *
   * Ranking alone produced a feed where the first six cards all said the same
   * thing: every combination involving rating = 1 showed slow deliveries,
   * because in that dataset rating is a CONSEQUENCE of delivery time. The
   * engine cannot know which way the arrow points -- that is exactly the
   * causal claim it refuses to make -- but it can refuse to spend the whole
   * feed restating one relationship.
   *
   * So selection is round-robin across measures with per-subject caps. The
   * ranking still decides what wins inside each bucket; diversity decides how
   * many turns each bucket gets. A reader gets the strongest finding about
   * every measure before they get the second-strongest about any of them.
   */
  const capped = selectDiverse(feed, cfg);
  for (const c of capped) c.why = explain(c);
  for (const c of survivors) c.why = c.why || explain(c);
  for (const c of descriptive) c.why = c.why || explain(c);

  const counts = { high: 0, medium: 0, low: 0 };
  for (const c of capped) counts[c.tier]++;

  return {
    version: INSIGHTS_VERSION,
    grain, period,
    insights: survivors,
    feed: capped,
    tierCounts: counts,
    descriptive: descriptive.slice(0, 6),
    audit: {
      testsRun: tested.length,
      survived: survivors.length,
      fdrQ: cfg.fdrQ,
      descriptiveOnly: descriptive.length,
      untestableGroups: untestable.length,
      untestableReasons: untestable.slice(0, 8).map((u) => u.reason),
      supportFloor: { minCellRows: cfg.minCellRows, minShare: cfg.minShare },
      // The honest headline when nothing survives.
      tierCounts: counts,
      verdict: survivors.length
        ? `${survivors.length} of ${tested.length} tested cells survive correction at q <= ${cfg.fdrQ}. ` +
          `Showing ${capped.length}: ${counts.high} high, ${counts.medium} medium, ${counts.low} low.`
        : `${tested.length} cells tested, none survive multiplicity correction at q <= ${cfg.fdrQ}. This data looks flat.` +
          (counts.low ? ` ${counts.low} unproven pattern(s) are listed under low priority.` : ""),
    },
  };
}

/* ─── FEED SELECTION ─────────────────────────────────────────────────────── */

function selectDiverse(feed, cfg) {
  const byMeasure = new Map();
  for (const c of feed) {
    if (!byMeasure.has(c.measure)) byMeasure.set(c.measure, []);
    byMeasure.get(c.measure).push(c);
  }
  const queues = Array.from(byMeasure.values());
  const chosen = [];
  const perPair = new Map();   // measure|dimA|dimB -> count
  const perValue = new Map();  // measure|dim=value -> count
  const cursor = new Array(queues.length).fill(0);

  let progress = true;
  while (chosen.length < cfg.maxFeed && progress) {
    progress = false;
    for (let qi = 0; qi < queues.length && chosen.length < cfg.maxFeed; qi++) {
      const q = queues[qi];
      while (cursor[qi] < q.length) {
        const c = q[cursor[qi]++];
        const pairKey = c.kind === "cross"
          ? `${c.measure}|${[c.dimA, c.dimB].sort().join("×")}`
          : `${c.measure}|${c.dim}`;
        const valKeys = c.kind === "cross"
          ? [`${c.measure}|${c.dimA}=${c.a}`, `${c.measure}|${c.dimB}=${c.b}`]
          : [`${c.measure}|${c.dim}=${c.value}`];
        if ((perPair.get(pairKey) || 0) >= cfg.maxPerPair) continue;
        if (valKeys.some((k) => (perValue.get(k) || 0) >= cfg.maxPerValue)) continue;
        perPair.set(pairKey, (perPair.get(pairKey) || 0) + 1);
        for (const k of valKeys) perValue.set(k, (perValue.get(k) || 0) + 1);
        chosen.push(c);
        progress = true;
        break;
      }
    }
  }
  const rank = { high: 0, medium: 1, low: 2 };
  chosen.sort((a, b) => rank[a.tier] - rank[b.tier] ||
    Math.abs(b.effect ?? 0) - Math.abs(a.effect ?? 0) || (a.q ?? 1) - (b.q ?? 1));
  return chosen;
}

/* ─── PRIORITY TIERS ─────────────────────────────────────────────────────── */

/**
 * Rank every candidate into HIGH / MEDIUM / LOW.
 *
 * The first version of this engine reported only what cleared q <= 0.10 and
 * showed nothing else. Statistically that is defensible; as a product it is
 * not, because a user who connects a live dataset and sees three lines has no
 * way to tell a well-behaved dataset from a broken tool.
 *
 * The resolution is that the TIER IS THE EVIDENCE STANDARD. Nothing is hidden
 * and nothing is promoted beyond what its statistics support:
 *
 *   HIGH   — survives correction at q <= 0.01, has power, and the effect is
 *            material. Act on these.
 *   MEDIUM — survives at the standard q <= 0.10 bar, but the effect is
 *            smaller or the test had limited power. Real, less urgent.
 *   LOW    — did NOT clear the correction bar, or carries no applicable test
 *            at all. Shown for completeness and labelled as unproven.
 *
 * A reader who only trusts HIGH gets exactly the old behaviour. A reader who
 * wants the long tail can see it without being misled about what it is.
 */
export function assignTier(c, cfg) {
  if (c.p == null) {
    return { tier: "low", tierReason: "no significance test applies to this quantity — effect size only" };
  }
  const effect = Math.abs(c.effect ?? 0);
  const material = effect >= 0.8 || Math.abs(c.share ?? 0) >= 0.25 ||
    (c.kind === "persistence" && c.statistic >= 0.75) ||
    (c.kind === "temporal" && Math.abs(c.pctChange ?? 0) >= 0.2);

  if (c.q <= 0.001 && !c.lowPower && effect >= 1.0) {
    return { tier: "high",
      tierReason: `survives correction at q ≤ 0.001 with an effect of ${effect.toFixed(1)} SD` };
  }
  if (c.q <= 0.01 && !c.lowPower && material) {
    return { tier: "medium", tierReason: `survives correction at q ≤ 0.01 with a material effect` };
  }
  if (c.q <= cfg.fdrQ) {
    const why = c.lowPower ? "limited power" : !material ? "small effect" : "clears the standard bar";
    return { tier: "medium", tierReason: `survives correction at q ≤ ${cfg.fdrQ} — ${why}` };
  }
  return { tier: "low",
    tierReason: `does not clear multiplicity correction (q = ${c.q.toFixed(3)}) — unproven, shown for completeness` };
}

/**
 * Collapse candidates that describe the SAME cell via different tests.
 *
 * dark_store = DS-07 being an outlier, being persistently the worst, and
 * breaking from its own history are three views of one fact, not three
 * findings. Presenting them as three inflates the feed and, worse, implies
 * three independent pieces of evidence when the tests share the same data.
 * Keep the strongest, record the others as corroboration.
 */
function dedupeBySubject(list) {
  const bySubject = new Map();
  for (const c of list) {
    const key = c.kind === "cross"
      ? `${c.measure}|${c.dimA}=${c.a}|${c.dimB}=${c.b}`
      : `${c.measure}|${c.dim}=${c.value}`;
    const prev = bySubject.get(key);
    if (!prev) { bySubject.set(key, { ...c, corroboration: [] }); continue; }
    const better = (c.q ?? 1) < (prev.q ?? 1);
    if (better) {
      bySubject.set(key, { ...c, corroboration: [...prev.corroboration, prev.test] });
    } else {
      prev.corroboration.push(c.test);
    }
  }
  return Array.from(bySubject.values());
}

/* ─── DECOMPOSITION (the honest replacement for "causal") ────────────────── */

/**
 * Explain a period-over-period move by decomposing it, not by asserting cause.
 * Returns the additive contribution table plus, for averaged measures, the
 * mix-versus-rate split that catches Simpson's paradox.
 */
export function explainChange(cube, measure, dim, grain, periodTo, periodFrom) {
  const periods = allPeriods(cube, grain);
  const toIdx = periods.indexOf(periodTo);
  const from = periodFrom || (toIdx > 0 ? periods[toIdx - 1] : null);
  if (!from) return null;

  const agg = cube.meta.aggOf?.[measure] || "sum";
  const pairs = queryPeriodPair(cube, dim, measure, grain, from, periodTo);
  if (!pairs.length) return null;

  const additive = agg === "sum" ? contributionDecomposition(pairs) : null;

  let mixRate = null;
  if (agg === "avg") {
    const rawFrom = queryRaw(cube, dim, measure, grain, from);
    const rawTo = queryRaw(cube, dim, measure, grain, periodTo);
    const byKey = new Map();
    for (const r of rawFrom) byKey.set(r.key, { key: r.key, w0: r.count, r0: r.mean, w1: 0, r1: 0 });
    for (const r of rawTo) {
      const e = byKey.get(r.key) || { key: r.key, w0: 0, r0: 0, w1: 0, r1: 0 };
      e.w1 = r.count; e.r1 = r.mean;
      byKey.set(r.key, e);
    }
    mixRate = mixRateDecomposition(Array.from(byKey.values()));
  }

  return {
    measure, dim, grain, from, to: periodTo, agg,
    additive, mixRate,
    method: agg === "sum"
      ? "additive contribution — exact arithmetic attribution of the total change"
      : "mix vs rate decomposition — separates genuine rate movement from compositional shift",
    caveat: "This is a decomposition, not a causal identification. It says which cells moved, not why they moved or what would have happened otherwise.",
  };
}

/* ─── NARRATION ──────────────────────────────────────────────────────────── */

function pctStr(x) { return x == null ? "" : `${(x * 100).toFixed(x > -0.1 && x < 0.1 ? 1 : 0)}%`; }

/**
 * Build the sentence for a finding. Deterministic string assembly from the
 * numbers we computed — no model in the loop, so the sentence and the
 * statistic can never disagree.
 */
export function explain(c) {
  if (c.kind === "sibling") {
    const eff = c.effect != null ? `, ${Math.abs(c.effect).toFixed(1)} SD from its peers` : "";
    const power = c.lowPower ? ` Only ${c.members} members, so this test has limited power.` : "";
    return `${c.dim} = ${c.value} sits ${c.direction} the other ${c.members - 1} members on ${c.measure}` +
      `${eff}. Grubbs G = ${c.statistic.toFixed(2)} against a ceiling of ${c.ceiling.toFixed(2)} for n = ${c.members}.` +
      `${power} Backed by ${c.n.toLocaleString()} rows.`;
  }
  if (c.kind === "temporal") {
    const mv = c.pctChange != null ? ` It moved ${pctStr(c.pctChange)} against the prior period.` : "";
    return `${c.dim} = ${c.value} broke from its own history on ${c.measure}: ${c.val.toLocaleString(undefined, { maximumFractionDigits: 2 })} ` +
      `against a ${c.historyN}-period mean of ${c.histMean.toLocaleString(undefined, { maximumFractionDigits: 2 })}.` +
      `${mv} Studentized t = ${c.statistic.toFixed(2)}.`;
  }
  if (c.kind === "persistence") {
    const where = c.extreme === "top" ? "highest" : "lowest";
    return `${c.dim} = ${c.value} was the ${where} member on ${c.measure} in ${c.hits} of ${c.observedPeriods} periods, ` +
      `against ${c.expectedHits.toFixed(1)} expected if the ${c.members} members were interchangeable. ` +
      `Exact binomial test. A single-period comparison on ${c.members} members could never reach this confidence — ` +
      `the evidence is in the repetition, not the gap.`;
  }
  if (c.kind === "cross") {
    const pctDiff = c.restMean ? (c.val - c.restMean) / Math.abs(c.restMean) : null;
    return `${c.dimA} = ${c.a} combined with ${c.dimB} = ${c.b} averages ` +
      `${c.val.toLocaleString(undefined, { maximumFractionDigits: 2 })} on ${c.measure}, ` +
      `against ${c.restMean.toLocaleString(undefined, { maximumFractionDigits: 2 })} everywhere else` +
      `${pctDiff != null ? ` — ${pctStr(pctDiff)} ${c.direction}` : ""}. ` +
      `Welch t = ${c.statistic.toFixed(2)} on ${c.n.toLocaleString()} rows in the cell. ` +
      `This compares averages, so it is not just a reflection of how many orders land here.`;
  }
  return "";
}

/** Classify for the UI taxonomy. Cross-cells are interactions, not causes. */
export function classifyInsight(c) {
  const spatial = /(region|city|state|country|geo|location|zone|area|territory|district|market)/i;
  if (c.kind === "temporal") return "temporal";
  if (c.kind === "persistence") return c.dim && spatial.test(c.dim) ? "spatial" : "behavioral";
  if (c.kind === "cross") return "interaction";
  if (c.dim && spatial.test(c.dim)) return "spatial";
  return "behavioral";
}
