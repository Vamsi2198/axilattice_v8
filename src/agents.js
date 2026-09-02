/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — AGENTS
   ───────────────────────────────────────────────────────────────────────────
   Six deterministic agents. Every one is arithmetic over the cube; none of
   them calls a model. Each returns a card for the UI AND an `evidence` object
   that goes straight into the decision record, so what the user reads and what
   the audit trail stores are generated from the same numbers.

   Naming note. The archive document called the sixth agent "Causal" and
   described DoWhy-style inference. What is implemented here is EXPLAIN: an
   exact decomposition of a change into contributions, plus a mix-versus-rate
   split. That is genuinely useful and genuinely honest. Causal identification
   needs a design — a treatment, a control, an assumption about confounding —
   none of which a lone CSV supplies. Labelling decomposition as causal is the
   single most common way analytics tools mislead, and it is not worth the
   marketing line.
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  queryBreakdown, queryTrend, queryTotal, queryCrossBreakdown,
  allPeriods, latestPeriod, resolveGrain, findCrossCombo,
} from "./engine/query.js";
import {
  discoverInsights, explainChange, explain, classifyInsight, DISCOVERY_DEFAULTS,
} from "./engine/insights.js";
import {
  grubbsTest, robustZScores, pearson, spearman, cohenD,
  holtFit, holtForecast, backtest, formatP,
} from "./engine/stats.js";

export const AGENTS_VERSION = "agents/1.0.0";

export const AGENT_CATALOG = [
  { id: "scan",      label: "Scan",      question: "What is actually unusual here?",       method: "Full traversal, Grubbs + studentized deviation, Benjamini-Hochberg corrected" },
  { id: "deepdive",  label: "Deep dive", question: "How does one dimension break down?",    method: "Per-member Grubbs, MAD-robust z, Cohen's d" },
  { id: "drill",     label: "Drill",     question: "Where did a move come from?",           method: "Contribution decomposition, then 2-way localization" },
  { id: "correlate", label: "Correlate", question: "What moves together?",                  method: "Pearson + Spearman with p-values and Fisher-z intervals" },
  { id: "forecast",  label: "Forecast",  question: "What happens next, and can we trust it?", method: "Holt linear trend, walk-forward backtest reported as MASE" },
  { id: "explain",   label: "Explain",   question: "Is a change real or compositional?",    method: "Additive contribution + mix vs rate decomposition" },
];

/* ─── TRACE ──────────────────────────────────────────────────────────────── */

function makeTrace(onStep, { paced = true } = {}) {
  const trace = [];
  return async (phase, label, detail) => {
    trace.push({ phase, label, detail });
    if (onStep) onStep([...trace]);
    // Pacing exists so the reasoning is legible, not to fake work. Tests turn
    // it off so a full agent run costs microseconds.
    if (paced) await new Promise((r) => setTimeout(r, 380));
    return trace;
  };
}

const fmt = (v, d = 2) =>
  v == null || Number.isNaN(v) ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });

function pct(x, d = 1) { return x == null ? "—" : `${(x * 100).toFixed(d)}%`; }

/* ─── THE CONNECT FEED ───────────────────────────────────────────────────── */

/**
 * Build the ranked card feed produced the moment a dataset connects.
 *
 * This is what the Scan agent SHOULD have been doing. It was returning one
 * card holding the top three findings in a `findings` array the UI never
 * rendered — so an engine that had located 26 real, corrected findings
 * displayed exactly one card. The insights were there the whole time; the
 * display layer threw them away.
 *
 * Each finding now becomes its own card, tagged with its priority tier, so
 * the feed can be read top-down and the evidence standard travels with the
 * card rather than living in a summary paragraph.
 */
