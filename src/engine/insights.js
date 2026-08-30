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
  persistenceTest,
} from "./stats.js";
import {
  queryBreakdown, queryTrend, queryCrossBreakdown, allPeriods,
  latestPeriod, resolveGrain, queryPeriodPair, queryRaw, findCrossCombo,
} from "./query.js";

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
  for (const [label, hits] of Array.from(bottomHits.entries()).sort()) emit(label, hits, "bottom");
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
  if (!findCrossCombo(cube, dimA, dimB)) return [];
  const rows = queryCrossBreakdown(cube, dimA, dimB, measure, grain, period);
  if (rows.length < 4) return [];
  if (cube.meta.aggOf?.[measure] === "avg") return []; // independence model is additive-only

  // Dispersion index from the profiler; null when the measure can go negative,
  // in which case no independence model applies and we stay descriptive.
  const phi = meta?.dispersionIndex != null && meta.dispersionIndex > 0
    ? Math.max(1, meta.dispersionIndex) : null;

  const marginA = new Map(), marginB = new Map();
  let grand = 0;
  for (const r of rows) {
    marginA.set(r.a, (marginA.get(r.a) || 0) + r.value);
    marginB.set(r.b, (marginB.get(r.b) || 0) + r.value);
    grand += r.value;
  }
  if (!(grand > 0)) return [];

  const out = [];
  for (const r of rows) {
    if (r.n < cfg.minCellRows) continue;
    if (r.value / grand < cfg.minShare) continue;
    const expected = (marginA.get(r.a) * marginB.get(r.b)) / grand;
    if (!(expected > 0)) continue;
    const lift = r.value / expected;
    const base = {
      kind: "cross", measure, dimA, dimB, a: r.a, b: r.b, grain, period,
      val: r.value, n: r.n, expected, lift, log2Lift: Math.log2(lift),
      share: r.value / grand,
    };
    if (phi != null) {
      // QUASI-POISSON RESIDUAL.
      //
      // The plain Pearson residual (O - E)/sqrt(E) assumes Var(O) = E, which
      // is only true for a Poisson count. Applied to revenue it inflated the
      // statistic by a factor of five and fired on 23 cells of a dataset with
      // no planted effect at all. That is the same class of error this engine
      // exists to catch, committed by the engine itself.
      //
      // The fix is exact rather than a fudge. For a measure that is a sum of
      // iid draws, Var(sum) = n*sigma^2 and E[sum] = n*mu, so
      // Var(O) = (sigma^2/mu) * E = phi * E, where phi is the dispersion
      // index computed once in the profiler. Dividing by sqrt(phi*E) makes the
      // residual correctly scaled for ANY non-negative additive measure, and
      // collapses to the classic Pearson residual when phi = 1.
      const resid = (r.value - expected) / Math.sqrt(phi * expected);
      out.push({ ...base, test: "quasi-poisson-residual", statistic: resid, dispersion: phi,
        p: Math.min(1, 2 * (1 - normalCdfLocal(Math.abs(resid)))) });
    } else {
      out.push({ ...base, test: "descriptive-lift", statistic: Math.log2(lift),
        p: null, descriptiveOnly: true,
        note: `${measure} takes negative values, so the independence model does not apply. This is an effect size, not evidence.` });
    }
  }
  out.sort((x, y) => Math.abs(y.log2Lift) - Math.abs(x.log2Lift));
  return out.slice(0, 6);
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
  // Rank surviving findings by effect size, not by p-value. A tiny p on a
  // trivial effect is a large sample, not an important fact.
  survivors.sort((a, b) => {
    const ea = Math.abs(a.effect ?? a.statistic ?? 0);
    const eb = Math.abs(b.effect ?? b.statistic ?? 0);
    return eb - ea || (a.q - b.q) || String(a.value ?? a.a).localeCompare(String(b.value ?? b.a));
  });

  for (const c of survivors) c.why = explain(c);
  for (const c of descriptive) c.why = explain(c);

  return {
    version: INSIGHTS_VERSION,
    grain, period,
    insights: survivors,
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
      verdict: survivors.length
        ? `${survivors.length} of ${tested.length} tested cells survive correction at q <= ${cfg.fdrQ}.`
        : `${tested.length} cells tested, none survive multiplicity correction at q <= ${cfg.fdrQ}. This data looks flat.`,
    },
  };
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
    const dir = c.lift > 1 ? "over" : "under";
    const tail = c.descriptiveOnly
      ? ` No significance test applies — ${c.measure} is not a count, so this is an effect size only.`
      : ` Pearson residual ${c.statistic.toFixed(2)}.`;
    return `${c.dimA} = ${c.a} combined with ${c.dimB} = ${c.b} is ${dir}-represented on ${c.measure} ` +
      `at ${c.lift.toFixed(2)}x the level independence predicts.${tail}`;
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
