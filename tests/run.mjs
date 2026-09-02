/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — TEST SUITE
   Each block asserts one claim made in the v8 rewrite. Where a test verifies
   a specific v7 bug, the bug is named.
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  parseCSV, profile, buildCube, loadDataset, extent, moments,
  grubbsTest, benjaminiHochberg, pearson, holtFit, backtest,
  discoverInsights, explainChange, queryBreakdown, queryTotal, queryTrend,
  mixRateDecomposition, contributionDecomposition, studentTCdf, studentTQuantile,
  latestPeriod, allPeriods,
} from "../src/engine/index.js";
import { runAgent } from "../src/agents.js";
import { parseIntent } from "../src/nlu.js";
import {
  fingerprintDataset, createJournal, appendToJournal, verifyJournal,
  verifyRecord, journalToMarkdown, hash,
} from "../src/provenance.js";
import * as gen from "./generate.mjs";

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  ✗ ${name}  ${detail}`); }
}
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const NOPACE = { paced: false };

/* ═══ 1. THE CRASH ═══════════════════════════════════════════════════════ */
section("1. Profiler survives large columns (v7 BUG: Math.min spread → RangeError)");
{
  const big = new Array(300000);
  for (let i = 0; i < big.length; i++) big[i] = i % 977;
  let threw = null;
  try { Math.min(...big); } catch (e) { threw = e.constructor.name; }
  ok("the v7 pattern still throws, confirming the bug was real", threw === "RangeError", `got ${threw}`);

  const e = extent(big);
  ok("extent() handles 300k values", e.min === 0 && e.max === 976, JSON.stringify(e));

  const { csv, truth } = gen.scaleAndPathology({ rows: 200000 });
  const t0 = Date.now();
  const parsed = parseCSV(csv);
  const prof = profile(parsed);
  const ms = Date.now() - t0;
  ok("200k-row file profiles without throwing", parsed.rowCount === 200000, `rows=${parsed.rowCount}`);
  console.log(`      parse + profile: ${ms} ms`);

  /* v7 BUG: first date column wins. signup_date is column 0 and covers 40%
     of rows; order_date is column 2 and covers all of them. */
  ok("picks order_date over the decoy signup_date",
    prof.timeCol === truth.expectTimeCol, `chose ${prof.timeCol}`);
  ok("reports the rejected date column as an alternative",
    prof.timeAlternatives.some((a) => a.col === truth.decoyTimeCol),
    JSON.stringify(prof.timeAlternatives));

  /* v7 BUG: isRateMeasure was a name regex. */
  const marginM = prof.measures.find((m) => m.col === "margin_pct");
  ok("margin_pct is classified as an average, not a sum", marginM?.agg === "avg", marginM?.agg);
  const revM = prof.measures.find((m) => m.col === "revenue");
  ok("revenue is classified as a sum", revM?.agg === "sum", revM?.agg);
  ok("order_id is recognised as an identifier, not a measure",
    prof.schema.order_id.type === "identifier", prof.schema.order_id.type);
}

/* ═══ 2. DATE MEMOISATION ════════════════════════════════════════════════ */
section("2. Date parsing is memoised (v7 BUG: 5 × new Date() per row)");
{
  const { csv } = gen.scaleAndPathology({ rows: 120000 });
  const parsed = parseCSV(csv);
  const prof = profile(parsed);
  const t0 = Date.now();
  const cube = await buildCube(prof, { chunkSize: 1e9 });
  const ms = Date.now() - t0;
  const s = cube.meta.dateCacheStats;
  console.log(`      build: ${ms} ms · distinct dates ${s.distinctDates} · cache hits ${s.hits.toLocaleString()}`);
  ok("distinct dates are a tiny fraction of row count",
    s.distinctDates < parsed.rowCount / 50, `${s.distinctDates} vs ${parsed.rowCount}`);
  ok("cache hit rate above 99%", s.hits / (s.hits + s.misses) > 0.99,
    `${((s.hits / (s.hits + s.misses)) * 100).toFixed(2)}%`);
  const v7Parses = parsed.rowCount * 5;
  console.log(`      v7 would have constructed ~${v7Parses.toLocaleString()} Date objects; v8 parses ${s.misses.toLocaleString()} strings`);
}

/* ═══ 3. THE SMALL-DIMENSION DEAD ZONE ═══════════════════════════════════ */
section("3. Grubbs replaces the z>=1.5 cutoff (v7 BUG: 3-member dims invisible)");
{
  // The arithmetic ceiling, stated explicitly.
  for (const n of [3, 4, 5, 6, 8]) {
    const vals = new Array(n).fill(0); vals[0] = 1;
    const m = vals.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
    const maxZ = (1 - m) / sd;
    if (n === 3) ok(`max attainable |z| at n=3 is ${maxZ.toFixed(3)} — below the old 1.5 cutoff`, maxZ < 1.5, `${maxZ}`);
    if (n === 4) ok(`max attainable |z| at n=4 is exactly ${maxZ.toFixed(3)}`, near(maxZ, 1.5, 1e-9), `${maxZ}`);
  }

  const g3 = grubbsTest([100, 100, 400], { minN: 3 });
  ok("Grubbs on a 3-member dimension is testable and significant",
    g3.testable && g3.p < 0.10, JSON.stringify({ testable: g3.testable, p: g3.p }));

  const gSmall = grubbsTest([100, 105]);
  ok("Grubbs on 2 members says why it cannot test, rather than returning nothing",
    !gSmall.testable && /needs/.test(gSmall.reason), gSmall.reason);

  // End to end on the real dataset.
  const { csv, truth } = gen.smallDimensionEffect();
  const { cube } = await loadDataset(csv, { fileName: "small-dim.csv" });
  const res = discoverInsights(cube);
  const found = res.insights.find((i) => i.dim === "segment" && i.value === "Enterprise");
  ok("finds the 3.2x effect in the 3-member `segment` dimension", !!found,
    `dims found: ${[...new Set(res.insights.map((i) => i.dim || i.dimA))].join(",")}`);
  if (found) console.log(`      ${found.why}`);
  ok("the finding carries a p-value", found && found.p != null, `p=${found?.p}`);
  ok("the finding carries a q-value after correction", found && found.q != null, `q=${found?.q}`);
}

/* ═══ 4. FDR CORRECTION AND THE NULL DATASET ═════════════════════════════ */
section("4. Multiplicity control (v7 had none — top-6-by-score on noise)");
{
  // BH sanity
  const ps = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.5];
  const qs = benjaminiHochberg(ps);
  ok("BH q-values are monotone non-decreasing with p",
    qs.every((q, i) => i === 0 || q >= qs[i - 1] - 1e-12), JSON.stringify(qs.map((q) => +q.toFixed(4))));
  ok("BH q >= p for every test", ps.every((p, i) => qs[i] >= p - 1e-12), "");

  const { csv } = gen.nullDataset();
  const { cube } = await loadDataset(csv, { fileName: "null.csv" });
  const res = discoverInsights(cube);
  console.log(`      ${res.audit.verdict}`);
  ok("still says how many tests were run", res.audit.testsRun > 20, `${res.audit.testsRun}`);

  /* CALIBRATION, not a single-seed zero.
   *
   * This assertion used to be "exactly zero findings on the null dataset",
   * which is a deterministic claim about a probabilistic guarantee. BH at
   * q <= 0.10 on data with no signal controls the family-wise error rate at
   * 0.10 -- so roughly one null dataset in ten SHOULD produce a finding. The
   * old assertion passed only because the cross-cell test it ran against was
   * underspecified and underpowered; replacing it with a correct Welch test
   * raised power, and a seed promptly landed in that 1-in-10.
   *
   * Tuning the engine to make one seed return zero would have been hiding a
   * correct result. The right test measures the RATE across many seeds and
   * checks it against the level we claim. */
  let withAny = 0, totalFindings = 0, highTier = 0;
  const NULL_SEEDS = 20;
  for (let seed = 1; seed <= NULL_SEEDS; seed++) {
    const n = gen.nullDataset({ months: 20, perMonth: 350, seed });
    const L = await loadDataset(n.csv, { fileName: "n.csv" });
    const r = discoverInsights(L.cube);
    if (r.insights.length) withAny++;
    totalFindings += r.insights.length;
    highTier += r.feed.filter((f) => f.tier === "high").length;
  }
  const rate = withAny / NULL_SEEDS;
  console.log(`      ${withAny}/${NULL_SEEDS} null datasets produced a finding (${(rate * 100).toFixed(0)}%) against a nominal 10%`);
  ok("false-positive rate on null data is consistent with the q <= 0.10 level",
    rate <= 0.30, `${(rate * 100).toFixed(0)}% over ${NULL_SEEDS} seeds`);
  ok("mean findings per null dataset is below 1", totalFindings / NULL_SEEDS < 1,
    `${(totalFindings / NULL_SEEDS).toFixed(2)}`);
  ok("NOTHING from null data ever reaches the HIGH priority tier",
    highTier === 0, `${highTier} high-tier findings on pure noise`);

  // What v7's scoring would have done on the same data.
  let v7Would = 0;
  const grain = res.grain, period = res.period;
  const v8Reported = res.insights.length;
  for (const m of cube.meta.measures) {
    for (const d of cube.meta.dims) {
      const bd = queryBreakdown(cube, d.col, m.col, grain, period);
      if (bd.length < 3) continue;
      const vals = bd.map((b) => b.value);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      for (const c of bd) {
        const sibZ = sd ? (c.value - mean) / sd : 0;
        const tr = queryTrend(cube, m.col, grain, 12, d.col, c.label).map((t) => t.value);
        const hist = tr.slice(0, -1);
        const hm = hist.reduce((a, b) => a + b, 0) / hist.length;
        const hsd = Math.sqrt(hist.reduce((a, b) => a + (b - hm) ** 2, 0) / hist.length);
        const tz = hsd ? (tr[tr.length - 1] - hm) / hsd : 0;
        const drop = tr[tr.length - 2] ? (tr[tr.length - 1] - tr[tr.length - 2]) / tr[tr.length - 2] : 0;
        if (Math.abs(sibZ) + 0.8 * Math.abs(tz) + 3 * Math.abs(drop) >= 1.0) v7Would++;
      }
    }
  }
  console.log(`      v7's scoring would have surfaced ${v7Would} "insights" from this pure-noise file`);
  ok("v8 reports far fewer findings on noise than v7 would have", v8Reported * 4 < v7Would,
    `v8=${v8Reported} v7=${v7Would}`);
}