export function buildFeed(cube, options = {}) {
  const res = discoverInsights(cube, options);
  const { grain, period } = res;

  const cards = res.feed.map((f, i) => {
    const chart = chartFor(cube, f, grain, period);
    const subject = f.kind === "cross"
      ? `${f.dimA} = ${f.a} × ${f.dimB} = ${f.b}`
      : `${f.dim} = ${f.value}`;
    const dir = f.direction === "below" ? "below" : "above";
    const verb = {
      sibling: `runs ${dir} its peers on`,
      temporal: "broke from its own history on",
      persistence: f.extreme === "bottom" ? "is consistently the lowest on" : "is consistently the highest on",
      cross: `averages ${dir} the rest of the data on`,
    }[f.kind] || "is notable on";

    return {
      kind: "card",
      id: `feed-${i}-${f.kind}`,
      agent: "scan",
      fromFeed: true,
      tier: f.tier,
      tierReason: f.tierReason,
      title: `${subject} ${verb} ${f.measure}`,
      insightClass: classifyInsight(f),
      measure: f.measure,
      dimension: f.dim || f.dimA || null,
      grain, period,
      chart_type: chart.type,
      chart_data: chart.data,
      highlight: [f.value, f.a].filter(Boolean),
      kpi: f.val ?? null,
      delta: f.pctChange ?? null,
      summary: f.why,
      corroboration: f.corroboration || [],
      evidence: f,
      audit: res.audit,
    };
  });

  return { cards, audit: res.audit, tierCounts: res.tierCounts, grain, period };
}

/* ─── AGENT 1: SCAN ──────────────────────────────────────────────────────── */

export async function agentScan(cube, intent, onStep, opts = {}) {
  const step = makeTrace(onStep, opts);
  const grain = resolveGrain(cube, intent.grain);
  const period = intent.period || latestPeriod(cube, grain);

  await step("TRAVERSE", "Walk the cube",
    `Testing every measure × dimension × cross-cell at ${grain} grain, period ${period}. ` +
    `Cells below ${DISCOVERY_DEFAULTS.minCellRows} rows or ${pct(DISCOVERY_DEFAULTS.minShare, 1)} share are excluded before testing.`);

  const res = discoverInsights(cube, { grain, period, ...opts.discovery });
  const scoped = intent.measureExplicit
    ? res.insights.filter((i) => i.measure === intent.measure)
    : res.insights;

  await step("TEST", "Apply the statistical tests",
    `${res.audit.testsRun} tests run. Sibling deviation uses Grubbs (which accounts for how few members a dimension has); ` +
    `temporal deviation uses a studentized residual against each cell's own history.`);

  await step("CORRECT", "Control the false discovery rate",
    `Benjamini-Hochberg across all ${res.audit.testsRun} tests. ` +
    `${res.audit.survived} survive at q ≤ ${res.audit.fdrQ}. ` +
    `Without this correction roughly ${Math.round(res.audit.testsRun * 0.05)} cells would look significant by chance alone.`);

  const top = scoped.slice(0, 3);
  const trace = await step("REPORT", "Rank by effect size",
    top.length
      ? `Ranking survivors by effect size rather than p-value — a tiny p on a trivial effect is a large sample, not an important fact.`
      : res.audit.verdict);

  const head = top[0];
  const chart = head ? chartFor(cube, head, grain, period)
    : { type: "area", data: queryTrend(cube, cube.meta.measures[0].col, grain, 12) };

  const summary = top.length
    ? `${top.length} finding${top.length > 1 ? "s" : ""} survive correction out of ${res.audit.testsRun} tests. ` +
      top.map((t, i) => `${i + 1}) ${t.why}`).join(" ")
    : res.audit.verdict + (res.descriptive.length
        ? ` ${res.descriptive.length} descriptive pattern(s) exist but carry no significance test.`
        : "");

  return {
    kind: "card", agent: "scan", title: intent.title,
    insightClass: head ? classifyInsight(head) : "behavioral",
    measure: head?.measure || intent.measure,
    dimension: head?.dim || head?.dimA || null,
    grain, period,
    chart_type: chart.type, chart_data: chart.data,
    highlight: top.map((t) => t.value || t.a).filter(Boolean),
    kpi: head?.val ?? null,
    delta: head?.pctChange ?? null,
    findings: top, descriptive: res.descriptive.slice(0, 3),
    audit: res.audit, summary, trace,
    evidence: head || null,
  };
}

/* ─── AGENT 2: DEEP DIVE ─────────────────────────────────────────────────── */

