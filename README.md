# Axilattice v8

In-browser analytics that reports the statistical test behind every claim. Drop
a CSV, ask a question in words, get an answer that carries its own evidence —
the test used, the statistic, the p-value, the q-value after multiple-comparison
correction, and how many rows it rests on. The file never leaves the tab.

```bash
npm install
npm start          # dev server
npm run build      # static bundle in ./build
npm run test:engine   # 85 assertions against synthetic data with known ground truth
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

## Auto-generated dataset skill

On load, Axilattice writes a skill document from schema profiling — no human
curation, regenerated on every load and on any schema override, so it cannot
drift from the data.

Printing a column list is the easy part. The value is the **gotchas** section,
which states what the engine knows and a reader cannot see:

- `signup_date` also parses as a date but was rejected as the time axis, and if
  the question is really about signups then every period in every answer is
  wrong
- `margin_pct` must never be summed, and comparing its blended value across
  periods is exposed to Simpson's paradox
- `segment` has three members, below the Grubbs floor — the largest attainable
  statistic at n=3 is 1.155, so a single-period comparison there can never be
  conclusive, and the binomial persistence test covers it instead
- these four cells sit below the support floor and are excluded from claims
- these dimension pairs were skipped for memory budget, so a two-way question
  across them returns nothing, which is not the same as finding nothing

Plus which analysis patterns work on *this* file, and what it cannot answer —
starting with anything causal.

A curated semantic layer tells you what someone meant. A generated skill tells
you what the data will actually do to you. The first rots; the second is
regenerated with a fresh hash whenever the interpretation changes, and that hash
goes into every audit record — so a reviewer can see that an answer was produced
under a *different* schema reading than the one in front of them.

Sample: `sample-generated-skill.md`. Export from the Skill panel.

## Business context

The cube knows revenue fell 39% and that West × Partner carries 78% of it. It
cannot know the Partner API was down for nine days, because that is not in the
CSV and never will be.

Attach a document — release notes, incident log, roadmap, deploy history — and
entries dated in or just before a finding's period surface beside it.

**Retrieval is date-first, and that is the design decision worth defending.**
The obvious approach is semantic similarity: embed the finding, embed the
chunks, take the nearest. It is the wrong primary signal. A finding is anchored
to a period, and its explanation, if the document holds one, is anchored to the
same period or the one just before — causes precede effects. Temporal alignment
is a far stronger discriminator than word overlap, and unlike an embedding it is
exact, explainable, and needs no model or key.

Ranking: date inside the period (+100), date in the prior period (+70), nearby
(+25), each named dimension member or measure (+40, capped), lexical overlap as
a tiebreak only.

One rule from a test failure during the build. A dated entry whose date does
*not* align is **disqualified outright**, not merely down-ranked. A 2019 note
mentioning the West region was surfacing next to a 2025 drop on the strength of
the name match alone. An entry carrying a date is making a temporal claim, and
that claim says "not this period". Undated entries are treated differently on
purpose — they make no temporal claim, so they stay eligible, but they can never
outrank a dated in-period hit.

Context is always framed as a candidate: *"this entry sits in or just before
2025-10. Time alignment is not evidence of cause; the engine did not test this
and cannot."*

## The narration guard

The brief says the narrator retrieves from context but the numbers still come
from the deterministic engine. Agreeing with that is easy; enforcing it is the
job. A fluent model handed a finding and an incident log will produce *"revenue
fell roughly 40%, costing about $1.2M"* — the engine computed 38.7% and never
computed a dollar impact at all. The second number is invented, plausible, and
in a board deck by Thursday.

So the contract is mechanical:

1. The engine computes the finding and a deterministic sentence.
2. The narrator receives the finding, skill passages and retrieved context as
   structured data, with an explicit allow-list of every number it may utter.
3. Output is parsed for numbers. Any number not in the allow-list discards the
   **entire** narration and falls back to the deterministic sentence.

Discarded whole, not patched. A sentence with one invented number is not
salvageable by deleting the number, because the reasoning that produced it is
also suspect.

The allow-list is built from the card's own computed values, plus anything
already in the deterministic sentence, plus numbers quoted verbatim from a
retrieved context entry. Rounding is tolerated (39% is a fair rendering of
0.387); invention is not.

Tested: invented figures rejected with the offending tokens named, rounded
renderings accepted, context quotes accepted, a narrator outage falling back
cleanly, and the deterministic path passing its own guard — that last one is a
canary, because if it ever fails the engine is printing a number it did not
compute.

**Default configuration is no model.** The deterministic narrator ships, because
it cannot be wrong about a number and needs no key. `narrate()` takes an
optional `llm` function, so wiring a model is one argument — but see the caveat
at the end of this file before doing it in the browser.

## The provenance footer

One line under every answer, same fields in the same order:

```
Source: drill agent (survives correction) · Test: studentized deviation = -5.6463 · p < 0.001 · q < 0.001
· Data hash: 3e5d9c · Engine: insights/1.0.0 · Freshness: 2025-10 · Skill: a41f0b · Context: 4 entries
```

Two deliberate differences from the reference footer:

**Source names the agent and the evidence tier.** The reference distinguishes
semantic layer / governed table / raw exploration, which is a claim about how
trustworthy the *query* was. The equivalent axis here is how trustworthy the
*claim* is. A corrected scan result and a raw breakdown with no test are both
"the engine", and you should believe them very differently — so a raw lookup
renders grey and says "no test" rather than borrowing the authority of the cards
around it.

**Freshness is the newest date in the data**, not the time the analysis ran.
Those differ, and only the former tells you whether to trust the number.

Every field is in the audit record too, including `context.influencedNumbers:
false` stated explicitly, and the skill hash — so changing the time axis changes
the record identity, because the same question under a different schema reading
is not the same analysis.

---

## v8.1 — what the first deployment exposed

Deploying to a real 79k-row, 13-column delivery dataset surfaced five defects
that no synthetic test had caught. All five are fixed with regression coverage.

**Low-cardinality numerics were dimensions only.** `rating` (5 values), `items`
(6) and `tip` (4) all fell under the `minNumericUnique: 12` rule and became
dimensions with no measure counterpart. A 13-column file profiled to **2
measures instead of 5**, and Correlate answered "cannot be correlated here" on a
file with five perfectly correlatable quantities. These columns are legitimately
both — you slice by rating and you also average it. They are now dual-role.
Being wrong here never threw an error; it silently removed capability, which is
worse.

**The feed threw away its own findings.** On that dataset the engine located 26
findings that survived correction and the UI displayed **one card**, because
`agentScan` packed the top three into a `findings` array nothing rendered. The
insights were there the entire time. Connect now builds a ranked feed of up to
30 cards.

**Priority tiers.** Reporting only what clears q ≤ 0.10 and nothing else is
statistically defensible and useless as a product — a user who connects a
dataset and sees three lines cannot tell a clean dataset from a broken tool. The
resolution keeps the rigour: **the tier is the evidence standard.**

- **HIGH** — survives at q ≤ 0.001 with an effect ≥ 1 SD
- **MEDIUM** — survives at the standard q ≤ 0.10 bar, smaller effect or lower power
- **LOW** — does not clear correction, or carries no applicable test; labelled unproven

A reader who trusts only HIGH gets exactly the old behaviour. Nothing is hidden
and nothing is promoted past what its statistics support.

**The cross-cell test was answering the wrong question.** It compared each
cell's measure *total* against independence of the marginals, which produced six
near-identical cards: DS-07 × rating=2 "over-represented" on order_value at
6.4×, on delivery_min at 4.3×, on items at 5.9×. Those are one finding — more
rows land in that cell — restated once per measure, because every additive total
inherits the row-count imbalance.

It now runs a **Welch t-test on cell means** against the rest of the data, which
asks what people actually mean: conditional on how many rows are here, is the
average unusual? This required storing sum-of-squares per cell, one extra double
— and it makes the point that a variance is an aggregate. Nothing here ever goes
back to the rows.

**Selection bias, caught by the null test.** The first version of that Welch
test sorted cells by effect size, kept the top three, and handed their raw
p-values to the FDR step. You cannot search forty cells for the largest and then
report its nominal p-value as though you picked it in advance — the same error
the fixed z-threshold made, one level up. Every tested cell now enters the pool.

## Calibration, not a lucky seed

Removing the selection bias did not silence the null-dataset test, and the
investigation is the interesting part.

The old assertion was "exactly zero findings on the null dataset." That is a
deterministic claim about a probabilistic guarantee. BH at q ≤ 0.10 on data with
no signal controls the family-wise error rate at 0.10 — so roughly **one null
dataset in ten should produce a finding**. The assertion had only ever passed
because the cross-cell test was underpowered; replacing it with a correctly
specified one raised power, and a seed landed in that one-in-ten.

Tuning thresholds until that seed returned zero would have been hiding a correct
result. Measured across 20 null datasets instead:

```
3/20 produced a finding (15%) against a nominal 10%   — within sampling noise
mean findings per null dataset: 0.30
findings reaching HIGH tier on pure noise: 0
```

The test now asserts the actual statistical property, and adds the one that
matters most for a user: **nothing from pure noise ever reaches HIGH.**

## Feed diversity

Ranking alone produced a feed whose first six cards all said the same thing —
every combination involving `rating = 1` showed slow deliveries, because in that
dataset rating is a *consequence* of delivery time. The engine cannot know which
way the arrow points; that is precisely the causal claim it refuses to make. But
it can decline to spend the whole feed restating one relationship.

Selection is now round-robin across measures with per-subject caps (2 findings
per measure per dimension, 3 per measure mentioning the same member). Ranking
still decides what wins inside a bucket; diversity decides how many turns each
bucket gets. The result spreads evenly — 6 cards each across all five measures —
and the selection happens strictly *after* the statistics, never before.

Two tautologies also removed: a dual-role column is never tested against itself
(`tip = 30 is extreme on tip`), and on a two-member dimension only the top
persistence finding is emitted, since "Standard is always highest" and "Express
is always lowest" are one fact written twice.

## Time to first insight

The connect path is now measured, because "insights on connection" is the
product promise:

```
parse + profile + cube build   3,720 ms
feed traversal + 3,337 tests       39 ms   ← the precompute bet paying off
TOTAL                          3,759 ms    (79,346 rows × 13 columns)
```

Down from 6,471 ms. Two changes got it there: cross-cells are materialised at
month grain only (building them at month, quarter *and* year was 65% of total
build cost — 51 million accumulator calls — for coarse-grain 2-way cells nobody
reads), and the per-row measure buffer is preallocated instead of allocating an
array per row.

The traversal being 39 ms of 3,759 is the number that matters architecturally.
Every question after connect is a lookup. The remaining cost is all in building
the cube, which is exactly the work a connector pulling pre-aggregated cells
would not have to do.

## Mobile layout

The deployed build scrolled sideways on a phone, and iOS then inflated the type
to match the wider layout, so every screen read as zoomed-in with text clipped at
both edges. Three causes: unbounded document width, missing
`text-size-adjust`, and flex children defaulting to `min-width: auto` so a
64-character hash could push a card wider than the screen. All three fixed at the
root rather than per-component.

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
npm test              # both suites
npm run test:engine   # 85 assertions — engine and statistics
npm run test:context  # 64 assertions — skill, context retrieval, narration guard
```