/* ═══ 5. SUPPORT GUARDS ══════════════════════════════════════════════════ */
section("5. Support floor (v7 BUG: |drop|×3.0 weight, no row-count guard)");
{
  const { csv, truth } = gen.smallSampleTrap();
  const { cube } = await loadDataset(csv, { fileName: "trap.csv" });
  const res = discoverInsights(cube);
  const trapReported = res.insights.some((i) => i.value === truth.trap || i.a === truth.trap || i.b === truth.trap);
  ok(`the 2-row-per-month "${truth.trap}" swing is NOT reported as a finding`, !trapReported,
    res.insights.filter((i) => i.value === truth.trap).map((i) => i.why).join(" | "));

  const bd = queryBreakdown(cube, "region", "revenue", "month", latestPeriod(cube, "month"));
  const antarctica = bd.find((b) => b.label === truth.trap);
  ok("but the thin cell is still visible in the raw breakdown with its row count",
    antarctica && antarctica.n <= 4, JSON.stringify(antarctica));
  console.log(`      ${truth.trap}: ${antarctica?.n} rows — present in the data, excluded from claims`);
}

/* ═══ 6. THE REAL EFFECT IS STILL FOUND ══════════════════════════════════ */
section("6. Genuine effects still surface");
{
  const { csv, truth } = gen.temporalBreak();
  const { cube } = await loadDataset(csv, { fileName: "break.csv" });
  const res = discoverInsights(cube);
  ok("finds at least one significant finding", res.insights.length > 0, res.audit.verdict);
  const west = res.insights.find((i) => i.value === truth.value || i.a === truth.value);
  ok(`localises the drop to ${truth.dim} = ${truth.value}`, !!west,
    res.insights.slice(0, 3).map((i) => `${i.dim || i.dimA}=${i.value || i.a}`).join(", "));
  if (west) console.log(`      ${west.why}`);

  const drill = await runAgent(cube, { ...parseIntent("why did revenue drop", { dims: cube.meta.dims, measures: cube.meta.measures }), agent: "drill" }, null, NOPACE);
  ok("the drill agent attributes the change to the right dimension",
    drill.decomposition?.dim === truth.dim, drill.decomposition?.dim);
  ok("the drill agent narrows to the right cross cell",
    drill.crossLocalization?.lead?.key === truth.crossValue,
    `${drill.crossLocalization?.dimB}=${drill.crossLocalization?.lead?.key}`);
  console.log(`      ${drill.summary.slice(0, 200)}…`);
}