export async function agentDeepDive(cube, intent, onStep, opts = {}) {
  const step = makeTrace(onStep, opts);
  const grain = resolveGrain(cube, intent.grain);
  const period = intent.period || latestPeriod(cube, grain);
  const measure = intent.measure;
  const dim = intent.dimension || cube.meta.dims[0]?.col;

  await step("ENUMERATE", `Open ${dim} on ${measure}`,
    `Pulling every member of ${dim} at ${grain} grain for ${period}, with the row count behind each.`);

  const rows = queryBreakdown(cube, dim, measure, grain, period);
  const supported = rows.filter((r) => r.n >= DISCOVERY_DEFAULTS.minCellRows);
  const thin = rows.length - supported.length;

  await step("QUALIFY", "Separate evidence from noise",
    `${rows.length} members. ${supported.length} clear the ${DISCOVERY_DEFAULTS.minCellRows}-row support floor` +
    `${thin ? `; ${thin} are too thin to test and are shown but not ranked.` : "."}`);

  const values = supported.map((r) => r.value);
  const g = supported.length ? grubbsTest(values) : { testable: false, reason: "no supported members" };
  const rz = values.length ? robustZScores(values) : null;

  await step("TEST", "Test the extreme member",
    g.testable
      ? `Grubbs G = ${g.G.toFixed(3)} on n = ${g.n}, ceiling ${g.ceiling.toFixed(3)}, ${formatP(g.p)}.` +
        (g.lowPower ? " Small n, so power is limited." : "")
      : `Cannot test: ${g.reason}. A z-threshold would have silently returned nothing here; this says why.`);

  const total = values.reduce((a, b) => a + b, 0);
  const members = supported.map((r, i) => {
    const others = values.filter((_, j) => j !== i);
    return {
      label: r.label, value: r.value, n: r.n,
      share: total ? r.value / total : 0,
      robustZ: rz ? rz.z[i] : null,
      effect: cohenD(r.value, others),
    };
  }).sort((a, b) => Math.abs(b.robustZ ?? 0) - Math.abs(a.robustZ ?? 0) || a.label.localeCompare(b.label));

  const trace = await step("REPORT", `Profile all ${rows.length} members`,
    rz ? `Ranked by MAD-robust z (basis: ${rz.basis}). MAD is used because one extreme member inflates the standard deviation and hides itself — the masking problem.`
       : `No supported members to rank.`);

  const head = members[0];
  const flat = members.filter((m) => Math.abs(m.robustZ ?? 0) < 2).length;

  const summary = supported.length
    ? `${supported.length} testable members of ${dim} on ${measure}. ` +
      (g.testable
        ? `The extreme member is ${supported[g.index].label} at ${fmt(supported[g.index].value)} (Grubbs ${formatP(g.p)}${g.lowPower ? ", low power" : ""}). `
        : `No significance test available — ${g.reason}. `) +
      members.slice(0, 3).map((m, i) => `${i + 1}) ${m.label} ${fmt(m.value)} (${pct(m.share, 0)} of total, ${m.n.toLocaleString()} rows, robust z ${m.robustZ?.toFixed(1) ?? "—"})`).join(" ") +
      ` ${flat} member(s) sit within 2 robust SD of the median.` +
      (thin ? ` ${thin} member(s) excluded for insufficient rows.` : "")
    : `No member of ${dim} carries enough ${measure} rows to analyse at ${period}.`;

  return {
    kind: "card", agent: "deepdive", title: intent.title,
    insightClass: classifyInsight({ kind: "sibling", dim }),
    measure, dimension: dim, grain, period,
    chart_type: rows.length <= 5 ? "pie" : "bar",
    chart_data: rows.map((r) => ({ label: r.label, value: r.value, n: r.n })),
    highlight: members.filter((m) => Math.abs(m.robustZ ?? 0) >= 2).map((m) => m.label),
    kpi: queryTotal(cube, measure, grain, period).value,
    delta: null,
    findings: members.slice(0, 5), memberCount: rows.length, excluded: thin,
    summary, trace,
    evidence: g.testable ? {
      kind: "sibling", measure, dim, value: supported[g.index].label,
      test: "grubbs-two-sided", statistic: g.G, p: g.p,
      n: supported[g.index].n, members: g.n,
      effect: head?.effect ?? null, lowPower: g.lowPower,
    } : null,
  };
}

/* ─── AGENT 3: DRILL ─────────────────────────────────────────────────────── */

