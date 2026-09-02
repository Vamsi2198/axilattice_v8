import { useState, useMemo } from "react";
import { T, CLASS_COLOR, PRIORITY, evidenceTier, fmtKpi, fmtSci } from "./tokens.js";
import { SafeChart, renderChart, Delta } from "./Charts.js";
import { ProvenanceFooter } from "./ProvenanceFooter.js";
import { ContextHits } from "./ContextPanel.js";

/* ═══════════════════════════════════════════════════════════════════════════
   EVIDENCE STRIP — the signature element.

   Every claim in this product carries its test on its face, in one
   monospaced line, in the same order every time:

       grubbs · G 3.41 · p 4.2e-05 · q 0.003 · n 12,480

   A dashboard shows you a number. This shows you the number and what it rests
   on, without a click. The colour of the left rule is the only status
   vocabulary in the app: green survived correction, amber has low power, grey
   is descriptive and carries no p-value at all.
   ═══════════════════════════════════════════════════════════════════════════ */
export function EvidenceStrip({ evidence, audit, compact }) {
  const tier = evidenceTier(evidence);
  if (!evidence && !audit) return null;

  const parts = [];
  if (evidence?.test) parts.push(evidence.test.replace(/-/g, " "));
  if (evidence?.statistic != null) parts.push(`stat ${fmtSci(evidence.statistic)}`);
  if (evidence?.p != null) parts.push(`p ${fmtSci(evidence.p)}`);
  if (evidence?.q != null) parts.push(`q ${fmtSci(evidence.q)}`);
  if (evidence?.n != null) parts.push(`n ${evidence.n.toLocaleString()}`);
  if (evidence?.members != null) parts.push(`${evidence.members} members`);
  if (!parts.length && audit) parts.push(`${audit.testsRun} tests · ${audit.survived} survived`);

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      borderLeft: `2px solid ${tier.color}`, paddingLeft: 9,
      marginTop: compact ? 6 : 10, flexWrap: "wrap", minWidth: 0,
    }}>
      <span style={{ fontFamily: T.mono, fontSize: 8, fontWeight: 600, letterSpacing: "0.8px",
        color: tier.color, whiteSpace: "nowrap" }}>{tier.label}</span>
      <span className="ax-wrap" style={{ fontFamily: T.mono, fontSize: 10, color: T.textMid,
        minWidth: 0, flex: 1 }}>
        {parts.join(" · ")}
      </span>
    </div>
  );
}

/* ─── PROOF DRAWER ───────────────────────────────────────────────────────── */

function Row({ k, v, mono = true, color }) {
  if (v == null || v === "") return null;
  return (
    <div style={{ display: "flex", gap: 8, padding: "4px 0", borderBottom: `1px solid ${T.border}`,
      minWidth: 0, alignItems: "baseline" }}>
      <span style={{ fontSize: 9.5, color: T.textDim, width: 92, flexShrink: 0,
        letterSpacing: "0.4px", textTransform: "uppercase", lineHeight: 1.4 }}>{k}</span>
      {/* flex children default to min-width:auto; without the override a
          64-character hash makes this row wider than the phone. */}
      <span className="ax-wrap" style={{ flex: 1, minWidth: 0, fontSize: 10.5,
        color: color || T.textMid, fontFamily: mono ? T.mono : T.sans, lineHeight: 1.5 }}>{v}</span>
    </div>
  );
}