/* ═══ 7. SIMPSON'S PARADOX ═══════════════════════════════════════════════ */
section("7. Mix vs rate decomposition catches Simpson's paradox");
{
  const { csv } = gen.simpsonsParadox();
  const { cube, profile: prof } = await loadDataset(csv, { fileName: "simpson.csv" });
  const m = prof.measures.find((x) => x.col === "margin_rate");
  ok("margin_rate is aggregated as an average", m.agg === "avg", m.agg);

  const periods = allPeriods(cube, "month");
  const dec = explainChange(cube, "margin_rate", "segment", "month", periods[periods.length - 1], periods[periods.length - 2]);
  const mr = dec.mixRate;
  ok("mix/rate decomposition is produced for the averaged measure", !!mr, "");
  ok("the blended rate fell", mr.change < 0, `change=${mr.change.toFixed(4)}`);
  ok("but the rate effect is positive — segments improved", mr.rateEffect > 0, `rate=${mr.rateEffect.toFixed(4)}`);
  ok("mix effect dominates and is negative", mr.mixEffect < 0 && Math.abs(mr.mixEffect) > Math.abs(mr.rateEffect),
    `mix=${mr.mixEffect.toFixed(4)}`);
  ok("decomposition is exact: rate + mix + interaction = total change",
    near(mr.rateEffect + mr.mixEffect + mr.interaction, mr.change, 1e-9),
    `${(mr.rateEffect + mr.mixEffect + mr.interaction).toFixed(9)} vs ${mr.change.toFixed(9)}`);
  console.log(`      blended ${mr.blended0.toFixed(4)} → ${mr.blended1.toFixed(4)} (${mr.change.toFixed(4)})`);
  console.log(`      rate ${mr.rateEffect.toFixed(4)} · mix ${mr.mixEffect.toFixed(4)} · interaction ${mr.interaction.toFixed(4)}`);

  const card = await runAgent(cube, { title: "explain", agent: "explain", measure: "margin_rate", dimension: "segment", grain: "month" }, null, NOPACE);
  ok("the explain agent names the paradox", card.simpson === true, `simpson=${card.simpson}`);
  console.log(`      ${card.summary.slice(0, 260)}…`);
}