export async function agentDrill(cube, intent, onStep, opts = {}) {
  const step = makeTrace(onStep, opts);
  const grain = resolveGrain(cube, intent.grain);
  const measure = intent.measure;
  const periods = allPeriods(cube, grain);

  // Find the period with the largest total move, unless the user named one.
  const trend = queryTrend(cube, measure, grain, null);
  let probe = intent.period, biggest = 0;
  if (!probe) {
    for (let i = 1; i < trend.length; i++) {
      const prev = trend[i - 1].value;
      const d = prev ? (trend[i].value - prev) / prev : 0;
      if (Math.abs(d) > Math.abs(biggest)) { biggest = d; probe = trend[i].period; }
    }
    probe = probe || latestPeriod(cube, grain);
  }
  const probeIdx = periods.indexOf(probe);
  const from = probeIdx > 0 ? periods[probeIdx - 1] : null;

  await step("LOCATE", `Find the move in ${measure}`,
    intent.period
      ? `Investigating the period you selected: ${probe}.`
      : `Largest period-over-period move is ${probe} at ${pct(biggest)}.`);

  if (!from) {
    const trace = await step("STOP", "No prior period", `${probe} is the first period — there is nothing to compare it against.`);
    return { kind: "card", agent: "drill", title: intent.title, measure, grain, period: probe,
      chart_type: "area", chart_data: trend, summary: `${probe} is the earliest period in the file, so no change can be decomposed.`,
      trace, evidence: null };
  }

  // Decompose across every dimension, keep the one that concentrates the move.
  await step("DECOMPOSE", "Attribute the change, dimension by dimension",
    `For each dimension, splitting the total change from ${from} to ${probe} into per-member contributions. ` +
    `This is exact arithmetic — the contributions sum to the total by construction.`);

  const dims = cube.meta.dims.map((d) => d.col);
  let best = null;
  for (const dim of dims) {
    const dec = explainChange(cube, measure, dim, grain, probe, from);
    if (!dec?.additive) continue;
    const k = dec.additive.cellsTo80pct;
    if (k == null) continue;
    // Concentration: fewer cells to explain 80% of the move is a tighter story.
    const concentration = 1 / k;
    if (!best || concentration > best.concentration) best = { dim, dec, concentration, k };
  }

  await step("RANK", "Pick the tightest explanation",
    best
      ? `${best.dim} concentrates the move most: ${best.k} member(s) account for 80% of it. ` +
        `Top contributor is ${best.dec.additive.rows[0].key} at ${pct(best.dec.additive.rows[0].share, 0)} of the total change.`
      : `No dimension concentrates the change — it is spread evenly, which usually means the driver is not in this file.`);

  // Second level: localize within the top contributor via a cross pair.
  let crossHit = null;
  if (best) {
    const topKey = best.dec.additive.rows[0].key;
    for (const dimB of dims) {
      if (dimB === best.dim) continue;
      if (!findCrossCombo(cube, best.dim, dimB)) continue;
      const now = queryCrossBreakdown(cube, best.dim, dimB, measure, grain, probe).filter((r) => r.a === topKey);
      const was = queryCrossBreakdown(cube, best.dim, dimB, measure, grain, from).filter((r) => r.a === topKey);
      if (now.length < 3) continue;
      const wasMap = new Map(was.map((r) => [r.b, r.value]));
      const cells = now.map((r) => ({ key: r.b, before: wasMap.get(r.b) ?? 0, after: r.value, n: r.n }));
      let totalD = 0; for (const c of cells) totalD += c.after - c.before;
      if (!totalD) continue;
      const ranked = cells.map((c) => ({ ...c, delta: c.after - c.before, share: (c.after - c.before) / totalD }))
        .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
      const lead = ranked[0];
      if (lead.n < DISCOVERY_DEFAULTS.minCellRows) continue;
      if (!crossHit || Math.abs(lead.share) > Math.abs(crossHit.lead.share)) {
        crossHit = { dimB, lead, ranked };
      }
    }
  }

  const trace = await step("LOCALIZE", "Narrow inside the top contributor",
    crossHit
      ? `Within ${best.dim} = ${best.dec.additive.rows[0].key}, the move concentrates on ${crossHit.dimB} = ${crossHit.lead.key} ` +
        `(${pct(crossHit.lead.share, 0)} of that member's change).`
      : `No 2-way cross cell narrows it further — either the pair was not materialised or the effect is spread inside the member.`);

  const focusDim = best?.dim;
  const focusVal = best?.dec.additive.rows[0].key;
  const chart_data = focusDim ? queryTrend(cube, measure, grain, 12, focusDim, focusVal) : trend;
  const totalChange = best?.dec.additive.total ?? null;

  const summary = best
    ? `${measure} moved ${fmt(totalChange)} from ${from} to ${probe}. ` +
      `${best.k} member(s) of ${best.dim} account for 80% of it; ${best.dec.additive.rows[0].key} alone is ${pct(best.dec.additive.rows[0].share, 0)}` +
      (crossHit ? `, and within that, ${crossHit.dimB} = ${crossHit.lead.key} carries ${pct(crossHit.lead.share, 0)}.` : ".") +
      ` This is a decomposition, not a cause — it says where the change sits, not why it happened.`
    : `${measure} moved from ${from} to ${probe}, but no dimension in this file concentrates the change. The driver is probably a variable you have not loaded.`;

  return {
    kind: "card", agent: "drill", title: intent.title, insightClass: "interaction",
    measure, dimension: focusDim, grain, period: probe,
    chart_type: "area", chart_data,
    highlight: focusVal ? [focusVal] : [],
    kpi: chart_data.find((t) => t.period === probe)?.value ?? null,
    delta: best ? (best.dec.additive.before ? totalChange / best.dec.additive.before : null) : null,
    decomposition: best?.dec || null, crossLocalization: crossHit,
    summary, trace,
    evidence: best ? {
      kind: "decomposition", measure, dim: best.dim, value: focusVal,
      test: "additive-contribution", statistic: best.dec.additive.rows[0].share,
      p: null, descriptiveOnly: true, n: null,
    } : null,
  };
}

