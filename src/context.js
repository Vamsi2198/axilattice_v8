/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — BUSINESS CONTEXT
   ───────────────────────────────────────────────────────────────────────────
   The engine can tell you that revenue fell 39% and that West × Partner
   carries 78% of it, with a p-value. It cannot tell you that the Partner API
   was down for nine days in September, because that fact is not in the CSV and
   never will be.

   So: attach a document. Release notes, an incident log, a roadmap, a
   deploy history, meeting notes. Anything with dates in it.

   RETRIEVAL DESIGN — the important decision.

   The obvious approach is semantic similarity: embed the finding, embed the
   chunks, take the nearest. That is the wrong primary signal here, and it is
   worth being precise about why.

   A finding is anchored to a PERIOD. Its explanation, if one exists in the
   document, is almost always anchored to the same period or the one just
   before it — causes precede effects. Temporal alignment is a far stronger
   discriminator than word overlap, and unlike an embedding it is exact,
   explainable, and needs no model. An incident dated 2025-09-14 is a candidate
   explanation for a September drop no matter what vocabulary it uses.

   So the ranking is: temporal alignment first, then exact mention of the
   dimension member or measure the finding is about, then lexical overlap as a
   tiebreak. All three are inspectable, which matters because the retrieved
   passage is going to sit next to a p-value and inherit its authority.

   And the hard rule: context can only ever be a CANDIDATE EXPLANATION. It is
   presented as correlated in time, never as cause, and it never touches a
   number. The numbers come from the cube.
   ═══════════════════════════════════════════════════════════════════════════ */

import { parseDateParts, toEpochDay } from "./engine/profile.js";
import { hash } from "./provenance.js";

export const CONTEXT_VERSION = "context/1.0.0";

const MONTH_NAMES = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const STOP = new Set(("a an the and or but of to in on for with at by from is are was were be been " +
  "this that these those it its we our us they their as if then than so such not no " +
  "have has had do does did will would can could should may might").split(" "));

/* ─── PERIOD KEY → DAY RANGE ─────────────────────────────────────────────── */

const lastDayOfMonth = (y, m) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
  31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

