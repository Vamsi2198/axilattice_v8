import { T, fmtSci, evidenceTier } from "./tokens.js";

/* ═══════════════════════════════════════════════════════════════════════════
   PROVENANCE FOOTER
   ───────────────────────────────────────────────────────────────────────────
   One line under every answer, always the same fields in the same order, so a
   reader learns to scan it once and then reads it for free:

     Source · Test · Data hash · Agent version · Freshness · Context

   The Source field deserves a note. The reference footer distinguishes
   "semantic layer | governed table | raw exploration", which is a claim about
   how trustworthy the QUERY was. Here the equivalent distinction is how
   trustworthy the CLAIM is, which is a different axis: a Scan result that
   survived multiple-comparison correction and a raw breakdown with no test at
   all are both "the engine", but you should believe them very differently.

   So Source names the agent AND the evidence tier, and the tier drives the
   colour. A raw lookup renders grey and says "no test" rather than borrowing
   the authority of the cards around it.
   ═══════════════════════════════════════════════════════════════════════════ */

function Field({ label, children, color, title }) {
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "baseline", gap: 4, whiteSpace: "nowrap" }}>
      <span style={{ color: T.textFaint }}>{label}:</span>
      <span style={{ color: color || T.textMid }}>{children}</span>
    </span>
  );
}

function Sep() {
  return <span style={{ color: T.textFaint, padding: "0 2px" }}>·</span>;
}

/** Compact statement of the test, or an honest statement of its absence. */
function testText(ev) {
  if (!ev) return "none — raw cube lookup";
  const name = (ev.test || "unknown").replace(/-/g, " ");
  const parts = [name];
  if (ev.statistic != null) parts.push(`= ${fmtSci(ev.statistic)}`);
  if (ev.p != null) {
    parts.push(ev.p < 0.001 ? "· p < 0.001" : `· p = ${fmtSci(ev.p)}`);
    if (ev.q != null) parts.push(ev.q < 0.001 ? "· q < 0.001" : `· q = ${fmtSci(ev.q)}`);
  } else {
    parts.push("· no p-value applies");
  }
  return parts.join(" ");
}

export function ProvenanceFooter({ card, record, skill, narration, freshness, wrap = true }) {
  const ev = card.evidence;
  const tier = evidenceTier(ev);
  const dataHash = record?.dataset?.contentHash || skill?.dataset?.contentHash;
  const agentVersion = record?.engine?.insights || "insights/1.0.0";
  const ctxIds = narration?.contextUsed || [];

  return (
    <div style={{
      fontFamily: T.mono, fontSize: 9.5, lineHeight: 1.9, color: T.textMid,
      display: "flex", flexWrap: wrap ? "wrap" : "nowrap", alignItems: "baseline",
      gap: 3, paddingTop: 9, borderTop: `1px solid ${T.border}`,
      overflowX: wrap ? "visible" : "auto",
    }}>
      <Field label="Source" color={tier.color}
        title="Which agent produced this, and how far the evidence goes">
        {card.agent ? `${card.agent} agent` : "raw lookup"} <span style={{ opacity: 0.75 }}>({tier.label.toLowerCase()})</span>
      </Field>
      <Sep />
      <Field label="Test" title="The statistical test behind the claim">{testText(ev)}</Field>
      <Sep />
      <Field label="Data hash" title={dataHash ? `${record?.dataset?.contentHashAlgo || "hash"}: ${dataHash}` : "not yet recorded"}>
        {dataHash ? dataHash.slice(0, 6) : "—"}
      </Field>
      <Sep />
      <Field label="Engine" title="Version stamp of the analysis code">{agentVersion}</Field>
      <Sep />
      <Field label="Freshness" title="Latest date present in the dataset, not the time this ran">
        {freshness || "—"}
      </Field>
      {skill && (
        <>
          <Sep />
          <Field label="Skill" title={`Auto-generated dataset skill · ${skill.gotchas.length} gotcha(s)`}>
            {(skill.skillHash || "").slice(0, 6)}
          </Field>
        </>
      )}
      <Sep />
      <Field label="Context"
        color={ctxIds.length ? T.cyan : T.textFaint}
        title={ctxIds.length
          ? `Consulted: ${ctxIds.join(", ")}`
          : "No context document entry was time-aligned with this finding"}>
        {ctxIds.length ? `${ctxIds.length} entry${ctxIds.length === 1 ? "" : "s"}` : "none"}
      </Field>
      {narration && narration.source !== "deterministic" && (
        <>
          <Sep />
          <Field label="Narration"
            color={narration.source === "llm" ? T.purple : T.amber}
            title={narration.reason || "Model-written prose, every number verified against the engine"}>
            {narration.source === "llm" ? "model, numbers verified" : "model output rejected"}
          </Field>
        </>
      )}
    </div>
  );
}