/* ═══ 8. ADDITIVE DECOMPOSITION IS EXACT ═════════════════════════════════ */
section("8. Contribution decomposition is exact arithmetic");
{
  const cells = [
    { key: "A", before: 100, after: 80 }, { key: "B", before: 50, after: 95 },
    { key: "C", before: 30, after: 30 },  { key: "D", before: 12, after: 3 },
  ];
  const d = contributionDecomposition(cells);
  ok("contributions sum to the total change",
    near(d.rows.reduce((a, r) => a + r.delta, 0), d.total, 1e-12), `${d.total}`);
  ok("shares sum to 1", near(d.rows.reduce((a, r) => a + r.share, 0), 1, 1e-12), "");
  ok("rows are ranked by absolute contribution",
    Math.abs(d.rows[0].delta) >= Math.abs(d.rows[1].delta), "");
}

/* ═══ 9. FORECAST HONESTY ════════════════════════════════════════════════ */
section("9. Forecast reports measured accuracy, not confidence");
{
  const t = gen.trendySeries();
  const { cube: tc } = await loadDataset(t.csv, { fileName: "trend.csv" });
  const tSeries = queryTrend(tc, "revenue", "month", null).map((x) => x.value);
  const tBt = backtest(tSeries, { minTrain: 12 });
  ok("Holt beats naive on a strongly trending series", tBt && tBt.mase < 1, `MASE=${tBt?.mase.toFixed(3)}`);

  const w = gen.randomWalkSeries();
  const { cube: wc } = await loadDataset(w.csv, { fileName: "walk.csv" });
  const wSeries = queryTrend(wc, "revenue", "month", null).map((x) => x.value);
  const wBt = backtest(wSeries, { minTrain: 12 });
  ok("Holt does NOT beat naive on a random walk, and the number says so",
    wBt && wBt.mase >= 0.85, `MASE=${wBt?.mase.toFixed(3)}`);

  const card = await runAgent(wc, { title: "forecast", agent: "forecast", measure: "revenue", grain: "month", horizon: 3 }, null, NOPACE);
  ok("the forecast card reports MASE to the reader", /MASE/.test(card.summary), card.summary.slice(0, 120));
  ok("the forecast card includes prediction intervals", card.forecast?.[0]?.lo != null, "");
  console.log(`      ${card.summary.slice(0, 240)}…`);

  // Short history must refuse.
  const short = gen.trendySeries({ months: 6 });
  const { cube: sc } = await loadDataset(short.csv, { fileName: "short.csv" });
  const sCard = await runAgent(sc, { title: "f", agent: "forecast", measure: "revenue", grain: "month" }, null, NOPACE);
  ok("refuses to forecast on 6 periods and explains why",
    sCard.forecast == null && /not enough|floor/i.test(sCard.summary), sCard.summary.slice(0, 120));
}