export function periodRange(periodKey, grain) {
  if (!periodKey) return null;
  const day = (y, m, d) => toEpochDay({ y, m, d });
  let m;
  if ((m = periodKey.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    const d = day(+m[1], +m[2], +m[3]);
    return { start: d, end: d };
  }
  if ((m = periodKey.match(/^(\d{4})-W(\d{2})$/))) {
    const y = +m[1], w = +m[2];
    const jan1 = day(y, 1, 1);
    const jan1dow = ((jan1 + 3) % 7 + 7) % 7 + 1;
    const week1Mon = jan1 - jan1dow + 1 + (jan1dow > 4 ? 7 : 0);
    const start = week1Mon + (w - 1) * 7;
    return { start, end: start + 6 };
  }
  if ((m = periodKey.match(/^(\d{4})-(\d{2})$/))) {
    const y = +m[1], mo = +m[2];
    return { start: day(y, mo, 1), end: day(y, mo, lastDayOfMonth(y, mo)) };
  }
  if ((m = periodKey.match(/^(\d{4})-Q([1-4])$/))) {
    const y = +m[1], q = +m[2];
    const s = (q - 1) * 3 + 1, e = s + 2;
    return { start: day(y, s, 1), end: day(y, e, lastDayOfMonth(y, e)) };
  }
  if ((m = periodKey.match(/^(\d{4})$/))) {
    const y = +m[1];
    return { start: day(y, 1, 1), end: day(y, 12, 31) };
  }
  return null;
}

/* ─── DATE EXTRACTION FROM PROSE ─────────────────────────────────────────── */

/** Pull every date-like reference out of a chunk of text. */
export function extractDates(text) {
  const out = [];
  const push = (y, m, d, precision, raw) => {
    if (!(y > 1990 && y < 2200)) return;
    if (!(m >= 1 && m <= 12)) return;
    const dd = d || 1;
    const end = precision === "month" ? lastDayOfMonth(y, m) : dd;
    out.push({
      raw, precision,
      start: toEpochDay({ y, m, d: dd }),
      end: toEpochDay({ y, m, d: end }),
      label: precision === "month"
        ? `${y}-${String(m).padStart(2, "0")}`
        : `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
    });
  };

  // ISO-ish full dates, reusing the engine's own parser so the two agree.
  const isoRe = /\b(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})\b/g;
  let m;
  while ((m = isoRe.exec(text))) {
    const p = parseDateParts(m[1]);
    if (p) push(p.y, p.m, p.d, "day", m[1]);
  }
  // "2025-09" / "2025/09"
  const ymRe = /\b(\d{4})[-/](\d{1,2})\b(?![-/]\d)/g;
  while ((m = ymRe.exec(text))) push(+m[1], +m[2], null, "month", m[0]);
  // "Sept 14 2025", "14 September 2025", "September 2025"
  const nameRe = new RegExp(
    `\\b(?:(\\d{1,2})\\s+)?(${Object.keys(MONTH_NAMES).join("|")})\\.?\\s+(?:(\\d{1,2})(?:st|nd|rd|th)?,?\\s+)?(\\d{4})\\b`, "gi");
  while ((m = nameRe.exec(text))) {
    const mo = MONTH_NAMES[m[2].toLowerCase()];
    const d = m[1] ? +m[1] : m[3] ? +m[3] : null;
    push(+m[4], mo, d, d ? "day" : "month", m[0]);
  }
  // "Q3 2025" / "2025 Q3"
  const qRe = /\b(?:Q([1-4])\s+(\d{4})|(\d{4})\s+Q([1-4]))\b/gi;
  while ((m = qRe.exec(text))) {
    const q = +(m[1] || m[4]), y = +(m[2] || m[3]);
    const s = (q - 1) * 3 + 1, e = s + 2;
    out.push({ raw: m[0], precision: "quarter",
      start: toEpochDay({ y, m: s, d: 1 }), end: toEpochDay({ y, m: e, d: lastDayOfMonth(y, e) }),
      label: `${y}-Q${q}` });
  }

  // Deduplicate by span, preferring the more precise reading.
  const seen = new Map();
  for (const d of out) {
    const k = `${d.start}:${d.end}`;
    if (!seen.has(k)) seen.set(k, d);
  }
  return Array.from(seen.values()).sort((a, b) => a.start - b.start);
}

/* ─── CHUNKING ───────────────────────────────────────────────────────────── */

/**
 * Split a document into retrievable entries.
 * Bullets and headings are treated as natural boundaries because incident
 * logs, release notes and changelogs are almost always written that way.
 */
export function chunkDocument(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const chunks = [];
  let cur = null;
  let heading = "";

  const flush = () => {
    if (cur && cur.lines.join(" ").trim()) {
      const body = cur.lines.join("\n").trim();
      chunks.push({ heading: cur.heading, text: body });
    }
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^#{1,6}\s/.test(line)) {
      flush();
      heading = line.replace(/^#{1,6}\s*/, "").trim();
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    // A new bullet or a numbered item starts a new entry.
    if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) {
      flush();
      cur = { heading, lines: [line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")] };
      continue;
    }
    if (!cur) cur = { heading, lines: [] };
    cur.lines.push(line);
  }
  flush();
  return chunks;
}

/* ─── INDEX ──────────────────────────────────────────────────────────────── */

function tokenize(text) {
  return text.toLowerCase().match(/[a-z][a-z0-9_]{1,}/g)?.filter((t) => !STOP.has(t)) || [];
}

/**
 * Build a searchable index from a context document.
 * `subjects` are the dimension values, dimension names and measure names from
 * the loaded dataset — an entry that names one of them is far more likely to
 * be about the finding than one that merely shares vocabulary.
 */
export async function indexContext(text, { fileName, subjects = [], kind = "context" } = {}) {
  const chunks = chunkDocument(text);
  const subjectLower = subjects
    .filter((s) => typeof s === "string" && s.length >= 3)
    .map((s) => ({ raw: s, low: s.toLowerCase() }));

  const entries = chunks.map((c, i) => {
    const full = c.heading ? `${c.heading}\n${c.text}` : c.text;
    const low = full.toLowerCase();
    const dates = extractDates(full);
    const hits = [];
    for (const s of subjectLower) {
      const esc = s.low.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${esc}\\b`).test(low)) hits.push(s.raw);
    }
    return {
      id: `${kind}:${i}`,
      heading: c.heading || null,
      text: c.text,
      dates,
      // An entry with no date at all is still retrievable, but it can never
      // win on temporal alignment, which is the strongest signal we have.
      dated: dates.length > 0,
      subjects: hits,
      terms: new Set(tokenize(full)),
    };
  }).filter((e) => e.text.trim().length > 2);

  const docHash = (await hash(text)).hex;
  return {
    version: CONTEXT_VERSION,
    fileName: fileName || "(pasted)",
    kind,
    bytes: text.length,
    entries,
    entryCount: entries.length,
    datedCount: entries.filter((e) => e.dated).length,
    dateRange: entries.flatMap((e) => e.dates).length
      ? {
          from: Math.min(...entries.flatMap((e) => e.dates.map((d) => d.start))),
          to: Math.max(...entries.flatMap((e) => e.dates.map((d) => d.end))),
        }
      : null,
    docHash,
  };
}

