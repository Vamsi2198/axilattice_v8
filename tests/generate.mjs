/* Synthetic datasets with KNOWN ground truth.
   Every generator plants a specific effect and returns what it planted, so the
   tests can assert the engine finds the real thing and — more importantly —
   does NOT find things in the null dataset. */

/* Deterministic PRNG (mulberry32). Seeded, so a failing test is reproducible. */
export function rng(seed = 42) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller normal from a uniform generator. */
function normal(r, mean = 0, sd = 1) {
  const u1 = Math.max(1e-12, r()), u2 = r();
  return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function dateStr(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function toCSV(headers, rows) {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

/* ═══ 1. NULL DATASET — no real effect anywhere ═══════════════════════════
   Every region, channel and segment draws from the same distribution.
   A tool that reports "top 6 insights" here is reporting noise. The correct
   answer is nothing. */
export function nullDataset({ months = 24, perMonth = 400, seed = 7 } = {}) {
  const r = rng(seed);
  const regions = ["North", "South", "East", "West", "Central"];
  const channels = ["Web", "Retail", "Partner"];
  const segments = ["SMB", "Mid", "Enterprise"];
  const rows = [];
  for (let m = 0; m < months; m++) {
    const y = 2023 + Math.floor(m / 12), mo = (m % 12) + 1;
    for (let i = 0; i < perMonth; i++) {
      const day = 1 + Math.floor(r() * 28);
      rows.push([
        `ORD-${m}-${i}`,
        dateStr(y, mo, day),
        regions[Math.floor(r() * regions.length)],
        channels[Math.floor(r() * channels.length)],
        segments[Math.floor(r() * segments.length)],
        Math.max(1, Math.round(normal(r, 500, 120))),
        Math.max(1, Math.round(normal(r, 8, 3))),
      ]);
    }
  }
  return {
    csv: toCSV(["order_id", "order_date", "region", "channel", "segment", "revenue", "units"], rows),
    truth: { effects: [], note: "no planted effect — the correct finding count is zero" },
  };
}

/* ═══ 2. SMALL-DIMENSION EFFECT ═══════════════════════════════════════════
   THE regression test for the v7 dead zone. `segment` has exactly 3 members
   and Enterprise carries 3x the revenue of the others. v7's z >= 1.5 cutoff
   could not fire at n=3 (max attainable |z| is 1.155), so this real, large,
   obvious effect was invisible. */
export function smallDimensionEffect({ months = 18, perMonth = 600, seed = 11 } = {}) {
  const r = rng(seed);
  const segments = ["SMB", "Mid", "Enterprise"];
  const mult = { SMB: 1.0, Mid: 1.1, Enterprise: 3.2 };
  const regions = ["North", "South", "East", "West"];
  const rows = [];
  for (let m = 0; m < months; m++) {
    const y = 2024 + Math.floor(m / 12), mo = (m % 12) + 1;
    for (let i = 0; i < perMonth; i++) {
      const seg = segments[Math.floor(r() * segments.length)];
      rows.push([
        `ORD-${m}-${i}`, dateStr(y, mo, 1 + Math.floor(r() * 28)),
        regions[Math.floor(r() * regions.length)], seg,
        Math.max(1, Math.round(normal(r, 400 * mult[seg], 60))),
      ]);
    }
  }
  return {
    csv: toCSV(["order_id", "order_date", "region", "segment", "revenue"], rows),
    truth: { dim: "segment", value: "Enterprise", measure: "revenue", members: 3,
      note: "3-member dimension with a 3.2x effect — unreachable by a fixed z>=1.5 cutoff" },
  };
}

/* ═══ 3. SIMPSON'S PARADOX ════════════════════════════════════════════════
   Blended margin FALLS while margin rises in every single segment, because
   volume shifts toward the low-margin segment. A tool that reports the
   headline alone gives the reader a false picture. */
export function simpsonsParadox({ seed = 23 } = {}) {
  const r = rng(seed);
  const rows = [];
  // Period 1: mostly high-margin Enterprise.  Period 2: mostly low-margin SMB.
  const plan = [
    { y: 2025, mo: 1, mix: { Enterprise: 700, SMB: 300 }, margin: { Enterprise: 0.40, SMB: 0.10 } },
    { y: 2025, mo: 2, mix: { Enterprise: 700, SMB: 300 }, margin: { Enterprise: 0.40, SMB: 0.10 } },
    { y: 2025, mo: 3, mix: { Enterprise: 700, SMB: 300 }, margin: { Enterprise: 0.40, SMB: 0.10 } },
    // Both segment margins RISE, but Enterprise volume collapses.
    { y: 2025, mo: 4, mix: { Enterprise: 150, SMB: 850 }, margin: { Enterprise: 0.44, SMB: 0.14 } },
  ];
  let id = 0;
  for (const p of plan) {
    for (const seg of Object.keys(p.mix)) {
      for (let i = 0; i < p.mix[seg]; i++) {
        rows.push([
          `ORD-${id++}`, dateStr(p.y, p.mo, 1 + Math.floor(r() * 28)), seg,
          Math.max(1, Math.round(normal(r, 500, 80))),
          +Math.max(0, normal(r, p.margin[seg], 0.02)).toFixed(4),
        ]);
      }
    }
  }
  return {
    csv: toCSV(["order_id", "order_date", "segment", "revenue", "margin_rate"], rows),
    truth: { measure: "margin_rate", dim: "segment",
      expect: "blended rate falls while both segment rates rise; mix effect must dominate and oppose",
      note: "Simpson's paradox" },
  };
}

/* ═══ 4. SMALL-SAMPLE TRAP ════════════════════════════════════════════════
   A tiny region with 4 rows swings 400%. v7's scoring gave |drop| a weight of
   3.0 with no support guard, so this outranked everything real. */
export function smallSampleTrap({ months = 14, perMonth = 800, seed = 31 } = {}) {
  const r = rng(seed);
  const regions = ["North", "South", "East", "West"];
  const rows = [];
  let id = 0;
  for (let m = 0; m < months; m++) {
    const y = 2024 + Math.floor(m / 12), mo = (m % 12) + 1;
    for (let i = 0; i < perMonth; i++) {
      rows.push([`ORD-${id++}`, dateStr(y, mo, 1 + Math.floor(r() * 28)),
        regions[Math.floor(r() * regions.length)],
        Math.max(1, Math.round(normal(r, 500, 100)))]);
    }
    // Antarctica: 2 rows a month, wildly variable. Pure noise, huge percentages.
    const spike = m === months - 1 ? 9 : 1;
    for (let i = 0; i < 2; i++) {
      rows.push([`ORD-${id++}`, dateStr(y, mo, 1 + Math.floor(r() * 28)), "Antarctica",
        Math.max(1, Math.round(normal(r, 400 * spike, 100)))]);
    }
  }
  return {
    csv: toCSV(["order_id", "order_date", "region", "revenue"], rows),
    truth: { trap: "Antarctica", rowsPerPeriod: 2,
      note: "must NOT be reported — 2 rows a period cannot support a claim" },
  };
}

/* ═══ 5. GENUINE TEMPORAL BREAK ═══════════════════════════════════════════
   West drops 45% in the final month after 20 stable months, on thousands of
   rows. This one SHOULD be found. */
export function temporalBreak({ months = 21, perMonth = 1200, seed = 47 } = {}) {
  const r = rng(seed);
  const regions = ["North", "South", "East", "West"];
  const channels = ["Web", "Retail", "Partner"];
  const rows = [];
  let id = 0;
  for (let m = 0; m < months; m++) {
    const y = 2024 + Math.floor(m / 12), mo = (m % 12) + 1;
    const last = m === months - 1;
    for (let i = 0; i < perMonth; i++) {
      const region = regions[Math.floor(r() * regions.length)];
      const channel = channels[Math.floor(r() * channels.length)];
      // The break is concentrated in West x Partner — a cross-cell story.
      let mult = 1;
      if (last && region === "West") mult = channel === "Partner" ? 0.15 : 0.85;
      rows.push([`ORD-${id++}`, dateStr(y, mo, 1 + Math.floor(r() * 28)),
        region, channel, Math.max(1, Math.round(normal(r, 500, 90) * mult))]);
    }
  }
  return {
    csv: toCSV(["order_id", "order_date", "region", "channel", "revenue"], rows),
    truth: { dim: "region", value: "West", crossDim: "channel", crossValue: "Partner",
      measure: "revenue", note: "45% drop concentrated in West x Partner in the final month" },
  };
}

/* ═══ 6. SCALE + PATHOLOGY ════════════════════════════════════════════════
   Big enough to have crashed v7's profiler (Math.min spread), with a second
   date column that appears FIRST and would have hijacked the time axis. */
export function scaleAndPathology({ rows: n = 200000, seed = 59 } = {}) {
  const r = rng(seed);
  const regions = ["North", "South", "East", "West", "Central", "Nordics"];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const m = Math.floor(r() * 24);
    const y = 2024 + Math.floor(m / 12), mo = (m % 12) + 1;
    // signup_date comes first in column order and covers only 40% of rows.
    const hasSignup = r() < 0.4;
    rows.push([
      hasSignup ? dateStr(2020 + Math.floor(r() * 3), 1 + Math.floor(r() * 12), 1 + Math.floor(r() * 28)) : "",
      `ORD-${i}`,
      dateStr(y, mo, 1 + Math.floor(r() * 28)),
      regions[Math.floor(r() * regions.length)],
      Math.max(1, Math.round(normal(r, 500, 120))),
      +Math.max(0, Math.min(1, normal(r, 0.32, 0.05))).toFixed(4),
    ]);
  }
  return {
    csv: toCSV(["signup_date", "order_id", "order_date", "region", "revenue", "margin_pct"], rows),
    truth: { rows: n, expectTimeCol: "order_date", decoyTimeCol: "signup_date",
      expectAvgMeasure: "margin_pct",
      note: "200k rows (v7 crashed here); decoy date column first; a rate that must not be summed" },
  };
}

/* ═══ 7. FORECASTABLE vs UNFORECASTABLE ═══════════════════════════════════ */
export function trendySeries({ months = 30, seed = 71, trend = 40 } = {}) {
  const r = rng(seed);
  const rows = [];
  let id = 0;
  for (let m = 0; m < months; m++) {
    const y = 2023 + Math.floor(m / 12), mo = (m % 12) + 1;
    const base = 400 + trend * m;
    for (let i = 0; i < 300; i++) {
      rows.push([`ORD-${id++}`, dateStr(y, mo, 1 + Math.floor(r() * 28)),
        ["A", "B", "C", "D"][Math.floor(r() * 4)],
        Math.max(1, Math.round(normal(r, base, 40)))]);
    }
  }
  return {
    csv: toCSV(["order_id", "order_date", "product", "revenue"], rows),
    truth: { trend, note: "strong linear trend — Holt should beat naive (MASE < 1)" },
  };
}

export function randomWalkSeries({ months = 30, seed = 83 } = {}) {
  const r = rng(seed);
  const rows = [];
  let id = 0;
  let level = 500;
  for (let m = 0; m < months; m++) {
    const y = 2023 + Math.floor(m / 12), mo = (m % 12) + 1;
    level += normal(r, 0, 60); // random walk: naive is optimal by construction
    for (let i = 0; i < 300; i++) {
      rows.push([`ORD-${id++}`, dateStr(y, mo, 1 + Math.floor(r() * 28)),
        ["A", "B", "C", "D"][Math.floor(r() * 4)],
        Math.max(1, Math.round(normal(r, level, 40)))]);
    }
  }
  return {
    csv: toCSV(["order_id", "order_date", "product", "revenue"], rows),
    truth: { note: "random walk — naive is the optimal forecast, so MASE should be near or above 1" },
  };
}