/* ═══ 10. STATISTICAL PRIMITIVES ═════════════════════════════════════════ */
section("10. Statistical primitives match known values");
{
  // Student-t CDF against published values
  ok("t CDF: P(T<=2.228 | df=10) ≈ 0.975", near(studentTCdf(2.228, 10), 0.975, 5e-4), studentTCdf(2.228, 10).toFixed(6));
  ok("t CDF: P(T<=1.812 | df=10) ≈ 0.95", near(studentTCdf(1.812, 10), 0.95, 5e-4), studentTCdf(1.812, 10).toFixed(6));
  ok("t quantile inverts the CDF", near(studentTQuantile(0.975, 10), 2.228, 2e-3), studentTQuantile(0.975, 10).toFixed(4));

  // Pearson against a hand-computed case
  const xs = [1, 2, 3, 4, 5], ys = [2, 4, 5, 4, 5];
  const p = pearson(xs, ys);
  ok("Pearson r matches the known value 0.7746", near(p.r, 0.7745966692, 1e-8), p.r.toFixed(10));
  ok("Pearson returns a confidence interval", Array.isArray(p.ci), JSON.stringify(p.ci));

  // Welford variance vs naive
  const vals = [2, 4, 4, 4, 5, 5, 7, 9];
  ok("sample variance is correct", near(moments(vals, 1).variance, 32 / 7, 1e-12), moments(vals, 1).variance.toFixed(9));
  ok("population variance is correct", near(moments(vals, 0).variance, 4, 1e-12), moments(vals, 0).variance.toFixed(9));
}

/* ═══ 11. DETERMINISM ════════════════════════════════════════════════════ */
section("11. Determinism — same input, same output, byte for byte");
{
  const { csv } = gen.temporalBreak({ months: 12, perMonth: 400 });
  const a = await loadDataset(csv, { fileName: "d.csv" });
  const b = await loadDataset(csv, { fileName: "d.csv" });
  const ra = discoverInsights(a.cube);
  const rb = discoverInsights(b.cube);
  ok("two independent loads produce identical findings",
    JSON.stringify(ra.insights.map((i) => [i.dim, i.value, i.p, i.q])) ===
    JSON.stringify(rb.insights.map((i) => [i.dim, i.value, i.p, i.q])), "");

  const c1 = await runAgent(a.cube, { title: "t", agent: "scan", measure: "revenue", grain: "month" }, null, NOPACE);
  const c2 = await runAgent(b.cube, { title: "t", agent: "scan", measure: "revenue", grain: "month" }, null, NOPACE);
  ok("the scan agent is reproducible", c1.summary === c2.summary, "");
}

