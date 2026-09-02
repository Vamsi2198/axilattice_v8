/* Tests for the three additions: auto-generated skill, business context
   retrieval, and the narration numeric guard. */

import { loadDataset, discoverInsights, allPeriods } from "../src/engine/index.js";
import { runAgent } from "../src/agents.js";
import { generateSkill, skillPassages } from "../src/skill.js";
import {
  indexContext, retrieveContext, extractDates, chunkDocument, periodRange, contextSentence,
} from "../src/context.js";
import {
  narrate, verifyNarration, allowedNumbers, extractNumbers, buildNarrationPayload,
} from "../src/narrate.js";
import {
  fingerprintDataset, createJournal, appendToJournal, verifyJournal, journalToMarkdown,
} from "../src/provenance.js";
import * as gen from "./generate.mjs";

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  ✗ ${name}  ${detail}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }
const NOPACE = { paced: false };

/* ═══ A. SKILL GENERATION ════════════════════════════════════════════════ */
section("A. Auto-generated skill");
{
  const { csv, truth } = gen.scaleAndPathology({ rows: 40000 });
  const L = await loadDataset(csv, { fileName: "pathology.csv" });
  const fp = await fingerprintDataset(csv, L.parsed, L.profile, "pathology.csv");
  const skill = await generateSkill({ ...L, fingerprint: fp });

  ok("skill names the chosen time axis", skill.grain.timeColumn === truth.expectTimeCol,
    skill.grain.timeColumn);

  const rejected = skill.gotchas.find((g) => g.id === "rejected-time-axis");
  ok("HIGH gotcha: the decoy date column is called out with its consequence",
    rejected && rejected.severity === "high" && rejected.text.includes(truth.decoyTimeCol),
    rejected?.text?.slice(0, 90));
  if (rejected) console.log(`      ${rejected.text.slice(0, 150)}…`);

  const noSum = skill.gotchas.find((g) => g.id === "no-sum-margin_pct");
  ok("HIGH gotcha: the rate measure must not be summed", !!noSum && noSum.severity === "high",
    noSum?.text?.slice(0, 80));

  ok("measures carry their dispersion index", skill.measures.every((m) => "dispersionIndex" in m), "");
  ok("identifier columns are listed as excluded, with a reason",
    skill.excluded.some((e) => e.name === "order_id" && e.reason), JSON.stringify(skill.excluded.slice(0, 2)));
  ok("patterns say which agents work on THIS file",
    skill.patterns.length >= 4 && skill.patterns.every((p) => typeof p.works === "boolean"), "");
  ok("limits state the causal boundary explicitly",
    skill.limits.some((l) => /causal|counterfactual/i.test(l)), "");
  ok("markdown renders", /## Gotchas/.test(skill.markdown) && skill.markdown.length > 800,
    `${skill.markdown.length} chars`);
  ok("skill has a content hash", /^[0-9a-f]{32,}$/.test(skill.skillHash), skill.skillHash?.slice(0, 12));

  // Regeneration determinism
  const again = await generateSkill({ ...L, fingerprint: fp });
  ok("regenerating gives an identical hash", again.skillHash === skill.skillHash, "");

  // Small-dimension gotcha on a different file
  const sd = gen.smallDimensionEffect({ months: 12, perMonth: 300 });
  const L2 = await loadDataset(sd.csv, { fileName: "sd.csv" });
  const fp2 = await fingerprintDataset(sd.csv, L2.parsed, L2.profile, "sd.csv");
  const sk2 = await generateSkill({ ...L2, fingerprint: fp2 });
  const small = sk2.gotchas.find((g) => g.id === "small-dimensions");
  ok("gotcha explains the 3-member Grubbs ceiling and names the fallback test",
    small && /1\.155/.test(small.text) && /persistence/i.test(small.text), small?.text?.slice(0, 100));
  if (small) console.log(`      ${small.text.slice(0, 170)}…`);

  // Clean file => few or no gotchas
  const clean = gen.trendySeries({ months: 24 });
  const L3 = await loadDataset(clean.csv, { fileName: "clean.csv" });
  const fp3 = await fingerprintDataset(clean.csv, L3.parsed, L3.profile, "clean.csv");
  const sk3 = await generateSkill({ ...L3, fingerprint: fp3 });
  ok("a clean file produces no HIGH gotchas",
    sk3.gotchas.filter((g) => g.severity === "high").length === 0,
    sk3.gotchas.filter((g) => g.severity === "high").map((g) => g.id).join(","));

  ok("passages are retrievable units, not one blob",
    skillPassages(skill).length >= 5, `${skillPassages(skill).length}`);
}