/* ─── AGENT 4: CORRELATE ─────────────────────────────────────────────────── */

export async function agentCorrelate(cube, intent, onStep, opts = {}) {
  const step = makeTrace(onStep, opts);
  const grain = resolveGrain(cube, intent.grain);
  const period = intent.period || latestPeriod(cube, grain);
  const anchor = intent.measure;
  const dim = intent.dimension || cube.meta.dims[0]?.col;
  const measures = cube.meta.measures.map((m) => m.col);

  await step("PAIR", `Align measures across ${dim}`,
    `Building matched vectors for ${anchor} against every other measure, one point per member of ${dim} at ${period}.`);

  const anchorRows = queryBreakdown(cube, anchor, grain === null ? "month" : grain, period);
  const base = queryBreakdown(cube, anchor, dim, grain, period)
    .filter((r) => r.n >= DISCOVERY_DEFAULTS.minCellRows);
  const baseMap = new Map(base.map((r) => [r.label, r.value]));

  const results = [];
  for (const m of measures) {
    if (m === anchor) continue;
    const other = queryBreakdown(cube, m, dim, grain, period);
    const xs = [], ys = [];
    for (const r of other) {
      if (!baseMap.has(r.label)) continue;
      xs.push(baseMap.get(r.label));
      ys.push(r.value);
    }
    if (xs.length < 3) { results.push({ measure: m, testable: false, reason: `only ${xs.length} matched members` }); continue; }
    const p = pearson(xs, ys);
    const s = spearman(xs, ys);
    if (!p.testable) { results.push({ measure: m, testable: false, reason: p.reason }); continue; }
    results.push({
      measure: m, testable: true, n: p.n, r: p.r, p: p.p, ci: p.ci,
      rho: s.testable ? s.rho : null,
      // A near-perfect r almost always means one column is arithmetically
      // derived from the other. That is a schema fact, not a discovery.
      likelyDerived: Math.abs(p.r) >= 0.985,
      // A large gap between Pearson and Spearman means one point is driving it.
      leverageWarning: s.testable && Math.abs(p.r) - Math.abs(s.rho) > 0.25,
    });
  }
  const testable = results.filter((r) => r.testable);
  testable.sort((a, b) => Math.abs(b.r) - Math.abs(a.r) || a.measure.localeCompare(b.measure));

  await step("TEST", "Pearson with intervals, Spearman as a check",
    testable.length
      ? `${testable.length} pair(s) tested on ${base.length} matched members. Reporting the confidence interval, not just the point estimate — r = 0.8 on 5 members has an interval that includes zero.`
      : `Not enough matched members to correlate anything.`);

  const flagged = testable.filter((r) => r.leverageWarning);
  const trace = await step("QUALIFY", "Check for leverage and derivation",
    (flagged.length ? `${flagged.length} pair(s) show a large Pearson/Spearman gap — a single member is driving the linear fit. ` : "") +
    (testable.some((r) => r.likelyDerived) ? `At least one pair is near-perfect, which means arithmetic derivation rather than a relationship.` : "No derived pairs detected."));

  const top = testable.slice(0, 4);
  const summary = top.length
    ? `Correlations with ${anchor} across ${dim} (n = ${base.length} members): ` +
      top.map((c) => {
        if (c.likelyDerived) return `${c.measure} r = ${c.r.toFixed(3)} — near-perfect, so ${c.measure} is almost certainly computed from ${anchor}; not a finding`;
        const ciTxt = c.ci ? ` [${c.ci[0].toFixed(2)}, ${c.ci[1].toFixed(2)}]` : "";
        const crosses = c.ci && c.ci[0] < 0 && c.ci[1] > 0;
        return `${c.measure} r = ${c.r.toFixed(2)}${ciTxt}, ${formatP(c.p)}` +
          (crosses ? " — interval spans zero, so the direction is not established" : "") +
          (c.leverageWarning ? ` — Spearman ρ = ${c.rho.toFixed(2)}, so one member is doing the work` : "");
      }).join(". ") + "."
    : `${anchor} cannot be correlated here: ${results[0]?.reason || "no other measures"}.`;

  return {
    kind: "card", agent: "correlate", title: intent.title, insightClass: "behavioral",
    measure: anchor, dimension: dim, grain, period,
    chart_type: "bar", chart_data: base.map((r) => ({ label: r.label, value: r.value, n: r.n })),
    highlight: [], kpi: queryTotal(cube, anchor, grain, period).value, delta: null,
    correlations: top, summary, trace,
    evidence: top[0] && !top[0].likelyDerived ? {
      kind: "correlation", measure: anchor, dim,
      test: "pearson", statistic: top[0].r, p: top[0].p, n: top[0].n,
    } : null,
  };
}

