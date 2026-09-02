/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — AUTO-GENERATED DATASET SKILL
   ───────────────────────────────────────────────────────────────────────────
   A hand-curated semantic layer is the thing every BI vendor promises and
   almost no customer finishes. It rots the moment a column is renamed, and the
   person who knew what `margin_pct` actually meant left two quarters ago.

   So this is generated, not curated. Every line comes from something the
   profiler already measured, which means it cannot drift from the data: it is
   regenerated on load and again on any schema override.

   The valuable part is not the column list — anyone can print a schema. It is
   the GOTCHAS section, which states the things this engine knows and a reader
   cannot see: which dimensions are too small for a parametric test, which
   measures must never be summed, which cells are too thin to carry a claim,
   which date column was rejected and why, which cross-pairs were skipped for
   budget. Those are the facts that make an analysis wrong quietly.

   A curated skill tells you what someone meant. A generated skill tells you
   what the data will actually do to you.
   ═══════════════════════════════════════════════════════════════════════════ */

import { allPeriods, latestPeriod, queryBreakdown, resolveGrain } from "./engine/query.js";
import { DISCOVERY_DEFAULTS } from "./engine/insights.js";
import { hash, canonical, ENGINE_STAMP } from "./provenance.js";

export const SKILL_VERSION = "skill/1.0.0";

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const num = (v, d = 2) =>
  v == null || Number.isNaN(v) ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });

/* ─── COLUMN DESCRIPTIONS ────────────────────────────────────────────────── */

function describeMeasure(m, cube) {
  const bits = [];
  bits.push(`aggregates by **${m.agg.toUpperCase()}** (${m.aggReason})`);
  bits.push(`range ${num(m.min)} to ${num(m.max)}, median ${num(m.p50)}`);
  bits.push(`${m.nonNull.toLocaleString()} non-null values`);
  if (m.dispersionIndex != null) {
    // Dispersion is the single most useful number about a measure that nobody
    // ever prints. It decides which tests are even applicable.
    const phi = m.dispersionIndex;
    bits.push(
      phi < 3
        ? `dispersion index ${num(phi)} — behaves like a count, independence tests apply cleanly`
        : `dispersion index ${num(phi, 0)} — far from Poisson, so independence residuals are scaled by it`
    );
  }
  return bits;
}

function describeDimension(d, cube, measure, grain, period) {
  const bits = [`${d.cardinality} distinct value(s)`];
  if (d.values?.length) {
    bits.push(`values: ${d.values.slice(0, 8).join(", ")}${d.values.length > 8 ? ", …" : ""}`);
  }
  if (measure && period) {
    const rows = queryBreakdown(cube, d.col, measure, grain, period);
    const thin = rows.filter((r) => r.n < DISCOVERY_DEFAULTS.minCellRows);
    if (thin.length) {
      bits.push(
        `${thin.length} of ${rows.length} member(s) fall below the ${DISCOVERY_DEFAULTS.minCellRows}-row support floor in the latest period ` +
        `(${thin.slice(0, 4).map((t) => `${t.label}: ${t.n}`).join(", ")}${thin.length > 4 ? ", …" : ""})`
      );
    }
  }
  return bits;
}

/* ─── GOTCHAS ────────────────────────────────────────────────────────────── */

/**
 * Every entry here is a condition actually detected in this file, with the
 * consequence spelled out. Nothing is generic advice.
 */
