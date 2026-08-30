/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — INTENT PARSER
   ───────────────────────────────────────────────────────────────────────────
   Rule-based and schema-aware. Deliberately not a model.

   The reason is the whole thesis of the engine: if an LLM picks the agent and
   the dimension, then the same question can route differently on two runs and
   the decision record stops being reproducible. Rules are dull and they are
   auditable. When a rule misses, the parser says which part it could not
   resolve rather than guessing, and the UI offers the choice.
   ═══════════════════════════════════════════════════════════════════════════ */

export const NLU_VERSION = "nlu/1.0.0";

// Prefix stems deliberately carry NO trailing \b. The first version of this
// file wrote /\bcorrelat\b/, which matches neither "correlates" nor
// "correlation" -- there is no word boundary between t and e. The router
// silently fell through to the default agent and the test caught it.
const AGENT_PATTERNS = [
  { agent: "scan",      re: /\b(scan|survey|overview|anything (interesting|notable)|what stands out|explore|surpris)/ },
  { agent: "forecast",  re: /\b(forecast|predict|project|next (month|quarter|year|period|\d)|what happens next|expected)/ },
  { agent: "explain",   re: /\b(explain|decompos|attribut|contribut|mix shift|composition|simpson|break ?down the (change|move|drop|drift))/ },
  { agent: "correlate", re: /\b(correlat|relationship|move together|co.?move|linked|associated|odd one|outlier)/ },
  { agent: "deepdive",  re: /\b(deep ?dive|profile|every (member|value)|all (members|values)|full analysis|break down)/ },
  { agent: "drill",     re: /\b(why|reason|cause|diagnos|root|drop|decline|fell|fall|worse|spike|surge|anomal|drill|localiz|localis|where)/ },
];

const GRAIN_PATTERNS = [
  { grain: "day",     re: /\b(daily|day|days|by day)\b/ },
  { grain: "week",    re: /\b(weekly|week|weeks|wow)\b/ },
  { grain: "quarter", re: /\b(quarterly|quarter|quarters|qoq|q[1-4])\b/ },
  { grain: "year",    re: /\b(yearly|annual|annually|year|years|yoy)\b/ },
  { grain: "month",   re: /\b(monthly|month|months|mom)\b/ },
];

const REVENUE_SYNONYMS = /\b(sales|revenue|gmv|turnover|top ?line|bookings)\b/;

function normalize(name) {
  return name.toLowerCase().replace(/[_\-.]+/g, " ").trim();
}

/** Longest-match column lookup, so order_total beats order on "order total". */
function matchColumn(text, columns) {
  let best = null;
  for (const col of columns) {
    const n = normalize(col);
    if (!n) continue;
    if (text.includes(n) || text.includes(col.toLowerCase())) {
      if (!best || n.length > normalize(best).length) best = col;
    }
  }
  return best;
}

/**
 * Find a dimension VALUE named in the query, searching EVERY dimension.
 * "why did revenue drop in West" never says the word "region", so looking
 * only inside an already-chosen dimension finds nothing. Searching all of
 * them lets the value select its own dimension, which is what was meant.
 */
function matchDimensionValue(text, prof) {
  let best = null;
  for (const d of prof.dims) {
    if (!d.values) continue;
    for (const v of d.values) {
      const t = String(v).toLowerCase();
      if (t.length < 3) continue;
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp("\\b" + esc + "\\b").test(text)) continue;
      if (!best || t.length > String(best.value).length) best = { dim: d.col, value: v };
    }
  }
  return best;
}

export function parseIntent(text, prof) {
  const q = " " + text.toLowerCase().trim() + " ";
  const dimCols = prof.dims.map((d) => d.col);
  const measureCols = prof.measures.map((m) => m.col);
  const unresolved = [];

  // ── Measure ──
  let measure = matchColumn(q, measureCols);
  let measureExplicit = !!measure;
  if (!measure && REVENUE_SYNONYMS.test(q)) {
    measure = measureCols.find((m) => /revenue|sales|gmv|amount|value|total|price/i.test(m)) || null;
    measureExplicit = !!measure;
  }
  if (!measure) {
    measure = measureCols[0] || null;
    if (measureCols.length > 1) unresolved.push({ field: "measure", options: measureCols, chose: measure });
  }

  // ── Dimension ──
  let dimension = matchColumn(q, dimCols);
  const dimensionExplicit = !!dimension;

  // ── Grain ──
  let grain = null;
  for (const g of GRAIN_PATTERNS) if (g.re.test(q)) { grain = g.grain; break; }
  if (!grain) grain = "month";

  // ── Agent ──
  let agent = null;
  for (const a of AGENT_PATTERNS) if (a.re.test(q)) { agent = a.agent; break; }

  // ── Non-agent shapes ──
  let shape = "breakdown";
  if (!agent) {
    if (/\btrend|over time|history|by (month|quarter|year|week|day)\b/.test(q)) shape = "trend";
    else if (/\btop|bottom|best|worst|rank|highest|lowest\b/.test(q)) shape = "topk";
    else if (/\btotal|overall|sum|grand|how much|how many\b/.test(q)) shape = "total";
    else if (!dimension) shape = "trend";
  }

  const kMatch = q.match(/\btop\s+(\d{1,2})\b/);
  const k = kMatch ? Math.min(20, +kMatch[1]) : 5;

  const hMatch = q.match(/\bnext\s+(\d{1,2})\b/);
  const horizon = hMatch ? Math.min(12, +hMatch[1]) : 3;

  // A named value pins its own dimension, ahead of any fallback.
  const valueHit = matchDimensionValue(q, prof);
  if (valueHit && !dimensionExplicit) dimension = valueHit.dim;

  if (agent && ["drill", "deepdive", "explain"].includes(agent) && !dimension) {
    dimension = dimCols[0] || null;
    if (dimCols.length > 1) unresolved.push({ field: "dimension", options: dimCols, chose: dimension });
  }

  const dimensionValue = valueHit && valueHit.dim === dimension ? valueHit.value : null;

  return {
    version: NLU_VERSION,
    raw: text,
    title: text.length > 60 ? text.slice(0, 58) + "…" : text,
    agent, shape: agent ? "agent" : shape,
    measure, measureExplicit,
    dimension, dimensionExplicit, dimensionValue,
    grain, k, horizon,
    period: null,
    // Surfaced in the UI as "I assumed X — change it?" rather than silently
    // picking the first column and hoping.
    unresolved,
  };
}

/** Suggestion chips generated from the real schema, one per agent. */
export function suggestions(prof) {
  const m = prof.measures[0]?.col;
  const m2 = prof.measures[1]?.col;
  const d = prof.dims[0]?.col;
  const out = [];
  if (!m) return out;
  if (d) out.push({ text: `${m} by ${d}`, agent: null });
  out.push({ text: `Scan for anything unusual`, agent: "scan" });
  if (d) out.push({ text: `Why did ${m} drop?`, agent: "drill" });
  if (d) out.push({ text: `Deep dive ${m} by ${d}`, agent: "deepdive" });
  if (m2) out.push({ text: `What correlates with ${m}?`, agent: "correlate" });
  out.push({ text: `Forecast ${m} next 3 periods`, agent: "forecast" });
  if (d) out.push({ text: `Explain the change in ${m}`, agent: "explain" });
  return out;
}