/* ═══ B. CONTEXT PARSING AND RETRIEVAL ═══════════════════════════════════ */
section("B. Business context — parsing");
{
  ok("period range: month", JSON.stringify(periodRange("2025-09", "month")) ===
    JSON.stringify({ start: periodRange("2025-09-01", "day").start, end: periodRange("2025-09-30", "day").end }), "");
  ok("period range: quarter spans three months",
    periodRange("2025-Q3", "quarter").end - periodRange("2025-Q3", "quarter").start === 91, "");

  const forms = [
    ["Outage on 2025-09-14 affected partners", "2025-09-14"],
    ["Deployed 14/09/2025 to production", "2025-09-14"],
    ["Sept 14 2025 incident", "2025-09-14"],
    ["14 September 2025 postmortem", "2025-09-14"],
    ["Shipped in September 2025", "2025-09"],
    ["Planned for 2025-09", "2025-09"],
    ["Target Q3 2025", "2025-Q3"],
  ];
  for (const [text, expect] of forms) {
    const d = extractDates(text);
    ok(`parses "${text.slice(0, 30)}…" → ${expect}`, d.some((x) => x.label === expect),
      d.map((x) => x.label).join(","));
  }
  ok("text with no date yields none", extractDates("We should improve onboarding").length === 0, "");

  const doc = `# Incidents\n\n- 2025-09-14: Partner API outage\n- 2025-08-02: Minor blip\n\n## Roadmap\n\nRebuild checkout.\n`;
  const chunks = chunkDocument(doc);
  ok("bullets and paragraphs become separate entries", chunks.length === 3, `${chunks.length}`);
  ok("headings are carried onto their entries", chunks[0].heading === "Incidents", chunks[0].heading);
}

section("B2. Business context — retrieval ranking");
{
  const { csv, truth } = gen.temporalBreak({ months: 21, perMonth: 700 });
  const L = await loadDataset(csv, { fileName: "break.csv" });
  const periods = allPeriods(L.cube, "month");
  const dropPeriod = periods[periods.length - 1];
  const [y, mo] = dropPeriod.split("-");

  const contextDoc = `# Incident log

- ${y}-${mo}-08: Partner API returned 5xx for nine days across the West region. Reseller orders did not sync.
- ${y}-${mo}-22: Warehouse stocktake, no customer impact.

# Roadmap

- Rebuild the checkout flow. No date set.
- Expand into the Nordics next year.

# Old notes

- 2019-04-01: Legacy migration completed in the West region.
`;
  const subjects = [
    ...L.cube.meta.dims.map((d) => d.col),
    ...L.cube.meta.dims.flatMap((d) => d.values || []),
    ...L.cube.meta.measures.map((m) => m.col),
  ];
  const idx = await indexContext(contextDoc, { fileName: "incidents.md", subjects });
  ok("indexes every entry", idx.entryCount >= 5, `${idx.entryCount}`);
  ok("counts how many carry a date", idx.datedCount >= 3, `${idx.datedCount}`);

  const hits = retrieveContext(idx, {
    period: dropPeriod, grain: "month",
    subjects: ["revenue", "region", truth.value, truth.crossValue],
    queryText: "why did revenue drop",
  });
  ok("returns hits for the drop period", hits.length > 0, "");
  ok("the in-period outage ranks first", hits[0]?.text.includes("Partner API"),
    hits[0]?.text?.slice(0, 60));
  console.log(`      top hit: ${hits[0]?.text.slice(0, 90)}…`);
  console.log(`      matched because: ${hits[0]?.reasons.join(" · ")}`);

  ok("undated roadmap items do not outrank a dated in-period incident",
    !hits[0]?.text.includes("checkout"), hits[0]?.text?.slice(0, 40));
  ok("a 2019 entry naming the same region is not retrieved for a 2025 period",
    !hits.some((h) => h.text.includes("Legacy migration")),
    hits.map((h) => h.text.slice(0, 25)).join(" | "));

  // Causes precede effects: an entry in the PRIOR period should still surface.
  const prior = periods[periods.length - 2];
  const [py, pmo] = prior.split("-");
  const idx2 = await indexContext(`- ${py}-${pmo}-20: Partner contract renegotiated, West region terms changed.`,
    { fileName: "notes.md", subjects });
  const hits2 = retrieveContext(idx2, { period: dropPeriod, grain: "month", subjects: ["region", "West"] });
  ok("an entry from the period BEFORE the move is retrieved", hits2.length === 1, `${hits2.length}`);
  ok("and is labelled as preceding, not coincident",
    /period before/.test(hits2[0]?.reasons.join(" ")), hits2[0]?.reasons.join(" · "));

  // A finding with no matching context returns nothing rather than a weak guess.
  const hits3 = retrieveContext(idx, { period: "2021-01", grain: "month", subjects: ["revenue"] });
  ok("no time-aligned entry returns nothing, not a low-confidence guess",
    hits3.length === 0, JSON.stringify(hits3.map((h) => h.text.slice(0, 20))));

  const sentence = contextSentence(hits, dropPeriod);
  ok("the context sentence refuses to claim causation",
    /not evidence of cause|did not test/i.test(sentence), sentence?.slice(0, 80));
}