149 assertions total. The engine suite runs 85 across 15 sections, run against seven synthetic datasets with
planted, known ground truth — including a null dataset whose correct answer is
zero findings, and a small-sample trap (a region with two rows a month swinging
400%) that must be excluded from claims while remaining visible in the raw
breakdown with its row count attached.

Current: **149 passed, 0 failed.**

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
  skill.js         auto-generated dataset skill from schema profiling
  context.js       context document indexing and date-first retrieval
  narrate.js       narration + the numeric guard
  agents.js        the six agents
  nlu.js           rule-based intent parsing (deliberately not a model)
  ui/              tokens, charts, insight card, panels, provenance footer
  App.js
tests/
  generate.mjs     seven generators with known ground truth
  run.mjs          engine and statistics suite
  run-context.mjs  skill, context and narration-guard suite
samples/           four CSVs (incl. the 79k-row delivery reproduction) plus a context document
```

The intent parser is rules, not a model, on purpose: if an LLM picks the agent
and the dimension, the same question can route differently on two runs and the
decision record stops being reproducible. Rules are dull and they are auditable.
When a rule misses, the parser records what it assumed instead of guessing
silently.

---

## Caveat on wiring a real model

`narrate()` accepts an `llm` function and the guard is fully tested, but nothing
in this repo calls a model, and that is not an oversight.

This deploys as a static site. Calling an LLM API from the browser means the key
is in the bundle, which is the same as publishing it. Doing this properly needs a
small server-side proxy that holds the key and forwards the narration payload —
maybe forty lines on Render or a Vercel function. That is a deployment decision
with a cost and a data-residency implication, and the current promise on the
upload screen is that the file never leaves the tab. Sending findings to a model
API breaks that promise, so it should be an explicit choice rather than a
default someone discovers later.

The seam is there. `narrate({ card, skill, contextHits, llm })` — supply the
function and everything downstream, guard included, already works.