/* ─── AGENT 5: FORECAST ──────────────────────────────────────────────────── */

export async function agentForecast(cube, intent, onStep, opts = {}) {
  const step = makeTrace(onStep, opts);
  const grain = resolveGrain(cube, intent.grain);
  const measure = intent.measure;
  const dim = intent.dimension || null;
  const dimValue = intent.dimensionValue || null;
  const horizon = intent.horizon || 3;

  const trend = queryTrend(cube, measure, grain, null, dim, dimValue).filter((t) => t.present);
  const series = trend.map((t) => t.value);

  await step("ASSEMBLE", `Pull the ${measure} history`,
    `${series.length} observed ${grain} periods${dim ? ` for ${dim} = ${dimValue}` : ""}.`);

  if (series.length < 8) {
    const trace = await step("STOP", "Not enough history",
      `Holt's method needs a run of periods to separate level from trend. ${series.length} is not enough to fit and still hold back folds for a backtest, so no forecast is offered.`);
    return { kind: "card", agent: "forecast", title: intent.title, measure, grain,
      chart_type: "area", chart_data: trend,
      summary: `Only ${series.length} periods of ${measure} history. A forecast fitted on this would be a line drawn through noise, so none is shown. Roughly 12 periods is the practical floor.`,
      trace, evidence: null };
  }

  await step("FIT", "Fit Holt's linear trend",
    `Grid search over smoothing parameters, minimising in-sample squared error. Deterministic — no random restarts, so this file always produces this model.`);

  const fit = holtFit(series);
  const bt = backtest(series, { minTrain: Math.max(6, Math.floor(series.length * 0.5)) });

  await step("BACKTEST", "Test it against doing nothing",
    bt
      ? `Walk-forward over ${bt.folds} folds. MASE = ${bt.mase.toFixed(3)} against the naive "assume no change" benchmark. ` +
        (bt.beatsNaive ? "The model beats naive." : "The model does NOT beat naive, and the card will say so.")
      : `Not enough folds for a walk-forward backtest, so no accuracy claim is made.`);

  const fc = holtForecast(fit, horizon, 0.80);
  const trace = await step("PROJECT", `Project ${horizon} periods`,
    `80% prediction intervals widen with horizon. The interval is the honest part of a forecast; the point estimate is the part people misuse.`);

  const chart_data = [
    ...trend.map((t) => ({ period: t.period, value: t.value })),
    ...fc.map((f) => ({ period: `+${f.step}`, value: f.value, lo: f.lo, hi: f.hi, forecast: true })),
  ];

  const first = fc[0];
  const summary =
    `Holt linear trend on ${series.length} ${grain} periods. Next period: ${fmt(first.value)} ` +
    `(80% interval ${fmt(first.lo)} to ${fmt(first.hi)}). ` +
    (bt
      ? bt.beatsNaive
        ? `Backtested over ${bt.folds} folds, MASE ${bt.mase.toFixed(2)} — it beats assuming no change, by ${pct(1 - bt.mase, 0)}.`
        : `Backtested over ${bt.folds} folds, MASE ${bt.mase.toFixed(2)}. It does not beat assuming no change. Use the last actual value instead of this forecast.`
      : `No backtest was possible, so treat the point estimate as an extrapolation with no measured accuracy.`) +
    ` The interval width is ${pct((first.hi - first.lo) / Math.abs(first.value || 1), 0)} of the point estimate.`;

  return {
    kind: "card", agent: "forecast", title: intent.title, insightClass: "temporal",
    measure, dimension: dim, grain, period: latestPeriod(cube, grain),
    chart_type: "area", chart_data, highlight: [],
    kpi: first.value, delta: series.length ? (first.value - series[series.length - 1]) / (series[series.length - 1] || 1) : null,
    forecast: fc, fitParams: { alpha: fit.alpha, beta: fit.beta, residualSd: fit.residualSd },
    backtest: bt, summary, trace,
    evidence: {
      kind: "forecast", measure, test: "holt-linear-backtested",
      statistic: bt ? bt.mase : null, p: null, n: series.length,
      descriptiveOnly: true,
    },
  };
}

