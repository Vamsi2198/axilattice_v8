/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — STATISTICS CORE
   ───────────────────────────────────────────────────────────────────────────
   Dependency-free, deterministic, allocation-conscious statistics.

   Design rules enforced here:
     1. NO spread operators over data arrays. Math.min(...xs) throws
        RangeError above ~125k elements. Every reduction is a loop.
     2. Every "this is surprising" claim carries a test, a statistic, a
        p-value and a sample size. Anything we cannot test, we label
        DESCRIPTIVE and refuse to attach a p-value to.
     3. Small-n behaviour is explicit. A z-score threshold silently cannot
        fire below a certain cardinality (max |z| with sample sd is
        (n-1)/sqrt(n) — 1.155 at n=3). Grubbs' test knows that ceiling and
        prices it into the p-value instead of hiding it.
     4. Determinism: no Math.random, no Date.now, no floating-point
        accumulation order that depends on object iteration of non-stable keys.
   ═══════════════════════════════════════════════════════════════════════════ */

export const STATS_VERSION = "stats/1.0.0";

/* ─── REDUCTIONS (loop-based; safe at any array length) ──────────────────── */

export function sum(xs) {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s;
}

export function mean(xs) {
  if (!xs.length) return NaN;
  return sum(xs) / xs.length;
}

/** Min and max in one pass. Never spreads. */
export function extent(xs) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const v = xs[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (mn === Infinity) return { min: NaN, max: NaN };
  return { min: mn, max: mx };
}

/** Welford — numerically stable variance. ddof=1 for sample, 0 for population. */
export function moments(xs, ddof = 1) {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: NaN, variance: NaN, sd: NaN };
  let m = 0, m2 = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    m += d / (i + 1);
    m2 += d * (xs[i] - m);
  }
  const denom = n - ddof;
  const variance = denom > 0 ? m2 / denom : 0;
  return { n, mean: m, variance, sd: Math.sqrt(variance) };
}

export function stdev(xs, ddof = 1) { return moments(xs, ddof).sd; }

/** Sorted copy — used by every order statistic. Numeric ascending. */
function sortedCopy(xs) {
  const a = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) a[i] = xs[i];
  a.sort((p, q) => p - q);
  return a;
}

/** Type-7 quantile (matches numpy/R default). p in [0,1]. */
export function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (!n) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h), hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function quantile(xs, p) { return quantileSorted(sortedCopy(xs), p); }
export function median(xs) { return quantile(xs, 0.5); }

/**
 * Median Absolute Deviation, scaled to be a consistent estimator of sigma
 * for normal data (x1.4826).
 *
 * Why this exists: a single large outlier inflates the sample sd, which
 * shrinks its own z-score. That is the classic masking problem — the thing
 * you are hunting for hides itself. MAD does not move when one point moves.
 */
export function mad(xs) {
  const s = sortedCopy(xs);
  const med = quantileSorted(s, 0.5);
  const dev = new Array(s.length);
  for (let i = 0; i < s.length; i++) dev[i] = Math.abs(s[i] - med);
  dev.sort((p, q) => p - q);
  return { median: med, mad: quantileSorted(dev, 0.5) * 1.4826 };
}

/** Robust z-scores via MAD. Falls back to sd when MAD is degenerate (ties). */
export function robustZScores(xs) {
  const { median: med, mad: scale } = mad(xs);
  let s = scale;
  let basis = "mad";
  if (!(s > 0)) {
    s = moments(xs, 1).sd;
    basis = "sd";
  }
  const out = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) out[i] = s > 0 ? (xs[i] - med) / s : 0;
  return { z: out, center: med, scale: s, basis };
}

/* ─── SPECIAL FUNCTIONS ──────────────────────────────────────────────────── */

/** Lanczos log-gamma. Accurate to ~15 significant digits for x > 0. */
export function logGamma(x) {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // reflection
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued-fraction expansion for the incomplete beta (Lentz's method). */
function betaContinuedFraction(a, b, x) {
  const FPMIN = 1e-300, EPS = 3e-16, MAXIT = 300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b). */
export function incompleteBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b) +
                a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(lbeta);
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) +
    b * Math.log(1 - x) + a * Math.log(x)) * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Student-t CDF, P(T <= t) with df degrees of freedom. */
