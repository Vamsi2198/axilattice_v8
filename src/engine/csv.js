/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — CSV PARSER
   ───────────────────────────────────────────────────────────────────────────
   RFC-4180 with the usual real-world tolerances: BOM, CRLF, quoted fields,
   escaped quotes, ragged rows, blank lines, and delimiter sniffing.

   Two changes from v7 that matter at scale:

   1. COLUMNAR STORAGE. v7 built one plain object per row. At 200k rows x 12
      columns that is 200k objects with 12 hidden-class properties each — the
      allocator does most of the work and the GC does the rest. We store one
      array per column instead. Same information, a fraction of the memory,
      and every downstream pass becomes a tight loop over a dense array.

   2. INTERNED VALUES. Categorical columns repeat the same handful of strings
      millions of times. We intern them into a dictionary and store integer
      codes, so grouping compares integers rather than strings.
   ═══════════════════════════════════════════════════════════════════════════ */

export const CSV_VERSION = "csv/1.0.0";

const DELIMS = [",", ";", "\t", "|"];

/** Sniff the delimiter from the header line by counting unquoted candidates. */
export function sniffDelimiter(text) {
  const nl = text.indexOf("\n");
  const head = nl === -1 ? text.slice(0, 4096) : text.slice(0, nl);
  let best = ",", bestCount = -1;
  for (const d of DELIMS) {
    let count = 0, inQ = false;
    for (let i = 0; i < head.length; i++) {
      const c = head[i];
      if (c === '"') inQ = !inQ;
      else if (c === d && !inQ) count++;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

/**
 * Parse CSV text into columnar form.
 * Returns { headers, columns, rowCount } where columns[i] is a string array.
 */
export function parseCSV(text, opts = {}) {
  if (typeof text !== "string") throw new TypeError("parseCSV expects a string");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = opts.delimiter || sniffDelimiter(text);
  const maxRows = opts.maxRows || Infinity;

  const headers = [];
  let columns = null;
  let rowCount = 0;

  let field = "";
  let col = 0;
  let inQuotes = false;
  let rowStarted = false;
  let headerDone = false;
  let overflow = false;

  const pushField = (value) => {
    if (!headerDone) {
      headers.push(value.trim());
    } else if (columns && col < columns.length) {
      columns[col].push(value);
    }
    col++;
  };

  const endRow = () => {
    if (!headerDone) {
      headerDone = true;
      columns = headers.map(() => []);
      col = 0;
      rowStarted = false;
      return;
    }
    // Pad ragged short rows so every column stays the same length.
    if (columns) for (let i = col; i < columns.length; i++) columns[i].push("");
    rowCount++;
    col = 0;
    rowStarted = false;
    if (rowCount >= maxRows) overflow = true;
  };

  const len = text.length;
  for (let i = 0; i < len; i++) {
    if (overflow) break;
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; rowStarted = true; continue; }
    if (c === delim) { pushField(field); field = ""; rowStarted = true; continue; }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (rowStarted || field.length) { pushField(field); field = ""; endRow(); }
      continue;
    }
    field += c;
    rowStarted = true;
  }
  if (rowStarted || field.length) { pushField(field); endRow(); }

  if (!headerDone) return { headers: [], columns: [], rowCount: 0, delimiter: delim, truncated: false };

  // Deduplicate blank or repeated header names so column lookup stays 1:1.
  const seen = new Map();
  const finalHeaders = headers.map((h, i) => {
    let name = h || `column_${i + 1}`;
    if (seen.has(name)) {
      const k = seen.get(name) + 1;
      seen.set(name, k);
      name = `${name}_${k}`;
    } else seen.set(name, 0);
    return name;
  });

  return {
    headers: finalHeaders,
    columns: columns || [],
    rowCount,
    delimiter: delim,
    truncated: overflow,
  };
}

/**
 * Intern a string column into codes + dictionary.
 * Only worth doing below a cardinality ceiling; above it the dictionary costs
 * more than it saves.
 */
export function internColumn(values, ceiling = 4096) {
  const dict = [];
  const index = new Map();
  const codes = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    let c = index.get(v);
    if (c === undefined) {
      if (dict.length >= ceiling) return null; // too many distinct values
      c = dict.length;
      dict.push(v);
      index.set(v, c);
    }
    codes[i] = c;
  }
  return { dict, codes };
}

/** Parse a string column to Float64Array, NaN for unparseable. */
export function toNumericColumn(values) {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === "" || v == null) { out[i] = NaN; continue; }
    const n = Number(v);
    out[i] = Number.isFinite(n) ? n : NaN;
  }
  return out;
}

/** Row accessor for code that still wants object rows (export, drill-through). */
export function rowAt(parsed, i) {
  const obj = {};
  for (let c = 0; c < parsed.headers.length; c++) obj[parsed.headers[c]] = parsed.columns[c][i];
  return obj;
}