export function ProofDrawer({ card, record, onVerify, verification }) {
  const e = card.evidence;
  const a = card.audit;
  return (
    <div className="ax-card" style={{ background: T.bg1, border: `1px solid ${T.borderHi}`,
      borderRadius: 8, padding: 12, marginTop: 12, minWidth: 0, maxWidth: "100%",
      overflow: "hidden", animation: "slidein .18s ease-out" }}>
      <div style={{ fontSize: 9, letterSpacing: "2px", textTransform: "uppercase",
        color: T.textDim, fontWeight: 600, marginBottom: 10 }}>How this number was produced</div>

      <Row k="Question" v={card.title} mono={false} />
      <Row k="Agent" v={card.agent} />
      <Row k="Scope" v={`${card.grain} grain · ${card.period}`} />
      <Row k="Measure" v={card.measure} />
      <Row k="Aggregation" v={card.aggNote} mono={false} />

      {e ? (
        <>
          <Row k="Test" v={e.test} />
          <Row k="Statistic" v={e.statistic != null ? fmtSci(e.statistic, 6) : null} />
          <Row k="p-value" v={e.p != null ? fmtSci(e.p, 6) : "not applicable"} />
          <Row k="q-value (BH)" v={e.q != null ? fmtSci(e.q, 6) : null}
            color={e.q != null && e.q <= 0.1 ? T.green : T.amber} />
          <Row k="Effect size" v={e.effect != null ? `${fmtSci(e.effect)} SD` : "not reported"} />
          <Row k="Rows behind it" v={e.n != null ? e.n.toLocaleString() : null} />
          {e.descriptiveOnly && (
            <Row k="Caveat" mono={false} color={T.amber}
              v="Descriptive only. No significance test applies to this quantity, so treat it as an effect size and not as evidence." />
          )}
          {e.lowPower && (
            <Row k="Caveat" mono={false} color={T.amber}
              v={`Few members (${e.members}). The test has limited power here — absence of a finding is not evidence of absence.`} />
          )}
        </>
      ) : (
        <Row k="Test" v="none — this card reports a decomposition or a raw lookup, not a hypothesis test" mono={false} />
      )}

      {a && (
        <>
          <div style={{ height: 10 }} />
          <Row k="Tests run" v={a.testsRun?.toLocaleString()} />
          <Row k="Survived" v={`${a.survived} at q ≤ ${a.fdrQ}`} />
          <Row k="Correction" v="Benjamini-Hochberg false discovery rate" />
          <Row k="Support floor" v={`≥ ${a.supportFloor?.minCellRows} rows and ≥ ${(a.supportFloor?.minShare * 100).toFixed(1)}% share`} />
          {a.untestableGroups > 0 && (
            <Row k="Not testable" mono={false}
              v={`${a.untestableGroups} group(s) could not be tested. ${a.untestableReasons?.[0] || ""}`} />
          )}
          <Row k="Without correction" mono={false} color={T.textDim}
            v={`About ${Math.round((a.testsRun || 0) * 0.05)} of these cells would look significant at p < 0.05 by chance alone. That is what the correction removes.`} />
        </>
      )}

      {card.narration && (
        <>
          <div style={{ height: 10 }} />
          <Row k="Narration" v={card.narration.source} />
          {card.narration.reason && (
            <Row k="Narration note" v={card.narration.reason} mono={false} color={T.amber} />
          )}
          <Row k="Numbers checked" v={`${card.narration.guard?.checked ?? 0} — all verified against engine output`} mono={false} />
        </>
      )}

      {card.contextHits?.length > 0 && (
        <>
          <div style={{ height: 10 }} />
          {card.contextHits.map((h) => (
            <Row key={h.id} k={`Context ${h.id}`} mono={false}
              v={`${h.source}${h.dates.length ? ` (${h.dates.join(", ")})` : ""} — matched: ${h.reasons.join("; ")}`} />
          ))}
          <Row k="Context caveat" mono={false} color={T.amber}
            v="Retrieved by date alignment and name match. The engine ran no test on this and it is not part of any p-value above." />
        </>
      )}

      {record && (
        <>
          <div style={{ height: 10 }} />
          <Row k="Dataset" v={`${record.dataset.fileName} · ${record.dataset.rows.toLocaleString()} rows`} />
          <Row k="Skill" v={record.skillHash ? `${record.skillHash.slice(0, 24)}…` : null} />
          <Row k="Content hash" v={`${record.dataset.contentHashAlgo}: ${record.dataset.contentHash}`} />
          <Row k="Engine" v={Object.values(record.engine).join(" · ")} />
          <Row k="Record" v={record.recordHash} />
          <Row k="Chains to" v={record.chainPrev || "(genesis)"} />
          <Row k="Written" v={record.timestamp} />
        </>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
        {record && (
          <button onClick={() => onVerify(record)}
            style={{ fontSize: 11, padding: "6px 12px", borderRadius: 5, cursor: "pointer",
              border: `1px solid ${T.borderHi}`, background: "transparent", color: T.textMid,
              fontFamily: T.sans }}>
            Re-verify this record
          </button>
        )}
        {verification && (
          <span style={{ fontSize: 11, fontFamily: T.mono,
            color: verification.ok ? T.green : T.red }}>
            {verification.ok ? "✓ hash matches" : "✗ hash mismatch"} — {verification.note}
          </span>
        )}
      </div>

      <div style={{ fontSize: 10, color: T.textDim, marginTop: 10, lineHeight: 1.6 }}>
        The hash proves this record has not been altered since it was written. It is not a
        signature — there is no private key in a browser — so it establishes integrity, not authorship.
      </div>
    </div>
  );
}

/* ─── PRIORITY BADGE ─────────────────────────────────────────────────────── */

export function PriorityBadge({ tier, reason }) {
  if (!tier) return null;
  const p = PRIORITY[tier];
  return (
    <span title={reason || p.note}
      style={{ fontFamily: T.mono, fontSize: 8, fontWeight: 700, letterSpacing: "1px",
        padding: "2px 6px", borderRadius: 3, color: p.color,
        background: `${p.color}18`, border: `1px solid ${p.color}45`, whiteSpace: "nowrap" }}>
      {p.label}
    </span>
  );
}

/* ─── CARD ───────────────────────────────────────────────────────────────── */

export function InsightCard({ card, pinned, onPin, onSpeak, record, onVerify, verification,
                              skill, freshness }) {
  const [showProof, setShowProof] = useState(false);
  const isPinned = pinned.some((p) => p.id === card.id);
  const chart = useMemo(() => renderChart(card), [card]);
  const tier = evidenceTier(card.evidence);

  return (
    <div className="ax-card" style={{ background: T.bg2,
      border: `1px solid ${isPinned ? `${T.amber}55` : T.border}`,
      borderLeft: card.tier ? `3px solid ${PRIORITY[card.tier].color}` : undefined,
      borderRadius: 10, padding: 15, display: "flex", flexDirection: "column", gap: 11,
      minWidth: 0, maxWidth: "100%", overflow: "hidden" }}>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ax-wrap" style={{ fontSize: 13, fontWeight: 600, color: T.text,
            lineHeight: 1.4 }}>{card.title}</div>
          <div style={{ fontSize: 9, color: T.textDim, marginTop: 5, letterSpacing: "0.5px",
            display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <PriorityBadge tier={card.tier} reason={card.tierReason} />
            {card.insightClass && (
              <span style={{ fontSize: 8, letterSpacing: "1px", textTransform: "uppercase", fontWeight: 700,
                padding: "2px 6px", borderRadius: 3,
                color: CLASS_COLOR[card.insightClass] || T.textMid,
                background: `${CLASS_COLOR[card.insightClass] || T.textMid}18`,
                border: `1px solid ${CLASS_COLOR[card.insightClass] || T.textMid}45` }}>
                {card.insightClass}
              </span>
            )}
            {card.agent && (
              <span style={{ fontSize: 8, fontFamily: T.mono, color: T.purple,
                background: `${T.purple}18`, border: `1px solid ${T.purple}40`,
                borderRadius: 3, padding: "2px 6px", letterSpacing: "0.5px" }}>
                {card.agent.toUpperCase()}
              </span>
            )}
            <span>{card.grain?.toUpperCase()} · {card.dimension || "TOTAL"} · {card.measure?.toUpperCase()}</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          <button onClick={() => onPin(card)} aria-label={isPinned ? "Unpin" : "Pin"}
            title={isPinned ? "Unpin" : "Pin to dashboard"}
            style={{ width: 28, height: 28, borderRadius: 5, cursor: "pointer", fontSize: 13,
              border: `1px solid ${isPinned ? T.amber : T.border}`,
              background: isPinned ? T.amber : "transparent", color: isPinned ? T.bg0 : T.textDim,
              display: "flex", alignItems: "center", justifyContent: "center" }}>
            {isPinned ? "◉" : "◎"}
          </button>
          <button onClick={() => onSpeak(card.summary)} aria-label="Read aloud" title="Read aloud"
            style={{ width: 28, height: 28, borderRadius: 5, cursor: "pointer", fontSize: 12,
              border: `1px solid ${T.border}`, background: "transparent", color: T.textDim,
              display: "flex", alignItems: "center", justifyContent: "center" }}>
            ♪
          </button>
        </div>
      </div>

      {card.kpi != null && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
          <span style={{ fontFamily: T.mono, fontSize: 26, fontWeight: 500, color: T.text }}>
            {fmtKpi(card.kpi)}
          </span>
          <Delta value={card.delta} />
        </div>
      )}

      {chart && <SafeChart height={130}>{chart}</SafeChart>}

      {(card.narration?.text || card.summary) && (
        <div className="ax-wrap" style={{ fontSize: 11.5, color: T.textMid, lineHeight: 1.65,
          paddingTop: 9, borderTop: `1px solid ${T.border}` }}>
          {card.narration?.text || card.summary}
        </div>
      )}

      {card.tierReason && (
        <div className="ax-wrap" style={{ fontSize: 10, color: PRIORITY[card.tier]?.color,
          fontFamily: T.mono, lineHeight: 1.5 }}>
          {PRIORITY[card.tier].label} — {card.tierReason}
        </div>
      )}

      {card.corroboration?.length > 0 && (
        <div className="ax-wrap" style={{ fontSize: 10, color: T.textDim, lineHeight: 1.5 }}>
          Also flagged by {card.corroboration.join(" and ").replace(/-/g, " ")} on the same cell.
          These are views of one fact, not independent evidence — they share the data.
        </div>
      )}

      <EvidenceStrip evidence={card.evidence} audit={card.audit} />

      <ContextHits hits={card.contextHits} period={card.period} />

      <button onClick={() => setShowProof((s) => !s)}
        style={{ alignSelf: "flex-start", fontSize: 10, padding: "5px 10px", borderRadius: 4,
          cursor: "pointer", border: `1px solid ${T.border}`, background: "transparent",
          color: tier.color, fontFamily: T.mono, letterSpacing: "0.5px" }}>
        {showProof ? "Hide proof" : "Show proof"}
      </button>

      {showProof && (
        <ProofDrawer card={card} record={record} onVerify={onVerify} verification={verification} />
      )}

      <ProvenanceFooter card={card} record={record} skill={skill}
        narration={card.narration} freshness={freshness} />
    </div>
  );
}

/* ─── AGENT TRACE ────────────────────────────────────────────────────────── */

const PHASE_COLOR = {
  TRAVERSE: T.cyan, TEST: T.blue, CORRECT: T.green, REPORT: T.amber,
  ENUMERATE: T.cyan, QUALIFY: T.blue, LOCATE: T.cyan, DECOMPOSE: T.blue,
  RANK: T.purple, LOCALIZE: T.amber, PAIR: T.cyan, ASSEMBLE: T.cyan,
  FIT: T.blue, BACKTEST: T.green, PROJECT: T.amber, FRAME: T.cyan,
  SPLIT: T.blue, ATTRIBUTE: T.purple, STOP: T.red,
};

export function AgentTrace({ trace, live }) {
  if (!trace?.length) return null;
  return (
    <div style={{ background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 8,
      padding: 14, marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 9, letterSpacing: "2px", textTransform: "uppercase",
          color: T.textDim, fontWeight: 600 }}>Reasoning</span>
        {live && <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.amber,
          animation: "pulse 1s infinite" }} />}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {trace.map((s, i) => (
          <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start",
            animation: "slidein .2s ease-out" }}>
            <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 600, letterSpacing: "1px",
              color: PHASE_COLOR[s.phase] || T.amber, minWidth: 74, paddingTop: 1 }}>
              {s.phase}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: T.text, fontWeight: 500 }}>{s.label}</div>
              <div style={{ fontSize: 11, color: T.textMid, marginTop: 2, lineHeight: 1.55 }}>{s.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