export function studentTCdf(t, df) {
  if (!(df > 0)) return NaN;
  if (!isFinite(t)) return t > 0 ? 1 : 0;
  const x = df / (df + t * t);
  const p = 0.5 * incompleteBeta(df / 2, 0.5, x);
  return t > 0 ? 1 - p : p;
}

/** Two-sided Student-t p-value. */
export function studentTP(t, df) {
  if (!isFinite(t)) return 0;
  return Math.min(1, 2 * (1 - studentTCdf(Math.abs(t), df)));
}

/** Student-t quantile by bisection on the CDF. Deterministic, ~60 iterations. */
export function studentTQuantile(p, df) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -1e3, hi = 1e3;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Abramowitz-Stegun 7.1.26 error function; |eps| < 1.5e-7. */
export function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

export function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
export function normalP(z) { return Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))); }

/* ─── OUTLIER TESTING ────────────────────────────────────────────────────── */

/**
 * Grubbs' test for a single outlier (two-sided).
 *
 * This replaces the fixed z-threshold that could never fire on small
 * dimensions. With sample sd the maximum attainable |z| is (n-1)/sqrt(n):
 *
 *     n = 3  ->  1.155      n = 6  ->  2.041
 *     n = 4  ->  1.500      n = 8  ->  2.475
 *     n = 5  ->  1.789      n = 12 ->  3.175
 *
 * A hard cutoff at z >= 1.5 is therefore unreachable at n = 3 and only
 * reachable in the fully degenerate case at n = 4. Segment, channel, tier
 * and every boolean dimension were structurally invisible. Grubbs converts
 * the same G statistic into a p-value that accounts for n, so a lopsided
 * three-member split is judged on its own scale.
 *
 * Returns null when n < minN — we say "not enough siblings to test", we do
 * not silently return "nothing found".
 */
export function grubbsTest(values, { minN = 4 } = {}) {
  const n = values.length;
  if (n < minN) {
    return { testable: false, reason: `needs >= ${minN} members, got ${n}`, n };
  }
  const { mean: m, sd } = moments(values, 1);
  if (!(sd > 0)) {
    return { testable: false, reason: "zero variance among members", n };
  }
  let idx = 0, best = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(values[i] - m);
    if (d > best) { best = d; idx = i; }
  }
  const G = best / sd;
  const ceiling = (n - 1) / Math.sqrt(n);

  // Invert the Grubbs critical-value formula to recover the t statistic:
  //   G = ((n-1)/sqrt(n)) * sqrt(t^2 / (n - 2 + t^2))
  //   => t^2 = G^2 (n-2) / ((n-1)^2/n - G^2)
  const df = n - 2;
  const lim = ((n - 1) * (n - 1)) / n;
  const denom = lim - G * G;
  let p;
  if (denom <= 0) {
    // G sits at the arithmetic ceiling. This happens when every non-outlier
    // member is identical, which is a degenerate configuration rather than
    // overwhelming evidence. Report the floor, flag the degeneracy.
    p = n >= 6 ? 1e-6 : 0.05;
  } else {
    const t = Math.sqrt((G * G * df) / denom);
    p = Math.min(1, n * studentTP(t, df));
  }
  return {
    testable: true, test: "grubbs-two-sided",
    n, G, ceiling, index: idx, value: values[idx],
    mean: m, sd, p,
    degenerate: denom <= 0,
    lowPower: n < 6,
  };
}

/**
 * Studentized deviation of the LAST point against its own prior window.
 * Used for temporal surprise: is this period unusual for this cell's history?
 * Same machinery as Grubbs but with a known target index, so no n-fold
 * Bonferroni inflation — we did not go looking for the maximum.
 */
export function lastPointTest(series, { minHistory = 5 } = {}) {
  const n = series.length;
  if (n < minHistory + 1) {
    return { testable: false, reason: `needs >= ${minHistory + 1} periods, got ${n}`, n };
  }
  const hist = series.slice(0, n - 1);
  const { mean: m, sd } = moments(hist, 1);
  const latest = series[n - 1];
  if (!(sd > 0)) return { testable: false, reason: "flat history", n };
  const df = hist.length - 1;
  // Prediction-interval studentization: the new point was not in the fit.
  const se = sd * Math.sqrt(1 + 1 / hist.length);
  const t = (latest - m) / se;
  return {
    testable: true, test: "studentized-deviation",
    n: hist.length, latest, histMean: m, histSd: sd,
    t, p: studentTP(t, df),
  };
}