/* ═══ C. THE NUMERIC GUARD ═══════════════════════════════════════════════ */
section("C. Narration guard — numbers can only come from the engine");
{
  const nums = extractNumbers("Revenue fell 38.7% to 1,234,567 (p < 0.001), about $1.2M lost, 3.4e-5 residual");
  ok("extracts commas, percents, scientific notation and $M suffixes",
    nums.length === 5 && nums.some((n) => n.value === 1200000) && nums.some((n) => n.value === 1234567),
    JSON.stringify(nums.map((n) => n.value)));

  const { csv } = gen.temporalBreak({ months: 20, perMonth: 700 });
  const L = await loadDataset(csv, { fileName: "guard.csv" });
  const fp = await fingerprintDataset(csv, L.parsed, L.profile, "guard.csv");
  const skill = await generateSkill({ ...L, fingerprint: fp });
  const card = await runAgent(L.cube, { title: "why did revenue drop", agent: "drill",
    measure: "revenue", grain: "month" }, null, NOPACE);

  const allowed = allowedNumbers(card, []);
  ok("the allow-list is built from the card's own computed values", allowed.length > 10, `${allowed.length}`);

  // The deterministic path must always pass its own guard. If it ever fails,
  // the engine is printing a number it did not compute.
  const det = await narrate({ card, skill, contextHits: [], llm: null });
  ok("the deterministic sentence passes its own guard", det.guard.ok,
    JSON.stringify(det.guard.violations));
  ok("and is labelled as deterministic", det.source === "deterministic", det.source);

  // A well-behaved model.
  const goodLLM = async () =>
    `Revenue moved ${card.decomposition.additive.total.toFixed(0)} between the two periods. ` +
    `The change is concentrated in ${card.decomposition.additive.rows[0].key}. This is a decomposition, not a cause.`;
  const good = await narrate({ card, skill, contextHits: [], llm: goodLLM });
  ok("a model that only uses engine numbers is accepted", good.source === "llm",
    `${good.source} ${JSON.stringify(good.guard.violations)}`);

  // The failure mode this exists for: a plausible, invented business impact.
  const hallucinating = async () =>
    `Revenue fell sharply, costing the business roughly $2.4M in lost bookings and affecting 47,000 customers.`;
  const bad = await narrate({ card, skill, contextHits: [], llm: hallucinating });
  ok("invented figures are rejected", bad.source === "deterministic-fallback", bad.source);
  ok("and the whole narration is discarded, not patched",
    bad.text === (card.summary) || bad.text.startsWith(card.summary), bad.text.slice(0, 60));
  ok("the rejected text is retained for diagnosis", !!bad.rejected, "");
  ok("the reason names the offending tokens", /2\.4M|47,000/.test(bad.reason || ""), bad.reason);
  console.log(`      rejected: ${bad.reason}`);

  // Rounding must not be treated as invention.
  const rounding = async () => {
    const t = card.decomposition.additive.total;
    return `Revenue moved about ${Math.round(t / 1000) * 1000} over the period.`;
  };
  const r = await narrate({ card, skill, contextHits: [], llm: rounding });
  ok("a rounded rendering of a real number is NOT a violation",
    r.source === "llm", `${r.source} ${JSON.stringify(r.guard?.violations)}`);

  // A model failure must not take the answer down.
  const throwing = async () => { throw new Error("429 rate limited"); };
  const t = await narrate({ card, skill, contextHits: [], llm: throwing });
  ok("a narrator outage falls back to the deterministic sentence",
    t.source === "deterministic-fallback" && t.text.length > 20, t.reason);

  // Quoting an attached context entry verbatim is legitimate.
  const hits = [{ id: "context:0", source: "n.md", dates: ["2025-09-14"],
    reasons: ["dated 2025-09-14, inside 2025-09"], text: "Outage lasted 9 days affecting 312 accounts." }];
  const quoting = async () => `The drop coincides with an outage lasting 9 days across 312 accounts.`;
  const q = await narrate({ card, skill, contextHits: hits, llm: quoting });
  ok("numbers quoted from an attached context entry are allowed", q.source === "llm",
    JSON.stringify(q.guard?.violations));

  const payload = buildNarrationPayload({ card, skill, contextHits: hits });
  ok("the payload hands the model an explicit allow-list", payload.allowedNumbers.length > 10, "");
  ok("the payload forbids causal language about context",
    payload.rules.some((r2) => /never assert.*caused/i.test(r2)), "");

  const v = verifyNarration("Growth was 999999999 percent", [1, 2, 3]);
  ok("the guard is not vacuous — it rejects an obvious invention", !v.ok, "");
}

