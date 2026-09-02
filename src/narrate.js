/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — NARRATION
   ───────────────────────────────────────────────────────────────────────────
   The brief says: "the LLM narrator retrieves from it, but the numbers still
   come from the deterministic engine."

   Agreeing with that in a design doc is easy. Enforcing it is the whole job,
   because a fluent model handed a finding and a context document will
   confidently produce "revenue fell roughly 40%, costing about $1.2M" when the
   engine computed 38.7% and never computed a dollar impact at all. The second
   number is invented, it is plausible, and it will be in a board deck by
   Thursday.

   So the contract here is mechanical, not aspirational:

     1. The engine computes a finding and a deterministic sentence. That
        sentence is always available and is always what gets recorded.
     2. The narrator receives the finding, the relevant skill passages and the
        retrieved context entries — as structured data, with an explicit
        allow-list of every numeric value it is permitted to utter.
     3. Whatever comes back is parsed for numbers. Any number not in the
        allow-list is a violation, and a violation discards the entire
        narration and falls back to the deterministic sentence.

   The guard runs whether or not a model is configured, so the property is
   tested in CI with no network and no key.

   Default configuration is NO MODEL. The deterministic narrator is the one
   that ships, because it cannot be wrong about a number and it needs no key.
   ═══════════════════════════════════════════════════════════════════════════ */

import { skillPassages } from "./skill.js";
import { contextSentence } from "./context.js";

export const NARRATE_VERSION = "narrate/1.0.0";

/* ─── NUMBER EXTRACTION AND COMPARISON ───────────────────────────────────── */

/** Every numeric token in a piece of prose, normalised to a JS number. */
export function extractNumbers(text) {
  if (!text) return [];
  const out = [];
  // Matches 1,234.5  0.0042  -12%  3.4e-5  $1.2M  1.2K
  const re = /-?\$?\d[\d,]*(?:\.\d+)?(?:[eE][-+]?\d+)?\s*(?:%|[KMB]\b)?/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0].trim();
    let s = raw.replace(/[$,\s]/g, "");
    let mult = 1;
    if (/%$/.test(s)) { s = s.slice(0, -1); }
    else if (/K$/i.test(s)) { s = s.slice(0, -1); mult = 1e3; }
    else if (/M$/i.test(s)) { s = s.slice(0, -1); mult = 1e6; }
    else if (/B$/i.test(s)) { s = s.slice(0, -1); mult = 1e9; }
    const v = Number(s) * mult;
    if (Number.isFinite(v)) out.push({ raw, value: v });
  }
  return out;
}

/**
 * Is `v` an acceptable rendering of something the engine actually computed?
 * Tolerant of rounding and of percentage-versus-proportion, because "39%" is a
 * fair rendering of 0.387. Not tolerant of anything else.
 */
function isAllowed(v, allowed) {
  const forms = [v, v / 100, v * 100];
  for (const f of forms) {
    for (const a of allowed) {
      if (a === 0 && Math.abs(f) < 1e-9) return true;
      if (a === 0) continue;
      const rel = Math.abs(f - a) / Math.abs(a);
      if (rel <= 0.02) return true;              // rounding slack
      // Rounded-to-significant-figures renderings, e.g. 38.7 -> 39.
      if (Math.abs(Math.round(f) - Math.round(a)) < 1e-9 && Math.abs(a) >= 1) return true;
    }
  }
  return false;
}

/** Collect every value the narrator is permitted to state. */
export function allowedNumbers(card, contextHits = []) {
  const set = new Set();
  const add = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) set.add(v);
  };

  add(card.kpi); add(card.delta);
  const e = card.evidence;
  if (e) { add(e.statistic); add(e.p); add(e.q); add(e.n); add(e.members); add(e.effect); }
  if (card.audit) { add(card.audit.testsRun); add(card.audit.survived); add(card.audit.fdrQ); }
  for (const d of card.chart_data || []) { add(d.value); add(d.n); add(d.lo); add(d.hi); }
  for (const f of card.findings || []) {
    add(f.val); add(f.n); add(f.p); add(f.q); add(f.statistic); add(f.share);
    add(f.effect); add(f.robustZ); add(f.members); add(f.hits); add(f.observedPeriods);
  }
  const add2 = (o) => { if (o) for (const k of Object.keys(o)) add(o[k]); };
  if (card.decomposition?.additive) {
    add(card.decomposition.additive.total); add(card.decomposition.additive.before);
    add(card.decomposition.additive.after); add(card.decomposition.additive.cellsTo80pct);
    for (const r of card.decomposition.additive.rows) add2(r);
  }
  if (card.decomposition?.mixRate) {
    const mr = card.decomposition.mixRate;
    add(mr.blended0); add(mr.blended1); add(mr.change);
    add(mr.rateEffect); add(mr.mixEffect); add(mr.interaction);
    for (const r of mr.rows) add2(r);
  }
  for (const f of card.forecast || []) add2(f);
  if (card.backtest) add2(card.backtest);
  for (const c of card.correlations || []) { add(c.r); add(c.p); add(c.n); add(c.rho);
    if (c.ci) { add(c.ci[0]); add(c.ci[1]); } }
  if (card.crossLocalization?.lead) add2(card.crossLocalization.lead);

  // Anything already in the deterministic sentence is by construction allowed.
  for (const n of extractNumbers(card.summary || "")) add(n.value);
  // Quoting a retrieved context entry verbatim is legitimate.
  for (const h of contextHits) for (const n of extractNumbers(h.text)) add(n.value);
  // Period labels and years.
  for (const s of [card.period, card.grain, ...(card.chart_data || []).map((d) => d.period)]) {
    for (const n of extractNumbers(String(s ?? ""))) add(n.value);
  }
  // Small integers used for ordinals and counts in ordinary prose.
  for (let i = 0; i <= 12; i++) set.add(i);

  return Array.from(set);
}