/**
 * Exact binomial tail test.
 *
 * This is what rescues small dimensions, and it is more important than the
 * Grubbs fix. Grubbs on a 3-member dimension has a hard ceiling: the largest
 * attainable G is 1.155, so even a 3x effect can only reach p ~ 0.07. Three
 * points are three points.
 *
 * But a 3-member dimension observed over 18 periods is not three points. If
 * one member is the largest in every single period, then under the null that
 * members are exchangeable, the chance of that is (1/3)^18. The panel carries
 * the evidence the cross-section cannot.
 *
 * So: rank persistence, tested exactly. High power exactly where the
 * parametric test is weakest.
 */
export function binomialTailP(k, n, p0) {
  if (n <= 0 || k < 0 || k > n) return 1;
  // Sum P(X >= k) using log-space terms to stay stable at large n.
  const logChoose = (a, b) => logGamma(a + 1) - logGamma(b + 1) - logGamma(a - b + 1);
  let p = 0;
  for (let i = k; i <= n; i++) {
    p += Math.exp(logChoose(n, i) + i * Math.log(p0) + (n - i) * Math.log(1 - p0));
  }
  return Math.min(1, p);
}

/**
 * Rank-persistence test. `hits` is how often a member held the extreme rank
 * across `periods` observations, out of `members` exchangeable candidates.
 */
export function persistenceTest(hits, periods, members) {
  if (periods < 4 || members < 2) {
    return { testable: false, reason: `needs >= 4 periods and >= 2 members, got ${periods}/${members}` };
  }
  const p0 = 1 / members;
  const expected = periods * p0;
  if (hits <= expected) return { testable: true, test: "binomial-persistence", hits, periods, members, expected, p: 1 };
  return {
    testable: true, test: "binomial-persistence",
    hits, periods, members, expected,
    p: binomialTailP(hits, periods, p0),
    rate: hits / periods,
  };
}

/* ─── MULTIPLE COMPARISONS ───────────────────────────────────────────────── */

/**
 * Benjamini-Hochberg false discovery rate.
 *
 * This is the piece that makes the discovery feed honest. A full cube
 * traversal runs thousands of tests. At alpha = 0.05, thousands of tests
 * produce dozens of "findings" from pure noise. Reporting the top 6 by raw
 * score is how every BI tool manufactures insight out of randomness.
 *
 * BH gives each finding a q-value: the expected share of false positives
 * among everything reported at that threshold. "6 findings survive at
 * q < 0.10 out of 4,312 tested" is a claim you can defend in a review.
 *
 * Input: array of p-values. Output: array of q-values in the same order.
 */
export function benjaminiHochberg(pvalues) {
  const n = pvalues.length;
  if (!n) return [];
  const order = new Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // Stable sort by p ascending, index ascending — determinism matters.
  order.sort((a, b) => (pvalues[a] - pvalues[b]) || (a - b));
  const q = new Array(n);
  let prev = 1;
  for (let k = n - 1; k >= 0; k--) {
    const i = order[k];
    const val = Math.min(prev, (pvalues[i] * n) / (k + 1));
    q[i] = Math.min(1, val);
    prev = q[i];
  }
  return q;
}

/* ─── ASSOCIATION ────────────────────────────────────────────────────────── */

/** Pearson r with a t-based p-value and a Fisher-z confidence interval. */
export function pearson(xs, ys, { conf = 0.95 } = {}) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { testable: false, reason: `needs >= 3 pairs, got ${n}`, n };
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (!(dx > 0) || !(dy > 0)) return { testable: false, reason: "zero variance", n };
  const r = num / Math.sqrt(dx * dy);
  const df = n - 2;
  const rc = Math.min(0.999999999, Math.max(-0.999999999, r));
  const t = rc * Math.sqrt(df / (1 - rc * rc));
  const p = studentTP(t, df);
  // Fisher z interval
  let ci = null;
  if (n > 3) {
    const z = 0.5 * Math.log((1 + rc) / (1 - rc));
    const se = 1 / Math.sqrt(n - 3);
    const crit = studentTQuantile(1 - (1 - conf) / 2, 1e6); // ~normal
    const lo = Math.tanh(z - crit * se), hi = Math.tanh(z + crit * se);
    ci = [lo, hi];
  }
  return { testable: true, test: "pearson", n, r, t, p, ci, conf };
}

