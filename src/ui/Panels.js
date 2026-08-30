import { useState } from "react";
import { T, PALETTE, fmtKpi } from "./tokens.js";
import { Delta } from "./Charts.js";
import { journalToJSON, journalToMarkdown } from "../provenance.js";

function Label({ children }) {
  return (
    <div style={{ fontSize: 9, letterSpacing: "2px", textTransform: "uppercase",
      color: T.textDim, fontWeight: 600, marginBottom: 10 }}>{children}</div>
  );
}

function selectStyle(active) {
  return {
    background: T.bg2, color: active ? T.amber : T.textMid,
    border: `1px solid ${active ? `${T.amber}55` : T.border}`, borderRadius: 5,
    padding: "5px 8px", fontFamily: T.sans, fontSize: 11, cursor: "pointer",
    outline: "none", width: "100%",
  };
}

/* ═══ SCHEMA PANEL ═══════════════════════════════════════════════════════
   The v7 audit found that the profiler silently picked the first date column
   it saw and silently guessed how each measure aggregates. Both guesses are
   now visible, both are explained, and both can be overridden here. A wrong
   time axis is the single most expensive silent failure in the whole
   pipeline — every number downstream is wrong and nothing looks broken. */
export function SchemaPanel({ profile, warnings, onSetTimeColumn, onSetAggregation, onAsk }) {
  const [open, setOpen] = useState("dims");
  const section = (id, title, body) => (
    <div style={{ marginBottom: 18 }}>
      <button onClick={() => setOpen(open === id ? null : id)}
        style={{ width: "100%", background: "transparent", border: "none", cursor: "pointer",
          padding: 0, textAlign: "left", display: "flex", justifyContent: "space-between",
          alignItems: "center" }}>
        <Label>{title}</Label>
        <span style={{ color: T.textDim, fontSize: 10, marginBottom: 10 }}>{open === id ? "−" : "+"}</span>
      </button>
      {open === id && body}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {warnings?.length > 0 && (
        <div style={{ background: `${T.amber}10`, border: `1px solid ${T.amber}35`,
          borderRadius: 6, padding: 11, marginBottom: 18 }}>
          <div style={{ fontSize: 9, letterSpacing: "1.5px", textTransform: "uppercase",
            color: T.amber, fontWeight: 700, marginBottom: 7 }}>Read this first</div>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 10.5, color: T.textMid, lineHeight: 1.6, marginBottom: 5 }}>
              {w}
            </div>
          ))}
        </div>
      )}

      {section("time", "Time axis", (
        <div>
          <select value={profile.timeCol} onChange={(e) => onSetTimeColumn(e.target.value)}
            style={selectStyle(true)}>
            {[profile.timeCol, ...profile.timeAlternatives.map((a) => a.col)].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <div style={{ fontSize: 10, color: T.textDim, marginTop: 7, lineHeight: 1.6 }}>
            {profile.timeChoiceReason || "Only one date column in this file."}
          </div>
          {profile.timeAlternatives.map((a) => (
            <div key={a.col} style={{ fontSize: 10, color: T.textFaint, marginTop: 4 }}>
              {a.col} — {a.whyNotChosen}
            </div>
          ))}
        </div>
      ))}

      {section("measures", `Measures (${profile.measures.length})`, (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {profile.measures.map((m, i) => (
            <div key={m.col} style={{ background: T.bg2, border: `1px solid ${T.border}`,
              borderRadius: 6, padding: 9 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%",
                  background: PALETTE[i % PALETTE.length], flexShrink: 0 }} />
                <span onClick={() => onAsk(`${m.col} trend`)}
                  style={{ fontSize: 11.5, color: T.text, cursor: "pointer", flex: 1 }}>{m.col}</span>
              </div>
              <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                <span style={{ fontSize: 9, color: T.textDim }}>agg</span>
                <select value={m.agg} onChange={(e) => onSetAggregation(m.col, e.target.value)}
                  style={{ ...selectStyle(false), width: "auto", padding: "3px 6px", fontSize: 10 }}>
                  <option value="sum">SUM</option>
                  <option value="avg">AVG</option>
                </select>
              </div>
              <div style={{ fontSize: 9.5, color: T.textFaint, marginTop: 6, lineHeight: 1.5 }}>
                {m.aggReason}
              </div>
            </div>
          ))}
        </div>
      ))}

      {section("dims", `Dimensions (${profile.dims.length})`, (
        <div>
          {profile.dims.map((d) => (
            <div key={d.col} onClick={() => onAsk(`${profile.measures[0]?.col} by ${d.col}`)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px",
                borderRadius: 5, cursor: "pointer", marginBottom: 2 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = T.bg3)}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
              <span style={{ fontSize: 12, color: T.textDim }}>◈</span>
              <span style={{ fontSize: 11.5, color: T.textMid, flex: 1 }}>{d.col}</span>
              <span style={{ fontSize: 10, color: T.textDim, fontFamily: T.mono }}>{d.cardinality}</span>
            </div>
          ))}
          {profile.excludedDims.length > 0 && (
            <div style={{ fontSize: 10, color: T.textFaint, marginTop: 10, lineHeight: 1.6 }}>
              Excluded for high cardinality: {profile.excludedDims.map((e) => `${e.col} (${e.cardinality})`).join(", ")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ═══ AUDIT PANEL ════════════════════════════════════════════════════════ */
export function AuditPanel({ journal, verification, onVerifyAll, fingerprint }) {
  const download = (name, text, type) => {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div>
      <Label>Audit trail · {journal.entries.length} record{journal.entries.length === 1 ? "" : "s"}</Label>

      {fingerprint && (
        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 6,
          padding: 10, marginBottom: 14 }}>
          <div style={{ fontSize: 10, color: T.textMid, marginBottom: 5 }}>{fingerprint.fileName}</div>
          <div style={{ fontFamily: T.mono, fontSize: 9, color: T.textDim, wordBreak: "break-all",
            lineHeight: 1.5 }}>
            {fingerprint.contentHash.algo} {fingerprint.contentHash.hex.slice(0, 24)}…
          </div>
          <div style={{ fontSize: 9.5, color: T.textFaint, marginTop: 6 }}>
            {fingerprint.rows.toLocaleString()} rows · {fingerprint.columns} columns
          </div>
        </div>
      )}

      {journal.entries.length === 0 ? (
        <div style={{ fontSize: 11, color: T.textFaint, lineHeight: 1.7, padding: "12px 0" }}>
          Every answer writes a record here: the question, the test, the statistic, the p and q
          values, and a hash chaining it to the one before. Ask something to start the chain.
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            {journal.entries.slice().reverse().map((r, i) => (
              <div key={r.recordHash} style={{ background: T.bg2, border: `1px solid ${T.border}`,
                borderRadius: 6, padding: 9 }}>
                <div style={{ fontSize: 10.5, color: T.textMid, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {journal.entries.length - i}. {r.question}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 9, color: T.textDim, marginTop: 4 }}>
                  {r.evidence?.test || "no test"}
                  {r.evidence?.q != null && ` · q ${r.evidence.q.toExponential(1)}`}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 8.5, color: T.textFaint, marginTop: 3 }}>
                  {r.recordHash.slice(0, 16)}…
                </div>
              </div>
            ))}
          </div>

          <button onClick={onVerifyAll}
            style={{ width: "100%", padding: "8px", borderRadius: 5, cursor: "pointer",
              border: `1px solid ${T.borderHi}`, background: "transparent", color: T.textMid,
              fontFamily: T.sans, fontSize: 11, marginBottom: 8 }}>
            Verify the whole chain
          </button>
          {verification && (
            <div style={{ fontSize: 10.5, lineHeight: 1.6, marginBottom: 12,
              color: verification.ok ? T.green : T.red }}>
              {verification.ok
                ? `✓ All ${verification.entries} records verify. Nothing has been altered or removed.`
                : `✗ ${verification.problems.length} problem(s): ${verification.problems.map((p) => p.issue).join(", ")}`}
            </div>
          )}

          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => download("axilattice-audit.md", journalToMarkdown(journal), "text/markdown")}
              style={{ flex: 1, padding: "8px", borderRadius: 5, cursor: "pointer", border: "none",
                background: T.amber, color: T.bg0, fontFamily: T.sans, fontSize: 11, fontWeight: 700 }}>
              Export markdown
            </button>
            <button onClick={() => download("axilattice-audit.json", journalToJSON(journal), "application/json")}
              style={{ flex: 1, padding: "8px", borderRadius: 5, cursor: "pointer",
                border: `1px solid ${T.borderHi}`, background: "transparent", color: T.textMid,
                fontFamily: T.sans, fontSize: 11 }}>
              Export JSON
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ═══ PINNED PANEL ═══════════════════════════════════════════════════════ */
export function PinnedPanel({ pinned, onUnpin }) {
  return (
    <div>
      <Label>Pinned · {pinned.length}</Label>
      {pinned.length === 0 ? (
        <div style={{ fontSize: 11, color: T.textFaint, lineHeight: 1.7, padding: "12px 0" }}>
          Pin a card with ◎ to keep it here while you keep asking.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {pinned.map((p) => (
            <div key={p.id} style={{ background: T.bg2, border: `1px solid ${T.border}`,
              borderRadius: 6, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 4, alignItems: "center" }}>
                <div style={{ fontSize: 11, color: T.textMid, flex: 1, overflow: "hidden",
                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</div>
                <button onClick={() => onUnpin(p.id)} aria-label="Unpin"
                  style={{ width: 18, height: 18, borderRadius: 4, border: `1px solid ${T.border}`,
                    background: "transparent", color: T.textDim, cursor: "pointer", fontSize: 10,
                    display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 13, color: T.amber, marginTop: 4 }}>
                {fmtKpi(p.kpi)}<Delta value={p.delta} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