/* ═══ D. END TO END: FOOTER FIELDS AND THE RECORD ════════════════════════ */
section("D. End to end — provenance footer and audit record");
{
  const { csv } = gen.temporalBreak({ months: 20, perMonth: 700 });
  const L = await loadDataset(csv, { fileName: "e2e.csv" });
  const fp = await fingerprintDataset(csv, L.parsed, L.profile, "e2e.csv");
  const skill = await generateSkill({ ...L, fingerprint: fp });
  const periods = allPeriods(L.cube, "month");
  const drop = periods[periods.length - 1];
  const [y, mo] = drop.split("-");

  const subjects = [
    ...L.cube.meta.dims.map((d) => d.col),
    ...L.cube.meta.dims.flatMap((d) => d.values || []),
    ...L.cube.meta.measures.map((m) => m.col),
  ];
  const ctx = await indexContext(
    `- ${y}-${mo}-08: Partner API outage across the West region, nine days.`,
    { fileName: "incidents.md", subjects });

  const card = await runAgent(L.cube, { title: "Scan for anything unusual", agent: "scan",
    measure: "revenue", grain: "month" }, null, NOPACE);
  const hits = retrieveContext(ctx, { period: card.period, grain: card.grain,
    subjects: ["revenue", "region", "West", "Partner"], queryText: "scan for anything unusual" });
  card.contextHits = hits;
  card.narration = await narrate({ card, skill, contextHits: hits, llm: null });

  // Every field the footer promises must actually be available.
  ok("footer field — Source: agent is present", !!card.agent, card.agent);
  ok("footer field — Test: evidence carries test and p", !!card.evidence?.test && card.evidence.p != null,
    `${card.evidence?.test} p=${card.evidence?.p}`);
  ok("footer field — Data hash", /^[0-9a-f]{16,}/.test(fp.contentHash.hex), "");
  ok("footer field — Skill hash", /^[0-9a-f]{16,}/.test(skill.skillHash), "");
  ok("footer field — Freshness is the newest date IN THE DATA",
    skill.grain.latest === periods[periods.length - 1], `${skill.grain.latest}`);
  ok("footer field — Context entries consulted", card.narration.contextUsed.length > 0,
    JSON.stringify(card.narration.contextUsed));

  const journal = createJournal();
  const rec = await appendToJournal(journal, {
    dataset: fp, question: "Scan for anything unusual", intent: { agent: "scan" },
    grain: card.grain, period: card.period, agent: "scan",
    finding: card.evidence, audit: card.audit,
    result: { summary: card.narration.text },
    skillHash: skill.skillHash,
    context: { source: ctx.fileName, docHash: ctx.docHash, entriesConsulted: card.narration.contextUsed },
    narration: card.narration,
  });

  ok("record pins the schema interpretation via the skill hash",
    rec.skillHash === skill.skillHash, "");
  ok("record names the context source and entries consulted",
    rec.context?.source === "incidents.md" && rec.context.entriesConsulted.length > 0, "");
  ok("record states plainly that context touched no number",
    rec.context?.influencedNumbers === false, "");
  ok("record captures the narration path and guard result",
    rec.narration?.source === "deterministic" && rec.narration.numbersRejected === 0,
    JSON.stringify(rec.narration));
  ok("the chain still verifies with the new fields", (await verifyJournal(journal)).ok, "");

  const md = journalToMarkdown(journal);
  ok("markdown export includes the context provenance line",
    /Context consulted:/.test(md) && /did not contribute to any number/.test(md), "");
  ok("markdown export includes the skill hash line", /skill hash/i.test(md), "");

  // Identity must change when the schema interpretation changes.
  const j2 = createJournal();
  const rec2 = await appendToJournal(j2, {
    dataset: fp, question: "Scan for anything unusual", intent: { agent: "scan" },
    grain: card.grain, period: card.period, agent: "scan",
    finding: card.evidence, audit: card.audit, result: { summary: "x" },
    skillHash: "different-schema-interpretation", context: null, narration: null,
  });
  ok("a different schema interpretation gives a different record identity",
    rec2.identity !== rec.identity, "");
}

/* ═══ SUMMARY ════════════════════════════════════════════════════════════ */
console.log(`\n${"─".repeat(70)}`);
console.log(`\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