/* ═══ 12. PROVENANCE ═════════════════════════════════════════════════════ */
section("12. Provenance — hashing, records, tamper evidence");
{
  const { csv } = gen.smallDimensionEffect({ months: 12, perMonth: 300 });
  const loaded = await loadDataset(csv, { fileName: "prov.csv" });
  const fp = await fingerprintDataset(csv, loaded.parsed, loaded.profile, "prov.csv");
  console.log(`      content hash (${fp.contentHash.algo}): ${fp.contentHash.hex.slice(0, 32)}…`);
  ok("dataset hash is cryptographic where SubtleCrypto exists",
    fp.contentHash.algo === "sha-256" || fp.contentHash.algo === "fnv-1a-128", fp.contentHash.algo);

  const fp2 = await fingerprintDataset(csv, loaded.parsed, loaded.profile, "prov.csv");
  ok("the same file hashes identically", fp.contentHash.hex === fp2.contentHash.hex, "");
  const altered = csv.replace(/\n(\S+?),/, "\nCHANGED,");
  const fp3 = await fingerprintDataset(altered, loaded.parsed, loaded.profile, "prov.csv");
  ok("a one-character edit changes the hash", fp.contentHash.hex !== fp3.contentHash.hex, "");

  const res = discoverInsights(loaded.cube);
  const journal = createJournal();
  let clockT = 1700000000000;
  const clock = () => (clockT += 1000);

  const r1 = await appendToJournal(journal, {
    dataset: fp, question: "scan for anything unusual",
    intent: { agent: "scan" }, grain: res.grain, period: res.period,
    agent: "scan", finding: res.insights[0], audit: res.audit,
    result: { summary: res.insights[0]?.why || res.audit.verdict }, clock,
  });
  const r2 = await appendToJournal(journal, {
    dataset: fp, question: "deep dive revenue by segment",
    intent: { agent: "deepdive" }, grain: res.grain, period: res.period,
    agent: "deepdive", finding: res.insights[0], audit: res.audit,
    result: { summary: "…" }, clock,
  });

  ok("record IDs are derived from content, not random", /^[0-9a-f]{32,}$/.test(r1.identity), r1.identity.slice(0, 16));
  ok("the record carries the test, statistic, p and q",
    r1.evidence?.test && r1.evidence.p != null && r1.evidence.q != null,
    JSON.stringify(r1.evidence && { test: r1.evidence.test, p: r1.evidence.p, q: r1.evidence.q }));
  ok("the record carries the multiplicity context",
    r1.multiplicity?.correction === "benjamini-hochberg" && r1.multiplicity.testsRun > 0, "");
  ok("the second record chains to the first", r2.chainPrev === r1.recordHash, "");

  const v = await verifyJournal(journal);
  ok("a clean journal verifies", v.ok, JSON.stringify(v.problems));

  // Tamper: change a reported number.
  journal.entries[0].result.summary = "Revenue grew 400% in every region";
  const v2 = await verifyJournal(journal);
  ok("editing a record is detected", !v2.ok && v2.problems.some((p) => p.issue === "content-hash-mismatch"),
    JSON.stringify(v2.problems));

  // Tamper: remove a record from the middle.
  const j2 = createJournal();
  clockT = 1700000000000;
  await appendToJournal(j2, { dataset: fp, question: "q1", grain: res.grain, period: res.period, finding: null, audit: res.audit, result: {}, clock });
  await appendToJournal(j2, { dataset: fp, question: "q2", grain: res.grain, period: res.period, finding: null, audit: res.audit, result: {}, clock });
  await appendToJournal(j2, { dataset: fp, question: "q3", grain: res.grain, period: res.period, finding: null, audit: res.audit, result: {}, clock });
  j2.entries.splice(1, 1);
  const v3 = await verifyJournal(j2);
  ok("removing a record from the middle breaks the chain",
    !v3.ok && v3.problems.some((p) => p.issue === "broken-chain"), JSON.stringify(v3.problems));

  // Reproducibility: same question, same data, same identity.
  const j3 = createJournal();
  clockT = 1800000000000;
  const r3 = await appendToJournal(j3, {
    dataset: fp, question: "scan for anything unusual", intent: { agent: "scan" },
    grain: res.grain, period: res.period, agent: "scan",
    finding: res.insights[0], audit: res.audit, result: { summary: res.insights[0]?.why }, clock,
  });
  ok("same question + same file + same engine = same identity hash, even at a different time",
    r3.identity === r1.identity, `${r3.identity.slice(0, 12)} vs ${r1.identity.slice(0, 12)}`);

  const md = journalToMarkdown(j3);
  ok("markdown audit trail includes the hash and the test", /Record `/.test(md) && /Test:/.test(md), "");
}

/* ═══ 13. NLU ════════════════════════════════════════════════════════════ */
section("13. Intent parsing");
{
  const { csv } = gen.temporalBreak({ months: 12, perMonth: 300 });
  const { profile: prof } = await loadDataset(csv, { fileName: "n.csv" });
  const cases = [
    ["why did revenue drop last quarter", "drill", "quarter"],
    ["scan for anything unusual", "scan", "month"],
    ["forecast revenue next 6 periods", "forecast", "month"],
    ["explain the change in revenue", "explain", "month"],
    ["what correlates with revenue", "correlate", "month"],
    ["deep dive revenue by region", "deepdive", "month"],
  ];
  for (const [q, agent, grain] of cases) {
    const it = parseIntent(q, prof);
    ok(`"${q}" → ${agent}`, it.agent === agent, `got ${it.agent}`);
    if (grain !== "month") ok(`  grain → ${grain}`, it.grain === grain, `got ${it.grain}`);
  }
  const amb = parseIntent("show me the numbers", prof);
  ok("ambiguous queries record what was assumed rather than hiding it",
    Array.isArray(amb.unresolved), JSON.stringify(amb.unresolved));
  const withVal = parseIntent("why did revenue drop in West", prof);
  ok("picks up a dimension value named in the query", withVal.dimensionValue === "West", withVal.dimensionValue);
}

/* ═══ 14. CSV EDGE CASES ═════════════════════════════════════════════════ */
section("14. CSV parser edge cases");
{
  const tricky = `id,name,date,amt\r\n1,"Smith, John",2024-01-15,100\r\n2,"He said ""hi""",2024-02-20,200\r\n\r\n3,Plain,2024-03-01,300\r\n4,Short,2024-04-01\r\n`;
  const p = parseCSV(tricky);
  ok("handles CRLF, quoted commas, escaped quotes and blank lines", p.rowCount === 4, `rows=${p.rowCount}`);
  ok("quoted comma preserved", p.columns[1][0] === "Smith, John", p.columns[1][0]);
  ok("escaped quote unescaped", p.columns[1][1] === 'He said "hi"', p.columns[1][1]);
  ok("ragged row padded, not dropped", p.columns[3][3] === "", `"${p.columns[3][3]}"`);
  ok("all columns the same length", p.columns.every((c) => c.length === 4), p.columns.map((c) => c.length).join(","));

  const semi = parseCSV("a;b;c\n1;2;3\n4;5;6");
  ok("sniffs a semicolon delimiter", semi.delimiter === ";" && semi.rowCount === 2, semi.delimiter);

  const dupes = parseCSV("a,a,,b\n1,2,3,4");
  ok("de-duplicates repeated and blank header names",
    new Set(dupes.headers).size === 4, dupes.headers.join(","));
}

/* ═══ 15. ERROR MESSAGES ═════════════════════════════════════════════════ */
section("15. Failures explain themselves");
{
  let msg = "";
  try { await loadDataset("a,b\n1,2\n3,4"); } catch (e) { msg = e.message; }
  ok("a file with no date column says what a date should look like",
    /date/i.test(msg) && /2024-01-31/.test(msg), msg);

  msg = "";
  try { await loadDataset("d,x\n2024-01-01,foo\n2024-02-01,bar"); } catch (e) { msg = e.message; }
  ok("a file with no numeric measure says so", /numeric measure/i.test(msg), msg);

  msg = "";
  try { await loadDataset("a,b,c"); } catch (e) { msg = e.message; }
  ok("a header with no rows says so", /no data rows/i.test(msg), msg);
}

/* ═══ SUMMARY ════════════════════════════════════════════════════════════ */
console.log(`\n${"─".repeat(70)}`);
console.log(`\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