/* ─── AGENT 6: EXPLAIN ───────────────────────────────────────────────────── */

export async function agentExplain(cube, intent, onStep, opts = {}) {
  const step = makeTrace(onStep, opts);
  const grain = resolveGrain(cube, intent.grain);
  const periods = allPeriods(cube, grain);
  const to = intent.period || latestPeriod(cube, grain);
  const toIdx = periods.indexOf(to);
  const from = toIdx > 0 ? periods[toIdx - 1] : null;
  const measure = intent.measure;
  const dim = intent.dimension || cube.meta.dims[0]?.col;
  const agg = cube.meta.aggOf?.[measure] || "sum";

  await step("FRAME", `Compare ${from || "?"} to ${to}`,
    `${measure} aggregates by ${agg.toUpperCase()}, which decides the decomposition: sums split additively, averages split into mix and rate.`);

  if (!from) {
    const trace = await step("STOP", "Nothing to compare", `${to} is the first period in the file.`);
    return { kind: "card", agent: "explain", title: intent.title, measure, dimension: dim, grain, period: to,
      chart_type: "bar", chart_data: queryBreakdown(cube, dim, measure, grain, to),
      summary: `${to} is the earliest period, so there is no prior period to decompose against.`, trace, evidence: null };
  }

  const dec = explainChange(cube, measure, dim, grain, to, from);

  if (agg === "avg" && dec?.mixRate) {
    const mr = dec.mixRate;
    await step("SPLIT", "Separate rate movement from mix shift",
      `A blended average can fall while every segment rises, purely because volume moved toward low-rate segments. ` +
      `Splitting the ${fmt(mr.change, 4)} change into rate effect, mix effect and the cross term.`);
    const trace = await step("REPORT", "Report which dominates",
      `Rate effect ${fmt(mr.rateEffect, 4)}, mix effect ${fmt(mr.mixEffect, 4)}, interaction ${fmt(mr.interaction, 4)}. ${mr.dominant.toUpperCase()} dominates.`);

    const simpson = Math.sign(mr.change) !== Math.sign(mr.rateEffect) && Math.abs(mr.rateEffect) > 1e-12;
    const summary =
      `${measure} moved from ${fmt(mr.blended0, 4)} to ${fmt(mr.blended1, 4)} between ${from} and ${to}. ` +
      `Of that ${fmt(mr.change, 4)} change, ${fmt(mr.rateEffect, 4)} is real rate movement inside ${dim} members and ` +
      `${fmt(mr.mixEffect, 4)} is pure mix shift — the same members, weighted differently. ` +
      (simpson
        ? `These point in opposite directions. The blended number moved ${mr.change > 0 ? "up" : "down"} while the underlying rates moved ${mr.rateEffect > 0 ? "up" : "down"}. That is Simpson's paradox, and reporting only the headline here would be actively misleading.`
        : `${mr.dominant === "mix" ? "Mix dominates, so the headline overstates what actually changed inside the segments." : "Rate dominates, so the headline reflects genuine movement."}`);

    return {
      kind: "card", agent: "explain", title: intent.title, insightClass: "interaction",
      measure, dimension: dim, grain, period: to,
      chart_type: "bar",
      chart_data: mr.rows.slice(0, 10).map((r) => ({ label: r.key, value: r.total })),
      highlight: mr.rows.slice(0, 2).map((r) => r.key),
      kpi: mr.blended1, delta: mr.blended0 ? mr.change / mr.blended0 : null,
      decomposition: dec, simpson, summary, trace,
      evidence: { kind: "decomposition", measure, dim, test: "mix-rate-decomposition",
        statistic: mr.rateEffect, p: null, descriptiveOnly: true },
    };
  }

  const add = dec?.additive;
  await step("ATTRIBUTE", "Split the change across members",
    add ? `${add.rows.length} members. Contributions sum to ${fmt(add.total)} by construction — this is arithmetic, so it cannot be wrong, only uninformative.`
        : `No members to attribute.`);
  const trace = await step("REPORT", "Measure concentration",
    add ? `${add.cellsTo80pct} member(s) account for 80% of the move.` : "—");

  const summary = add
    ? `${measure} changed by ${fmt(add.total)} from ${from} to ${to} (${fmt(add.before)} → ${fmt(add.after)}). ` +
      `${add.cellsTo80pct} of ${add.rows.length} ${dim} member(s) account for 80% of it. ` +
      add.rows.slice(0, 3).map((r) => `${r.key} ${r.delta >= 0 ? "+" : ""}${fmt(r.delta)} (${pct(r.share, 0)} of the move)`).join(", ") + ". " +
      `Decomposition only — it locates the change, it does not establish a cause.`
    : `No decomposition available for ${measure} across ${dim}.`;

  return {
    kind: "card", agent: "explain", title: intent.title, insightClass: "interaction",
    measure, dimension: dim, grain, period: to,
    chart_type: "bar",
    chart_data: (add?.rows || []).slice(0, 10).map((r) => ({ label: r.key, value: r.delta })),
    highlight: (add?.rows || []).slice(0, 2).map((r) => r.key),
    kpi: add?.after ?? null, delta: add?.before ? add.total / add.before : null,
    decomposition: dec, summary, trace,
    evidence: add ? { kind: "decomposition", measure, dim, value: add.rows[0]?.key,
      test: "additive-contribution", statistic: add.rows[0]?.share, p: null, descriptiveOnly: true } : null,
  };
}

/* ─── SHARED ─────────────────────────────────────────────────────────────── */

function chartFor(cube, ins, grain, period) {
  if (ins.kind === "cross") {
    return { type: "bar", data: queryBreakdown(cube, ins.dimA, ins.measure, grain, period) };
  }
  const bd = queryBreakdown(cube, ins.dim, ins.measure, grain, period);
  return { type: bd.length <= 5 ? "pie" : "bar", data: bd };
}

export async function runAgent(cube, intent, onStep, opts = {}) {
  switch (intent.agent) {
    case "scan": return agentScan(cube, intent, onStep, opts);
    case "deepdive": return agentDeepDive(cube, intent, onStep, opts);
    case "correlate": return agentCorrelate(cube, intent, onStep, opts);
    case "forecast": return agentForecast(cube, intent, onStep, opts);
    case "explain": return agentExplain(cube, intent, onStep, opts);
    case "drill":
    default: return agentDrill(cube, intent, onStep, opts);
  }
}