/** Spearman rank correlation — resistant to a single dominant point. */
export function spearman(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return { testable: false, reason: `needs >= 3 pairs, got ${n}`, n };
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const r = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const out = pearson(rank(xs), rank(ys));
  return { ...out, test: "spearman", rho: out.r };
}

/* ─── INTERVALS AND EFFECT SIZES ─────────────────────────────────────────── */

/** Confidence interval for a mean. */
export function meanCI(xs, conf = 0.95) {
  const { n, mean: m, sd } = moments(xs, 1);
  if (n < 2) return null;
  const crit = studentTQuantile(1 - (1 - conf) / 2, n - 1);
  const half = crit * (sd / Math.sqrt(n));
  return { mean: m, lo: m - half, hi: m + half, conf, n };
}

/**
 * Cohen's d for one member against its siblings — how far out is it, in
 * units of the spread of everything else. Effect size answers "does this
 * matter", which is a different question from "is this real".
 */
export function cohenD(value, others) {
  const { mean: m, sd } = moments(others, 1);
  if (!(sd > 0)) return null;
  return (value - m) / sd;
}

/* ─── FORECASTING ────────────────────────────────────────────────────────── */

/**
 * Holt's linear trend method (double exponential smoothing).
 * Parameters fit by deterministic grid search on in-sample SSE — no random
 * restarts, so the same series always produces the same model.
 */
export function holtFit(series, { grid = 21 } = {}) {
  const n = series.length;
  if (n < 4) return null;
  let best = null;
  for (let i = 0; i < grid; i++) {
    const alpha = 0.02 + (0.96 * i) / (grid - 1);
    for (let j = 0; j < grid; j++) {
      const beta = 0.02 + (0.96 * j) / (grid - 1);
      let level = series[0];
      let trend = series[1] - series[0];
      let sse = 0;
      const resid = new Array(n - 1);
      for (let t = 1; t < n; t++) {
        const f = level + trend;
        const e = series[t] - f;
        resid[t - 1] = e;
        sse += e * e;
        const newLevel = alpha * series[t] + (1 - alpha) * (level + trend);
        trend = beta * (newLevel - level) + (1 - beta) * trend;
        level = newLevel;
      }
      if (!best || sse < best.sse - 1e-12) {
        best = { alpha, beta, level, trend, sse, resid };
      }
    }
  }
  const { sd } = moments(best.resid, 1);
  return { ...best, residualSd: sd, n };
}

/** Forecast h steps with widening prediction intervals. */
export function holtForecast(fit, h, conf = 0.80) {
  if (!fit) return [];
  const crit = studentTQuantile(1 - (1 - conf) / 2, Math.max(2, fit.n - 2));
  const out = [];
  for (let k = 1; k <= h; k++) {
    const point = fit.level + k * fit.trend;
    // Variance of an h-step Holt forecast grows roughly with the sum of
    // squared cumulative smoothing weights. This is the standard
    // approximation, not an exact ARIMA-equivalent interval.
    let varMult = 0;
    for (let j = 0; j < k; j++) varMult += Math.pow(1 + j * fit.alpha * fit.beta, 2);
    const se = fit.residualSd * Math.sqrt(varMult);
    out.push({ step: k, value: point, lo: point - crit * se, hi: point + crit * se, se });
  }
  return out;
}

/**
 * Walk-forward backtest. Reports MASE against a naive (last value) benchmark.
 * MASE < 1 means the model beats naive; MASE >= 1 means it does not, and we
 * say so on the card rather than presenting a forecast that is worse than
 * "assume no change".
 */
