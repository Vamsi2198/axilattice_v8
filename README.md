# Axilattice v8

In-browser analytics that reports the statistical test behind every claim. Drop
a CSV, ask a question in words, get an answer that carries its own evidence —
the test used, the statistic, the p-value, the q-value after multiple-comparison
correction, and how many rows it rests on. The file never leaves the tab.

```bash
npm install
npm start          # dev server
npm run build      # static bundle in ./build
npm run test:engine   # 83 assertions against synthetic data with known ground truth
```

---

## What changed from v7, and why

The audit of v7 turned up four defects. All four are fixed and each has a
regression test that fails against the old behaviour.

### 1. The profiler crashed above ~125,000 rows

`profile()` used `Math.min(...nums)` and `Math.max(...nums)`. Spreading an array
into a function call pushes every element onto the argument stack, and V8 gives
up somewhere past 125k. Verified: 120,000 arguments works, 200,000 throws
`RangeError: Maximum call stack size exceeded`.

The README said large files "may be slow above 200k rows". They did not get
slow. They died during profiling, before the cube was ever built.

Fixed with `extent()`, a single loop. Tested on a 300k-element array and a
200k-row file.

### 2. Small dimensions were mathematically invisible

`findOutliers` flagged a member when `|z| >= 1.5`, using the sample standard
deviation. The largest z-score attainable with sample sd is `(n-1)/√n`:

| members | max attainable \|z\| |
|---------|---------------------|
| 3       | 1.155               |
| 4       | 1.500               |
| 5       | 1.789               |
| 6       | 2.041               |

At three members the threshold is unreachable no matter how lopsided the split.
At four it is reachable only in the fully degenerate case. `segment`, `channel`,
`tier` and every boolean dimension were structurally excluded from the results,
silently. A separate `bd.length < 3` early return killed the rest.

Fixed in two layers:

- **Grubbs' test** replaces the fixed cutoff. It converts the same statistic
  into a p-value that prices in `n`, and when a dimension is too small to test
  it says so rather than returning an empty result.
- **An exact binomial persistence test** does the real work on small dimensions.
  Grubbs on three members tops out around p ≈ 0.07 even for a 3× effect — three
  numbers are only worth so much. But three members watched over eighteen
  periods is not three numbers. If one member is the largest in all eighteen,
  the probability under exchangeability is (1/3)^18. The evidence lives in the
  repetition, and the binomial test reads it directly.

In the test suite the planted 3.2× effect on a three-member dimension is found
at p ≈ 7e-9, where the single-period test could only manage borderline.

### 3. The discovery feed was mostly noise

v7 scored cells as `|sibZ| + 0.8·|tempZ| + 3.0·|drop|` and reported anything
above 1.0. The 3.0 weight meant a 33% period-over-period move cleared the bar
unaided, and the single-dimension path had no support guard at all, so a cell
holding four rows outranked one holding forty thousand.

Fixed with a support floor (≥ 30 rows and ≥ 0.5% share before a cell is even
tested) and **Benjamini-Hochberg false discovery rate control** across the whole
traversal.

This is the change that matters most. A full traversal runs thousands of tests;
at α = 0.05 a thousand tests on pure noise produce roughly fifty findings.
Ranking by raw score and showing the top six is how a tool manufactures insight
out of randomness.

On the bundled `flat-no-signal.csv`, which has no planted effect anywhere, v8
reports:

> 69 cells tested, none survive multiplicity correction at q ≤ 0.1. This data
> looks flat.

v7's scoring on the same file surfaces 20 "insights."

### 4. Date parsing was the hot loop

`periodKey` constructed a `Date` five times per row, once per grain — about a
million `Date` constructions on a 200k-row file, and by a wide margin the most
expensive thing in the build.

Fixed by parsing to integer tuples with no `Date` object and memoising on the
raw string. A file with two years of daily orders now parses 672 distinct date
strings instead of 600,000. Build time for 120k rows: 298 ms.

### Also fixed

- **The time axis was first-wins.** A file with `signup_date` before
  `order_date` silently built the entire cube on the wrong axis, and nothing in
  the UI said so. Every date column is now scored on row coverage and period
  span, the winner is explained, and the losers are listed with the reason they
  lost. Switchable in the schema panel.
- **Rate detection was a name regex.** `/time/` matched `timestamp_ms`. Each
  measure now gets a SUM or AVG classification from both its name and its
  distribution, the reasoning is shown, and it can be overridden.
- **Identity was `Math.random()`.** Card and record IDs are now derived from
  content, so the same question against the same file produces the same
  identity hash.

---

## Two errors I made building this, and how they were caught

Both were found by the null-dataset test — the one that asserts zero findings on
data with no planted effect. Worth writing down, because they are the same class
of error the engine exists to catch.

**First pass.** Cross-cell independence used the Pearson residual
`(O − E)/√E`. That assumes `Var(O) = E`, which is only true for a Poisson count.
Applied to revenue it fired on 23 cells of pure noise. The `isCountLike` guard
was supposed to prevent this, but it tested for non-negative integers — and
revenue rounded to whole dollars is a non-negative integer. Integrality is not
countiness.

**Second pass.** Replaced it with a quasi-Poisson residual `(O − E)/√(φE)` where
φ = σ²/μ. Residuals dropped from 23 to 4.3 — better, still wrong. φ = σ²/μ
corrects for variation in the amounts but not for variation in how many rows
land in each cell, and both vary. The correct model for a compound sum is:

```
Var(S) = E[n]·σ² + Var(n)·μ²  =  (E[X²]/E[X]) · E[S]
```

So the scale factor is the second moment over the first, not the variance over
the mean. Monte Carlo confirms it: simulated Var 2.097e7 against a model
prediction of 2.114e7, while the σ²/μ version understated by 4.27× — exactly the
residual size that was showing up.

**Third pass** uses `φ = (σ² + μ²)/μ`, computed once in the profiler. Null
dataset: zero findings.

A related fix in the same pass: the Grubbs floor was lowered to n = 3 and then
put back to n = 6, because at n = 3 the statistic explodes whenever two of the
three members happen to sit close together, producing a confident-looking
p-value on noise. The parametric test now runs only where it has power; small
dimensions are covered by the binomial persistence test, which has more power
there, not less.

---

## The six agents

Every agent is arithmetic over the cube. None of them calls a model, so the
sentence you read and the statistic in the audit record are generated from the
same numbers and cannot disagree.

| Agent | Question | Method |
|---|---|---|
| **Scan** | What is actually unusual? | Full traversal, Grubbs + studentized deviation + binomial persistence, BH-corrected |
| **Deep dive** | How does one dimension break down? | Per-member Grubbs, MAD-robust z, Cohen's d |
| **Drill** | Where did a move come from? | Contribution decomposition, then 2-way localization |
| **Correlate** | What moves together? | Pearson and Spearman with p-values and Fisher-z intervals |
| **Forecast** | What next, and can we trust it? | Holt linear trend, walk-forward backtest reported as MASE |
| **Explain** | Is a change real or compositional? | Additive contribution + mix vs rate decomposition |

Two deliberate naming decisions:

The sixth agent is **Explain**, not "Causal". What it does is decompose a change
into contributions and split a blended average into rate movement versus mix
shift. That is exact and useful. Causal identification needs a design — a
treatment, a control, an assumption about confounding — none of which a lone CSV
supplies. Calling decomposition "causal inference" is the most common way
analytics tools mislead people.

**Forecast reports MASE against a naive benchmark and says plainly when it
loses.** On a random walk the card reads: "It does not beat assuming no change.
Use the last actual value instead of this forecast." A forecast without a
measured error is a drawn line.

The **Explain** agent detects Simpson's paradox. On the bundled sample, blended
margin falls from 0.3112 to 0.1855 while every segment's margin rises — rate
effect +0.0383, mix effect −0.1647. The card says so.

---

## Provenance

Every answer writes a decision record: the dataset content hash, the engine
version stamp, the question, the resolved intent, the test and its statistic,
the p and q values, the sample size, the multiplicity context, and a hash of
the record chained to the previous one.

What this gives you:

- **Reproducibility you can check.** The record ID is derived from the content
  hash plus the question plus the engine version. Same file, same question, same
  ID — including at a different time, on a different machine.
- **Tamper evidence.** Editing a record breaks its own hash. Removing a record
  from the middle of the journal breaks the chain, because each link commits to
  its predecessor. Both are tested.
- **Exportable audit trail**, as JSON or as Markdown you can paste into a review.

What it deliberately does not claim: **this is not a digital signature.** There
is no private key in a browser, so it establishes integrity, not authorship.
SHA-256 via SubtleCrypto where available, FNV-1a otherwise, and the record
always records which one produced it.

---

## Deliberately out of scope

The positioning document describes a larger product than this repo implements.
Rather than stub these, they are absent and named:

- **WASM / DuckDB engine.** The engine here is hand-written JavaScript over a
  pre-aggregated cube. Practical ceiling is around 250k rows in a browser tab;
  the limit is enforced with a message rather than discovered by crashing.
- **Enclave mode, BYOK, VPC deployment.**
- **CRDT collaboration.** No multiplayer, no shared cursors.
- **Warehouse connectors.** CSV upload only.
- **Semantic layer with governed metric definitions.**

The provenance layer is real and complete because it was the cheapest item on
that list and the only one a BI vendor cannot copy by shipping a feature.

---

## Testing

```
npm run test:engine
```

83 assertions across 15 sections, run against seven synthetic datasets with
planted, known ground truth — including a null dataset whose correct answer is
zero findings, and a small-sample trap (a region with two rows a month swinging
400%) that must be excluded from claims while remaining visible in the raw
breakdown with its row count attached.

Current: **83 passed, 0 failed.**

The engine is dependency-free and runs under plain Node, which is why the tests
need no framework and no browser.

## Layout

```
src/
  engine/
    stats.js       distributions, Grubbs, BH-FDR, Holt, decompositions
    csv.js         RFC-4180 parser, columnar storage, interning
    profile.js     schema inference, time-axis scoring, aggregation classification
    cube.js        memoised date keys, chunked non-blocking build
    query.js       cube queries — every result carries its row count
    insights.js    the traversal, the tests, the correction
    index.js       barrel + loadDataset pipeline with guards
  provenance.js    hashing, decision records, hash chain, export
  agents.js        the six agents
  nlu.js           rule-based intent parsing (deliberately not a model)
  ui/              tokens, charts, insight card, panels
  App.js
tests/
  generate.mjs     seven generators with known ground truth
  run.mjs          the suite
samples/           three CSVs that demonstrate the behaviour
```

The intent parser is rules, not a model, on purpose: if an LLM picks the agent
and the dimension, the same question can route differently on two runs and the
decision record stops being reproducible. Rules are dull and they are auditable.
When a rule misses, the parser records what it assumed instead of guessing
silently.
