/* Design tokens. The palette carries over from v7 so the product still looks
   like itself; what is new is the type role for evidence.

   The signature element of v8 is the EVIDENCE STRIP — a monospaced line under
   every claim reading test · statistic · p · q · n, set like a lab notation.
   It is the one place the interface raises its voice, because it is the one
   thing this product does that a dashboard does not. Everything around it
   stays quiet. */

export const T = {
  bg0: "#06070a", bg1: "#0c0e14", bg2: "#11141d", bg3: "#161a25", bg4: "#1b2030",
  border: "#1c2133", borderHi: "#28304a",
  amber: "#f59e0b", amberDim: "#78490a", amberGlow: "#f59e0b22",
  blue: "#3b82f6", green: "#10b981", red: "#ef4444",
  purple: "#8b5cf6", cyan: "#06b6d4", pink: "#ec4899",
  text: "#e2e8f0", textMid: "#8892a4", textDim: "#3d4a60", textFaint: "#1e2535",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
  sans: "'Syne', system-ui, -apple-system, sans-serif",
};

export const PALETTE = [T.amber, T.blue, T.green, T.purple, T.cyan, T.pink, "#f97316", "#a3e635"];

export const CLASS_COLOR = {
  temporal: T.cyan,
  behavioral: T.blue,
  interaction: T.purple,
  spatial: T.green,
};

/* Evidence tiers drive one colour decision across the whole app, so a reader
   learns the vocabulary once. */
/* Priority tiers for the connect feed. The colour carries the evidence
   standard, so a reader learns the vocabulary once and it holds everywhere. */
export const PRIORITY = {
  high:   { color: T.red,     label: "HIGH",   note: "survives correction at q ≤ 0.01 with a material effect" },
  medium: { color: T.amber,   label: "MEDIUM", note: "survives correction at q ≤ 0.10" },
  low:    { color: T.textMid, label: "LOW",    note: "does not clear correction, or carries no applicable test" },
};

export const TIER = {
  strong:      { color: T.green,   label: "SURVIVES CORRECTION" },
  weak:        { color: T.amber,   label: "LOW POWER" },
  descriptive: { color: T.textMid, label: "DESCRIPTIVE ONLY" },
  none:        { color: T.textDim, label: "NO TEST" },
};

export function evidenceTier(ev) {
  if (!ev) return TIER.none;
  if (ev.descriptiveOnly || ev.p == null) return TIER.descriptive;
  if (ev.lowPower) return TIER.weak;
  return TIER.strong;
}

export function fmtKpi(v) {
  if (v == null || Number.isNaN(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (a > 0 && a < 0.01) return v.toExponential(2);
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function fmtSci(v, digits = 3) {
  if (v == null || Number.isNaN(v)) return "—";
  if (v === 0) return "0";
  if (Math.abs(v) < 1e-4 || Math.abs(v) >= 1e5) return v.toExponential(digits - 1);
  return v.toFixed(digits);
}

export const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@300;400;500;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  /* The deployed build scrolled sideways on a phone and iOS then inflated the
     type to match the wider layout, so every screen read as zoomed-in with
     text clipped at both edges. Three causes, all fixed here: unbounded
     document width, iOS text auto-inflation, and long hashes that refuse to
     wrap. */
  html,body{max-width:100%;overflow-x:hidden;-webkit-text-size-adjust:100%;text-size-adjust:100%}
  body{background:${T.bg0};-webkit-font-smoothing:antialiased}
  /* Flex and grid children default to min-width:auto, which lets a long
     unbroken string push a card wider than the screen. */
  .ax-card,.ax-cell{min-width:0;max-width:100%}
  .ax-wrap{overflow-wrap:anywhere;word-break:break-word;min-width:0}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  @keyframes mic-ring{0%,100%{box-shadow:0 0 0 4px ${T.amber}22}50%{box-shadow:0 0 0 12px ${T.amber}08}}
  @keyframes slidein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  ::-webkit-scrollbar{width:5px;height:5px}
  ::-webkit-scrollbar-track{background:${T.bg1}}
  ::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px}
  button:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{
    outline:2px solid ${T.amber};outline-offset:2px}
  @media (prefers-reduced-motion: reduce){
    *{animation-duration:.001ms !important;animation-iteration-count:1 !important;transition-duration:.001ms !important}
  }
`;