function collectGotchas(prof, cube, grain, period) {
  const g = [];

  // Time axis
  if (prof.timeAlternatives.length) {
    for (const alt of prof.timeAlternatives) {
      g.push({
        severity: "high",
        id: "rejected-time-axis",
        text: `\`${alt.col}\` also parses as a date but was NOT chosen as the time axis — ${alt.whyNotChosen}. ` +
          `If the business question is actually about ${alt.col}, every period in every answer is on the wrong axis. ` +
          `Switch it in the schema panel before trusting anything temporal.`,
      });
    }
  }
  if (cube.meta.unparsedDates) {
    g.push({
      severity: "high", id: "unparsed-dates",
      text: `${cube.meta.unparsedDates.toLocaleString()} row(s) have a \`${prof.timeCol}\` value that could not be parsed and are absent from every total. ` +
        `Sums here will not reconcile against the raw file.`,
    });
  }

  // Measures that must not be summed
  for (const m of prof.measures) {
    if (m.agg === "avg") {
      g.push({
        severity: "high", id: `no-sum-${m.col}`,
        text: `\`${m.col}\` is an average, not an additive quantity (${m.aggReason}). ` +
          `Summing it across groups is meaningless, and comparing a blended value across periods is exposed to Simpson's paradox — ` +
          `use the Explain agent, which splits the move into rate effect and mix effect.`,
      });
    }
  }

  // Dimensions too small for the parametric test
  const small = cube.meta.dims.filter((d) => d.cardinality < DISCOVERY_DEFAULTS.minMembers);
  if (small.length) {
    g.push({
      severity: "medium", id: "small-dimensions",
      text: `${small.map((d) => `\`${d.col}\` (${d.cardinality})`).join(", ")} ${small.length === 1 ? "has" : "have"} fewer than ` +
        `${DISCOVERY_DEFAULTS.minMembers} members, which is below the floor for Grubbs' test — the largest attainable statistic at n=3 is 1.155, ` +
        `so a single-period comparison can never be conclusive there. These dimensions are covered by the binomial persistence test instead, ` +
        `which reads the evidence across periods and has more power at small n, not less.`,
    });
  }

  // High-cardinality exclusions
  if (prof.excludedDims.length) {
    g.push({
      severity: "medium", id: "excluded-dims",
      text: `${prof.excludedDims.map((e) => `\`${e.col}\` (${e.cardinality} values)`).join(", ")} exceeded the cardinality cutoff and ` +
        `${prof.excludedDims.length === 1 ? "is" : "are"} not in the cube. No question can be answered along ${prof.excludedDims.length === 1 ? "it" : "them"}.`,
    });
  }

  // Cross-pairs skipped
  if (cube.meta.crossPairsSkipped) {
    g.push({
      severity: "medium", id: "skipped-pairs",
      text: `${cube.meta.crossPairsSkipped} dimension pair(s) were not materialised to stay inside the memory budget. ` +
        `Two-way questions across those pairs will return nothing, which is not the same as finding nothing.`,
    });
  }

  // Thin cells
  const period_ = period || latestPeriod(cube, grain);
  const m0 = prof.measures[0]?.col;
  if (m0 && period_) {
    for (const d of cube.meta.dims) {
      const rows = queryBreakdown(cube, d.col, m0, grain, period_);
      const thin = rows.filter((r) => r.n < DISCOVERY_DEFAULTS.minCellRows);
      if (thin.length && thin.length < rows.length) {
        g.push({
          severity: "low", id: `thin-${d.col}`,
          text: `In \`${d.col}\`, ${thin.map((t) => `${t.label} (${t.n} rows)`).join(", ")} sit below the support floor. ` +
            `They appear in raw breakdowns with their row count attached but are excluded from tested claims — ` +
            `a member with 2 rows a month can swing 400% on noise alone.`,
        });
      }
    }
  }

  // History length
  const periods = allPeriods(cube, grain);
  if (periods.length < 12) {
    g.push({
      severity: "medium", id: "short-history",
      text: `Only ${periods.length} ${grain} period(s) of history. Forecasting needs about 12 to separate level from trend and still hold back ` +
        `folds for a backtest, so the Forecast agent will decline rather than draw a line through noise.`,
    });
  }

  // Truncation
  if (prof.rowCount >= 1000000) {
    g.push({
      severity: "high", id: "truncated",
      text: `The file hit the browser row limit. Totals reflect the rows that were read, not the whole file.`,
    });
  }

  const order = { high: 0, medium: 1, low: 2 };
  g.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  return g;
}

/* ─── ANALYSIS PATTERNS ──────────────────────────────────────────────────── */