export function backtest(series, { minTrain = 6, horizon = 1 } = {}) {
  const n = series.length;
  if (n < minTrain + 2) return null;
  let absErr = 0, absNaive = 0, count = 0;
  for (let cut = minTrain; cut < n - horizon + 1; cut++) {
    const train = series.slice(0, cut);
    const fit = holtFit(train);
    if (!fit) continue;
    const fc = holtForecast(fit, horizon);
    const actual = series[cut + horizon - 1];
    absErr += Math.abs(actual - fc[horizon - 1].value);
    absNaive += Math.abs(actual - train[train.length - 1]);
    count++;
  }
  if (!count || !(absNaive > 0)) return null;
  return { mase: absErr / absNaive, folds: count, beatsNaive: absErr < absNaive };
}

/* ─── CONTRIBUTION DECOMPOSITION ─────────────────────────────────────────── */

/**
 * Additive contribution: exact arithmetic attribution of a total change.
 *
 * Deliberately NOT called "causal". This decomposes a delta into which cells
 * moved; it identifies no counterfactual and controls for no confounder.
 * Calling arithmetic "causal inference" is the single most common way
 * analytics tools mislead people, and we are not doing it.
 *
 * cells: [{ key, before, after }]
 */
export function contributionDecomposition(cells) {
  let before = 0, after = 0;
  for (const c of cells) { before += c.before; after += c.after; }
  const total = after - before;
  const rows = cells.map((c) => {
    const delta = c.after - c.before;
    return {
      key: c.key, before: c.before, after: c.after, delta,
      share: total !== 0 ? delta / total : 0,
      pctChange: c.before !== 0 ? delta / c.before : null,
    };
  });
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || String(a.key).localeCompare(String(b.key)));
  // How many cells to reach 80% of the move — a concentration measure.
  let cum = 0, k = 0;
  if (total !== 0) {
    for (const r of rows) {
      cum += r.delta / total;
      k++;
      if (cum >= 0.8) break;
    }
  }
  return { total, before, after, rows, cellsTo80pct: total !== 0 ? k : null };
}

/**
 * Mix vs rate decomposition for weighted averages (margin %, avg order value).
 *
 * A blended rate can fall while every single segment's rate rises, purely
 * because volume shifted toward low-rate segments. Simpson's paradox in
 * production. This splits the move into:
 *   rate effect  — segments genuinely changed
 *   mix effect   — the weights moved
 *   interaction  — the cross term
 *
 * cells: [{ key, w0, r0, w1, r1 }]  (weights need not be normalised)
 */
export function mixRateDecomposition(cells) {
  let W0 = 0, W1 = 0;
  for (const c of cells) { W0 += c.w0; W1 += c.w1; }
  if (!(W0 > 0) || !(W1 > 0)) return null;
  let blended0 = 0, blended1 = 0;
  let rateEffect = 0, mixEffect = 0, interaction = 0;
  const rows = [];
  for (const c of cells) {
    const s0 = c.w0 / W0, s1 = c.w1 / W1;
    blended0 += s0 * c.r0;
    blended1 += s1 * c.r1;
    const dr = c.r1 - c.r0, ds = s1 - s0;
    const re = s0 * dr, me = ds * c.r0, ix = ds * dr;
    rateEffect += re; mixEffect += me; interaction += ix;
    rows.push({ key: c.key, share0: s0, share1: s1, rate0: c.r0, rate1: c.r1,
      rateEffect: re, mixEffect: me, interaction: ix, total: re + me + ix });
  }
  rows.sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || String(a.key).localeCompare(String(b.key)));
  return {
    blended0, blended1, change: blended1 - blended0,
    rateEffect, mixEffect, interaction, rows,
    // The headline: did the blend move for real reasons or compositional ones?
    dominant: Math.abs(rateEffect) >= Math.abs(mixEffect) ? "rate" : "mix",
  };
}

/* ─── FORMATTING HELPERS FOR HONEST REPORTING ────────────────────────────── */

export function formatP(p) {
  if (p == null || Number.isNaN(p)) return "n/a";
  if (p < 1e-4) return "p < 0.0001";
  if (p < 0.01) return `p = ${p.toFixed(4)}`;
  return `p = ${p.toFixed(3)}`;
}

export function formatQ(q) {
  if (q == null || Number.isNaN(q)) return "n/a";
  if (q < 1e-4) return "q < 0.0001";
  return `q = ${q.toFixed(q < 0.01 ? 4 : 3)}`;
}