/**
 * Check a narration against the allow-list.
 * Returns every offending token, so a failure is diagnosable rather than just
 * a rejection.
 */
export function verifyNarration(text, allowed) {
  const violations = [];
  for (const n of extractNumbers(text)) {
    if (!isAllowed(n.value, allowed)) violations.push(n.raw);
  }
  return { ok: violations.length === 0, violations, checked: extractNumbers(text).length };
}

/* ─── PAYLOAD ────────────────────────────────────────────────────────────── */

/**
 * Assemble everything a narrator is allowed to see. Structured, not prose, so
 * the model cannot mistake a nearby sentence for a licensed claim.
 */
export function buildNarrationPayload({ card, skill, contextHits = [] }) {
  const subjects = [card.measure, card.dimension, card.evidence?.value, card.evidence?.a, card.evidence?.b]
    .filter(Boolean);
  const passages = skill ? skillPassages(skill).filter((p) =>
    p.subjects.some((s) => subjects.includes(s)) || p.kind === "gotcha") : [];

  return {
    finding: {
      agent: card.agent,
      measure: card.measure,
      dimension: card.dimension,
      grain: card.grain,
      period: card.period,
      deterministicSummary: card.summary,
      evidence: card.evidence ? {
        test: card.evidence.test,
        statistic: card.evidence.statistic,
        p: card.evidence.p, q: card.evidence.q,
        rows: card.evidence.n,
        descriptiveOnly: !!card.evidence.descriptiveOnly,
        lowPower: !!card.evidence.lowPower,
      } : null,
      multiplicity: card.audit ? {
        testsRun: card.audit.testsRun, survived: card.audit.survived, fdrQ: card.audit.fdrQ,
      } : null,
    },
    skillPassages: passages.slice(0, 6).map((p) => ({ id: p.id, kind: p.kind, text: p.text })),
    contextEntries: contextHits.map((h) => ({
      id: h.id, source: h.source, dates: h.dates, why: h.reasons, text: h.text,
    })),
    rules: [
      "State no number that is not present in this payload.",
      "Context entries are time-aligned candidates. Never assert that one caused the finding.",
      "If the evidence is marked descriptiveOnly or lowPower, say so plainly.",
      "Do not soften or omit a stated caveat.",
      "Two or three sentences.",
    ],
    allowedNumbers: allowedNumbers(card, contextHits),
  };
}

export const NARRATOR_SYSTEM_PROMPT = `You narrate findings from a statistical engine.

The engine has already computed everything. You are writing the sentence a
person reads, not deciding what is true.

Hard rules:
- Every number you write must appear in allowedNumbers. If you want to express
  a magnitude that is not there, describe it in words instead.
- Context entries are time-aligned candidate explanations, retrieved because
  their date sits in or just before the period. Write "coincides with" or
  "may relate to". Never "caused", "because of", or "driven by".
- If evidence.descriptiveOnly is true, say the finding carries no significance
  test. If lowPower is true, say the test has limited power.
- Never drop a caveat that is in the payload.
- Two or three sentences, plain and direct. No preamble.`;

/* ─── NARRATE ────────────────────────────────────────────────────────────── */

/**
 * Produce the sentence for a card.
 *
 * `llm` is an optional async function (payload, systemPrompt) => string.
 * With no llm the deterministic sentence is used and context is appended by a
 * template. Either way the guard runs and the result reports which path was
 * taken, so the UI and the audit record never have to guess.
 */
export async function narrate({ card, skill, contextHits = [], llm = null }) {
  const deterministic = card.summary;
  const ctxLine = contextSentence(contextHits, card.period);
  const fallback = ctxLine ? `${deterministic} ${ctxLine}` : deterministic;
  const allowed = allowedNumbers(card, contextHits);

  if (!llm) {
    // The guard runs on the deterministic path too. It should never fire — if
    // it does, the engine is emitting a number it did not compute, which is a
    // bug worth failing loudly on in tests.
    const check = verifyNarration(fallback, allowed);
    return {
      text: fallback, source: "deterministic", guard: check,
      contextUsed: contextHits.map((h) => h.id),
    };
  }

  const payload = buildNarrationPayload({ card, skill, contextHits });
  let text;
  try {
    text = await llm(payload, NARRATOR_SYSTEM_PROMPT);
  } catch (err) {
    return {
      text: fallback, source: "deterministic-fallback",
      reason: `narrator call failed: ${err.message}`,
      guard: verifyNarration(fallback, allowed),
      contextUsed: contextHits.map((h) => h.id),
    };
  }

  const check = verifyNarration(text || "", allowed);
  if (!check.ok) {
    // Whole narration discarded, not patched. A sentence with one invented
    // number is not salvageable by deleting the number — the reasoning that
    // produced it is also suspect.
    return {
      text: fallback, source: "deterministic-fallback",
      reason: `narration rejected: ${check.violations.length} number(s) not computed by the engine (${check.violations.join(", ")})`,
      rejected: text, guard: check,
      contextUsed: contextHits.map((h) => h.id),
    };
  }
  return { text, source: "llm", guard: check, contextUsed: contextHits.map((h) => h.id) };
}