function analysisPatterns(prof, cube, grain) {
  const m = prof.measures[0]?.col;
  const m2 = prof.measures[1]?.col;
  const d = cube.meta.dims[0]?.col;
  const periods = allPeriods(cube, grain);
  const out = [];

  if (m) out.push({ q: `Scan for anything unusual`, agent: "scan",
    works: true, why: `Traverses every cell and applies false-discovery-rate control. On flat data it will correctly return nothing.` });
  if (m && d) out.push({ q: `Why did ${m} drop?`, agent: "drill",
    works: periods.length >= 2, why: periods.length >= 2
      ? `Decomposes the largest period-over-period move across every dimension and localises it into a 2-way cell.`
      : `Needs at least two periods; this file has ${periods.length}.` });
  if (m && d) out.push({ q: `Deep dive ${m} by ${d}`, agent: "deepdive",
    works: true, why: `Profiles every member with MAD-robust z-scores and a Grubbs test on the extreme one.` });
  if (m2) out.push({ q: `What correlates with ${m}?`, agent: "correlate",
    works: true, why: `Pearson and Spearman with confidence intervals; flags near-perfect pairs as arithmetically derived rather than as findings.` });
  out.push({ q: `Forecast ${m} next 3 periods`, agent: "forecast",
    works: periods.length >= 8, why: periods.length >= 8
      ? `Holt linear trend with a walk-forward backtest reported as MASE against a naive benchmark.`
      : `Declines below 8 periods — ${periods.length} available.` });
  const avgM = prof.measures.find((x) => x.agg === "avg");
  if (avgM && d) out.push({ q: `Explain the change in ${avgM.col}`, agent: "explain",
    works: true, why: `${avgM.col} is a blended average, so the change splits into rate effect and mix effect. This is the Simpson's paradox check.` });

  return out;
}

/* ─── QUESTIONS THIS DATA CANNOT ANSWER ──────────────────────────────────── */

