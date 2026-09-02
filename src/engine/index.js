/* ═══════════════════════════════════════════════════════════════════════════
   AXILATTICE — ENGINE BARREL
   One import surface for the UI, plus the end-to-end load pipeline with the
   guards that stop a large file from taking the tab down.
   ═══════════════════════════════════════════════════════════════════════════ */

export * from "./stats.js";
export * from "./csv.js";
export * from "./profile.js";
export * from "./cube.js";
export * from "./query.js";
export * from "./insights.js";

import { parseCSV } from "./csv.js";
import { profile } from "./profile.js";
import { buildCube, estimateCubeBytes } from "./cube.js";

export const ENGINE_VERSION = "engine/1.0.0";

/** Practical ceilings, surfaced to the user rather than discovered by crashing. */
export const LIMITS = {
  softRows: 250000,   // warn past here
  hardRows: 1000000,  // refuse past here in browser mode
  warnBytes: 300e6,   // warn if the cube would exceed this
};

/**
 * Load a CSV end to end: parse, profile, build.
 * Every failure mode returns a message a person can act on, because "cannot
 * read properties of undefined" is not an error report.
 */
export async function loadDataset(text, { fileName, onProgress, options = {} } = {}) {
  const warnings = [];

  onProgress?.({ phase: "parse", done: 0, total: 1 });
  const parsed = parseCSV(text, { maxRows: LIMITS.hardRows });
  if (!parsed.headers.length) throw new Error("No header row found. The first line should name the columns.");
  if (!parsed.rowCount) throw new Error("The file has a header but no data rows.");
  if (parsed.truncated) {
    warnings.push(`File exceeds the ${LIMITS.hardRows.toLocaleString()}-row browser limit. Only the first ${LIMITS.hardRows.toLocaleString()} rows were read.`);
  }
  if (parsed.rowCount > LIMITS.softRows) {
    warnings.push(`${parsed.rowCount.toLocaleString()} rows. The build will take a few seconds and the cube will be large.`);
  }

  onProgress?.({ phase: "profile", done: 0, total: 1 });
  const prof = profile(parsed, options.profile);

  if (!prof.timeCol) {
    const candidates = Object.entries(prof.schema)
      .filter(([, v]) => v.type === "identifier" || v.type === "dim_high_card")
      .map(([k]) => k).slice(0, 4);
    throw new Error(
      "No date column recognised. The cube needs a time axis. " +
      "Dates should look like 2024-01-31, 31/01/2024 or 31-Jan-2024." +
      (candidates.length ? ` Columns that were read as text: ${candidates.join(", ")}.` : "")
    );
  }
  if (!prof.measures.length) {
    throw new Error("No numeric measure found. At least one column needs to hold numbers with real variation.");
  }
  if (!prof.dims.length) {
    warnings.push("No usable dimensions — every non-numeric column was either unique per row or too high-cardinality. Only totals and trends will work.");
  }
  if (prof.timeAlternatives.length) {
    warnings.push(`Using ${prof.timeCol} as the time axis. ${prof.timeAlternatives.map((a) => a.col).join(", ")} also parse as dates — switch in the schema panel if that is wrong.`);
  }

  const cube = await buildCube(prof, { ...options.cube, onProgress });

  if (cube.meta.unparsedDates) {
    const pctBad = (cube.meta.unparsedDates / parsed.rowCount) * 100;
    warnings.push(`${cube.meta.unparsedDates.toLocaleString()} row(s) (${pctBad.toFixed(1)}%) had a date that could not be parsed and were excluded from the cube.`);
  }
  if (cube.meta.crossPairsSkipped) {
    warnings.push(`${cube.meta.crossPairsSkipped} dimension pair(s) were skipped to stay inside the memory budget, so some 2-way analysis is unavailable.`);
  }
  const bytes = estimateCubeBytes(cube);
  if (bytes > LIMITS.warnBytes) {
    warnings.push(`Cube is roughly ${(bytes / 1e6).toFixed(0)} MB in memory. Consider fewer dimensions or a coarser grain.`);
  }

  onProgress?.({ phase: "done", done: 1, total: 1 });
  return { parsed, profile: prof, cube, warnings };
}
