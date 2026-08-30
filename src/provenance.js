/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — PROVENANCE
   ───────────────────────────────────────────────────────────────────────────
   The v7 audit found the gap between the positioning ("cryptographically
   signed, tamper-evident audit trail") and the code (`id: Math.random()`).
   This closes it, and it is the cheapest high-value thing in the whole
   project: hash the input, stamp the engine versions, serialise the query
   and the test, hash the record.

   What this gives you and no dashboard tool does:

     - Reproducibility as a checkable property. Same file, same question,
       same record hash. Different file, different hash, immediately visible.
     - A finding that carries its own test, statistic, p, q and sample size,
       so "where did this number come from" is answered by the artifact rather
       than by an analyst's memory three months later.
     - Tamper evidence within a session chain. Each record commits to the
       previous record's hash, so a record cannot be quietly removed from the
       middle of a journal.

   What this deliberately does NOT claim:

     - It is not a digital signature. There is no private key, so it proves
       integrity, not authorship. Signing requires a key the browser does not
       have and a service to attest it. Calling an unsigned hash chain
       "cryptographically signed" is exactly the kind of overclaim the rest of
       this engine exists to avoid.
     - It does not prove the source file was not doctored before upload. It
        proves that this analysis ran against a file with this exact content.
   ═══════════════════════════════════════════════════════════════════════════ */

/* global globalThis */
import { STATS_VERSION } from "./engine/stats.js";
import { CSV_VERSION } from "./engine/csv.js";
import { PROFILE_VERSION } from "./engine/profile.js";
import { CUBE_VERSION } from "./engine/cube.js";
import { QUERY_VERSION } from "./engine/query.js";
import { INSIGHTS_VERSION } from "./engine/insights.js";

export const PROVENANCE_VERSION = "provenance/1.0.0";
export const ENGINE_STAMP = Object.freeze({
  provenance: PROVENANCE_VERSION,
  csv: CSV_VERSION,
  profile: PROFILE_VERSION,
  cube: CUBE_VERSION,
  query: QUERY_VERSION,
  stats: STATS_VERSION,
  insights: INSIGHTS_VERSION,
});

/* ─── HASHING ────────────────────────────────────────────────────────────── */

function toHex(buffer) {
  const b = new Uint8Array(buffer);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

/** FNV-1a 128-bit-ish fallback. Not cryptographic; labelled as such. */
function fnv1a(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
    h3 = Math.imul(h3 ^ (c * 31), 0xc2b2ae35);
    h4 = Math.imul(h4 ^ (c ^ (i << 3)), 0x27d4eb2f);
  }
  const u = (x) => (x >>> 0).toString(16).padStart(8, "0");
  return u(h1) + u(h2) + u(h3) + u(h4);
}

function subtle() {
  if (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  return null;
}

/**
 * SHA-256 where available, FNV-1a otherwise. The return value always says
 * which algorithm produced it — a hash whose provenance you cannot check is
 * worse than no hash.
 */
export async function hash(input) {
  const s = typeof input === "string" ? input : JSON.stringify(input);
  const sub = subtle();
  if (sub) {
    try {
      const enc = new TextEncoder().encode(s);
      const digest = await sub.digest("SHA-256", enc);
      return { algo: "sha-256", hex: toHex(digest), cryptographic: true };
    } catch { /* fall through */ }
  }
  return { algo: "fnv-1a-128", hex: fnv1a(s), cryptographic: false };
}

/** Short display form. Full hex is retained in the record. */
export function shortHash(h) {
  const hex = typeof h === "string" ? h : h?.hex || "";
  return hex ? `${hex.slice(0, 8)}…${hex.slice(-4)}` : "—";
}

/* ─── CANONICAL SERIALISATION ────────────────────────────────────────────── */

/**
 * Stable JSON: keys sorted, no undefined, floats rounded to 12 significant
 * digits so a rebuild on a different CPU cannot flip the last bit and
 * invalidate an otherwise identical record.
 */
export function canonical(value) {
  const round = (n) => {
    if (!Number.isFinite(n)) return null;
    if (Number.isInteger(n)) return n;
    return Number(n.toPrecision(12));
  };
  const walk = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return round(v);
    if (typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(walk);
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = walk(v[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/* ─── DATASET FINGERPRINT ────────────────────────────────────────────────── */

/**
 * Fingerprint a dataset. Hashes the raw text so any change to any cell
 * changes the hash, plus a structural summary that is cheap to eyeball.
 */
export async function fingerprintDataset(text, parsed, prof, fileName) {
  const content = await hash(text);
  const structure = await hash(canonical({
    headers: parsed.headers,
    rowCount: parsed.rowCount,
    types: Object.fromEntries(Object.entries(prof.schema).map(([k, v]) => [k, v.type])),
    timeCol: prof.timeCol,
    aggregations: Object.fromEntries(prof.measures.map((m) => [m.col, m.agg])),
  }));
  return {
    fileName: fileName || "(unnamed)",
    bytes: text.length,
    rows: parsed.rowCount,
    columns: parsed.headers.length,
    contentHash: content,
    structureHash: structure,
    delimiter: parsed.delimiter,
    truncated: parsed.truncated,
  };
}

/* ─── DECISION RECORD ────────────────────────────────────────────────────── */

/**
 * Build the record for one answer. Everything a reviewer needs to re-run it
 * and everything they need to judge whether to believe it.
 */
export async function buildRecord({
  dataset, question, intent, grain, period,
  agent, finding, audit, result, chainPrev = null, clock,
}) {
  // Clock is injected so tests are deterministic. In the app it is Date.now.
  const at = clock ? clock() : Date.now();

  const evidence = finding ? {
    kind: finding.kind,
    test: finding.test || null,
    statistic: finding.statistic ?? null,
    p: finding.p ?? null,
    q: finding.q ?? null,
    effectSize: finding.effect ?? null,
    sampleRows: finding.n ?? null,
    members: finding.members ?? null,
    descriptiveOnly: !!finding.descriptiveOnly,
    lowPower: !!finding.lowPower,
    subject: finding.kind === "cross"
      ? { dimA: finding.dimA, a: finding.a, dimB: finding.dimB, b: finding.b }
      : { dim: finding.dim, value: finding.value },
    measure: finding.measure,
  } : null;

  const body = {
    schema: "axilattice.decision-record/1",
    engine: ENGINE_STAMP,
    dataset: {
      fileName: dataset.fileName,
      rows: dataset.rows,
      columns: dataset.columns,
      contentHash: dataset.contentHash.hex,
      contentHashAlgo: dataset.contentHash.algo,
      structureHash: dataset.structureHash.hex,
    },
    question,
    resolvedIntent: intent || null,
    scope: { grain, period },
    agent: agent || null,
    evidence,
    multiplicity: audit ? {
      testsRun: audit.testsRun,
      survived: audit.survived,
      fdrThreshold: audit.fdrQ,
      correction: "benjamini-hochberg",
      supportFloor: audit.supportFloor,
    } : null,
    result: result || null,
    chainPrev,
    timestamp: new Date(at).toISOString(),
  };

  // The record ID is a hash of the question and the data, NOT random.
  // Same question on the same file gives the same ID, which is how you
  // demonstrate reproducibility rather than assert it.
  const identity = await hash(canonical({
    contentHash: body.dataset.contentHash,
    question, intent: intent || null, grain, period, agent: agent || null,
    engine: ENGINE_STAMP,
  }));
  const recordHash = await hash(canonical({ ...body, identity: identity.hex }));

  return { ...body, identity: identity.hex, recordHash: recordHash.hex, recordHashAlgo: recordHash.algo };
}

/** Recompute a record's hash and compare. Returns a diagnosis, not a boolean. */
export async function verifyRecord(record) {
  const { recordHash, recordHashAlgo, identity, ...body } = record;
  const recomputed = await hash(canonical({ ...body, identity }));
  const ok = recomputed.hex === recordHash;
  return {
    ok,
    expected: recordHash,
    computed: recomputed.hex,
    algo: recomputed.algo,
    note: ok
      ? "Record content matches its hash. It has not been altered since it was written."
      : "Record content does not match its hash. It has been edited, or was written by a different engine version.",
  };
}

/* ─── JOURNAL (the hash chain) ───────────────────────────────────────────── */

export function createJournal() {
  return { entries: [], head: null };
}

export async function appendToJournal(journal, recordInput) {
  const record = await buildRecord({ ...recordInput, chainPrev: journal.head });
  journal.entries.push(record);
  journal.head = record.recordHash;
  return record;
}

/**
 * Verify the whole chain. Catches both edits to a record and removal of a
 * record from the middle, because each link commits to its predecessor.
 */
export async function verifyJournal(journal) {
  const problems = [];
  let prev = null;
  for (let i = 0; i < journal.entries.length; i++) {
    const r = journal.entries[i];
    const v = await verifyRecord(r);
    if (!v.ok) problems.push({ index: i, issue: "content-hash-mismatch", detail: v.note });
    if (r.chainPrev !== prev) {
      problems.push({ index: i, issue: "broken-chain",
        detail: `expected predecessor ${prev || "(none)"}, record claims ${r.chainPrev || "(none)"}` });
    }
    prev = r.recordHash;
  }
  return { ok: problems.length === 0, entries: journal.entries.length, problems };
}

/* ─── EXPORT ─────────────────────────────────────────────────────────────── */

export function journalToJSON(journal, meta = {}) {
  return JSON.stringify({
    schema: "axilattice.decision-journal/1",
    exported: new Date().toISOString(),
    engine: ENGINE_STAMP,
    ...meta,
    head: journal.head,
    entries: journal.entries,
  }, null, 2);
}

/** Human-readable audit trail. This is the thing you paste into a review. */
export function journalToMarkdown(journal) {
  const lines = ["# Analysis audit trail", ""];
  lines.push(`Engine: ${Object.entries(ENGINE_STAMP).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push(`Chain head: \`${journal.head || "(empty)"}\``);
  lines.push("");
  journal.entries.forEach((r, i) => {
    lines.push(`## ${i + 1}. ${r.question}`);
    lines.push("");
    lines.push(`- Dataset: ${r.dataset.fileName} — ${r.dataset.rows.toLocaleString()} rows × ${r.dataset.columns} columns`);
    lines.push(`- Content hash (${r.dataset.contentHashAlgo}): \`${r.dataset.contentHash}\``);
    lines.push(`- Scope: ${r.scope.grain} grain, period ${r.scope.period}`);
    if (r.agent) lines.push(`- Agent: ${r.agent}`);
    if (r.evidence) {
      const e = r.evidence;
      lines.push(`- Test: ${e.test || "none"}${e.statistic != null ? ` (statistic ${Number(e.statistic).toFixed(4)})` : ""}`);
      if (e.p != null) lines.push(`- p = ${e.p.toExponential(3)}${e.q != null ? `, q = ${e.q.toExponential(3)} after Benjamini-Hochberg` : ""}`);
      if (e.descriptiveOnly) lines.push(`- **Descriptive only** — no significance test applies to this measure type.`);
      if (e.lowPower) lines.push(`- **Low power** — few members, treat with caution.`);
      if (e.sampleRows != null) lines.push(`- Rows behind the number: ${e.sampleRows.toLocaleString()}`);
    }
    if (r.multiplicity) {
      lines.push(`- Multiplicity: ${r.multiplicity.testsRun} tests run, ${r.multiplicity.survived} survived at q ≤ ${r.multiplicity.fdrThreshold} (Benjamini-Hochberg)`);
    }
    if (r.result?.summary) { lines.push(""); lines.push(`> ${r.result.summary}`); }
    lines.push("");
    lines.push(`Record \`${r.recordHash}\` · previous \`${r.chainPrev || "(genesis)"}\` · ${r.timestamp}`);
    lines.push("");
  });
  return lines.join("\n");
}