function limits(prof, cube) {
  const out = [];
  out.push(`Anything causal. The engine decomposes and tests; it identifies no counterfactual and controls for no confounder. ` +
    `"Which member moved" is answerable here. "What would have happened otherwise" is not.`);
  if (!prof.dims.length) out.push(`Any question by segment — no usable dimension survived profiling.`);
  if (prof.measures.length < 2) out.push(`Cross-measure correlation — only one numeric measure is present.`);
  if (prof.excludedDims.length) {
    out.push(`Anything along ${prof.excludedDims.map((e) => `\`${e.col}\``).join(", ")} — excluded for cardinality.`);
  }
  out.push(`Anything about a driver not in this file. If the change is caused by a price change, a competitor, or an outage, ` +
    `the decomposition will show the change spread evenly and report that no dimension concentrates it. That is the engine telling you the answer is elsewhere.`);
  return out;
}

/* ─── GENERATE ───────────────────────────────────────────────────────────── */

/**
 * Build the skill for a loaded dataset.
 * Returns both a structured object (for retrieval and for the narrator) and a
 * markdown rendering (for the user to read, edit or check into a repo).
 */
export async function generateSkill({ profile: prof, cube, fingerprint }) {
  const grain = resolveGrain(cube, "month");
  const periods = allPeriods(cube, grain);
  const period = periods[periods.length - 1] || null;
  const m0 = prof.measures[0]?.col;

  const skill = {
    version: SKILL_VERSION,
    generatedFrom: "schema profiling — no human curation, regenerated on every load and on any schema override",
    dataset: {
      fileName: fingerprint?.fileName || "(unnamed)",
      rows: prof.rowCount,
      columns: prof.colCount,
      contentHash: fingerprint?.contentHash?.hex || null,
    },
    grain: {
      timeColumn: prof.timeCol,
      chosenBecause: prof.timeChoiceReason || "only one date column in this file",
      nativeGrain: grain,
      availableGrains: ["day", "week", "month", "quarter", "year"].filter((g) => allPeriods(cube, g).length >= 2),
      periods: periods.length,
      earliest: periods[0] || null,
      latest: period,
    },
    measures: prof.measures.map((m) => ({
      name: m.col, agg: m.agg, aggReason: m.aggReason,
      description: describeMeasure(m, cube),
      min: m.min, max: m.max, median: m.p50, dispersionIndex: m.dispersionIndex,
    })),
    dimensions: cube.meta.dims.map((d) => ({
      name: d.col, cardinality: d.cardinality, values: d.values || [],
      description: describeDimension(d, cube, m0, grain, period),
    })),
    excluded: [
      ...prof.excludedDims.map((e) => ({ name: e.col, reason: `${e.cardinality} distinct values — above the cardinality cutoff` })),
      ...prof.idCols.map((c) => ({ name: c, reason: prof.schema[c]?.reason || "identifier" })),
      ...prof.textCols.map((c) => ({ name: c, reason: prof.schema[c]?.reason || "free text" })),
    ],
    gotchas: collectGotchas(prof, cube, grain, period),
    patterns: analysisPatterns(prof, cube, grain),
    limits: limits(prof, cube),
    crossPairs: cube.meta.crossPairs,
    engine: ENGINE_STAMP,
  };

  skill.skillHash = (await hash(canonical(skill))).hex;
  skill.markdown = renderSkillMarkdown(skill);
  return skill;
}

export function renderSkillMarkdown(s) {
  const L = [];
  L.push(`# Dataset skill — ${s.dataset.fileName}`);
  L.push("");
  L.push(`> Generated from schema profiling, not written by hand. Regenerated on every load, so it cannot drift from the data.`);
  L.push(`> \`${s.dataset.rows.toLocaleString()}\` rows × ${s.dataset.columns} columns · content \`${(s.dataset.contentHash || "").slice(0, 12)}…\` · skill \`${(s.skillHash || "").slice(0, 12)}…\``);
  L.push("");

  L.push(`## Grain`);
  L.push("");
  L.push(`- Time axis: \`${s.grain.timeColumn}\` — ${s.grain.chosenBecause}`);
  L.push(`- ${s.grain.periods} ${s.grain.nativeGrain} periods, ${s.grain.earliest} through ${s.grain.latest}`);
  L.push(`- Grains available: ${s.grain.availableGrains.join(", ")}`);
  L.push("");

  L.push(`## Measures`);
  L.push("");
  for (const m of s.measures) {
    L.push(`### \`${m.name}\``);
    for (const b of m.description) L.push(`- ${b}`);
    L.push("");
  }

  L.push(`## Dimensions`);
  L.push("");
  for (const d of s.dimensions) {
    L.push(`### \`${d.name}\``);
    for (const b of d.description) L.push(`- ${b}`);
    L.push("");
  }

  if (s.excluded.length) {
    L.push(`## Not in the cube`);
    L.push("");
    for (const e of s.excluded) L.push(`- \`${e.name}\` — ${e.reason}`);
    L.push("");
  }

  L.push(`## Gotchas`);
  L.push("");
  if (!s.gotchas.length) {
    L.push(`Nothing detected. This file profiled cleanly.`);
  } else {
    for (const g of s.gotchas) {
      L.push(`- **[${g.severity.toUpperCase()}]** ${g.text}`);
    }
  }
  L.push("");

  L.push(`## Analysis patterns that work here`);
  L.push("");
  for (const p of s.patterns) {
    L.push(`- ${p.works ? "✅" : "🚫"} **${p.q}** (${p.agent}) — ${p.why}`);
  }
  L.push("");

  L.push(`## What this data cannot answer`);
  L.push("");
  for (const l of s.limits) L.push(`- ${l}`);
  L.push("");

  return L.join("\n");
}

/**
 * Flatten the skill into retrievable passages, so the narrator can cite a
 * specific gotcha rather than being handed the whole document.
 */
export function skillPassages(skill) {
  const out = [];
  for (const g of skill.gotchas) {
    out.push({ id: `gotcha:${g.id}`, kind: "gotcha", severity: g.severity, text: g.text,
      subjects: extractBackticked(g.text) });
  }
  for (const m of skill.measures) {
    out.push({ id: `measure:${m.name}`, kind: "measure",
      text: `${m.name}: ${m.description.join("; ")}`, subjects: [m.name] });
  }
  for (const d of skill.dimensions) {
    out.push({ id: `dimension:${d.name}`, kind: "dimension",
      text: `${d.name}: ${d.description.join("; ")}`, subjects: [d.name, ...(d.values || [])] });
  }
  for (const l of skill.limits) {
    out.push({ id: `limit:${l.slice(0, 24)}`, kind: "limit", text: l, subjects: extractBackticked(l) });
  }
  return out;
}

function extractBackticked(text) {
  const out = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}