/* ─── RETRIEVAL ──────────────────────────────────────────────────────────── */

/**
 * Retrieve candidate explanations for a finding.
 *
 * Scoring, in priority order:
 *   +100  entry date falls inside the finding's period
 *   +70   entry date falls in the period immediately before (causes precede effects)
 *   +25   entry date is within a period-length either side
 *   +40   per named subject (dimension member, dimension, measure), capped
 *   +lexical overlap, small, as a tiebreak only
 *
 * Undated entries max out well below any dated hit. That is deliberate: an
 * undated line from a roadmap should never outrank a dated incident.
 */
export function retrieveContext(index, {
  period, grain, subjects = [], queryText = "", limit = 4, minScore = 20,
} = {}) {
  if (!index?.entries?.length) return [];
  const range = periodRange(period, grain);
  const span = range ? Math.max(1, range.end - range.start + 1) : 30;
  const priorStart = range ? range.start - span : null;

  const qTerms = new Set(tokenize(queryText));
  const wanted = subjects.filter((s) => typeof s === "string" && s.length >= 3).map((s) => s.toLowerCase());

  const scored = [];
  for (const e of index.entries) {
    let score = 0;
    const reasons = [];

    if (range) {
      let best = 0, bestLabel = null;
      for (const d of e.dates) {
        const overlaps = (a1, a2, b1, b2) => a1 <= b2 && b1 <= a2;
        if (overlaps(d.start, d.end, range.start, range.end)) {
          if (100 > best) { best = 100; bestLabel = `dated ${d.label}, inside ${period}`; }
        } else if (overlaps(d.start, d.end, priorStart, range.start - 1)) {
          if (70 > best) { best = 70; bestLabel = `dated ${d.label}, the period before ${period}`; }
        } else if (overlaps(d.start, d.end, range.start - span * 2, range.end + span)) {
          if (25 > best) { best = 25; bestLabel = `dated ${d.label}, near ${period}`; }
        }
      }
      if (best) { score += best; reasons.push(bestLabel); }
      else if (e.dated) {
        // An entry that CARRIES a date is making a temporal claim, and that
        // claim says "not this period". Disqualify it outright rather than
        // letting a subject-name match carry it in: a 2019 note about the West
        // region surfaced next to a 2025 drop, which is exactly the kind of
        // false lead that would make a reader stop trusting this panel.
        //
        // Undated entries are treated differently on purpose. They make no
        // temporal claim, so a roadmap line naming the same segment stays
        // eligible — it just can never outrank a dated in-period hit, because
        // the temporal bonus is the largest term in the score.
        continue;
      }
    }

    if (!range && e.dated) {
      // No period to align against; fall through on subjects and terms alone.
    }
    const subjHits = e.subjects.filter((s) => wanted.includes(s.toLowerCase()));
    if (subjHits.length) {
      score += Math.min(80, subjHits.length * 40);
      reasons.push(`names ${subjHits.map((s) => `“${s}”`).join(", ")}`);
    }

    let overlap = 0;
    for (const t of qTerms) if (e.terms.has(t)) overlap++;
    if (overlap) { score += Math.min(15, overlap * 3); reasons.push(`${overlap} shared term(s)`); }

    if (score >= minScore) {
      scored.push({
        id: e.id, heading: e.heading, text: e.text,
        dates: e.dates.map((d) => d.label),
        score, reasons,
        source: index.fileName,
        docHash: index.docHash,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit);
}

/**
 * Turn retrieved entries into a line the UI can show under a finding.
 * The hedging in this sentence is load-bearing and must not be softened: a
 * time-aligned document entry is a candidate explanation and nothing more.
 */
export function contextSentence(hits, period) {
  if (!hits.length) return null;
  const top = hits[0];
  const where = top.dates.length ? `dated ${top.dates[0]}` : "undated";
  return `Context (${top.source}, ${where}): ${top.text.replace(/\s+/g, " ").slice(0, 220)}` +
    `${top.text.length > 220 ? "…" : ""} — this entry sits in or just before ${period}. ` +
    `Time alignment is not evidence of cause; the engine did not test this and cannot.`;
}
