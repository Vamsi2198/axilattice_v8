import { useState, useRef } from "react";
import { T } from "./tokens.js";

const SEV_COLOR = { high: T.red, medium: T.amber, low: T.textMid };

function Label({ children }) {
  return (
    <div style={{ fontSize: 9, letterSpacing: "2px", textTransform: "uppercase",
      color: T.textDim, fontWeight: 600, marginBottom: 10 }}>{children}</div>
  );
}

function download(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ═══ SKILL PANEL ════════════════════════════════════════════════════════ */
export function SkillPanel({ skill }) {
  const [tab, setTab] = useState("gotchas");
  if (!skill) return <div style={{ fontSize: 11, color: T.textFaint }}>No skill generated yet.</div>;

  const highs = skill.gotchas.filter((g) => g.severity === "high").length;

  return (
    <div>
      <Label>Dataset skill</Label>
      <div style={{ fontSize: 10.5, color: T.textMid, lineHeight: 1.65, marginBottom: 12 }}>
        Generated from schema profiling on load, not written by hand — so it cannot drift from
        the data. Regenerates whenever you change the time axis or an aggregation.
      </div>

      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {[["gotchas", `Gotchas ${skill.gotchas.length}`], ["patterns", "Patterns"], ["limits", "Limits"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            style={{ flex: 1, padding: "5px 3px", borderRadius: 5, cursor: "pointer", fontSize: 10,
              border: `1px solid ${tab === id ? `${T.amber}50` : T.border}`,
              background: tab === id ? T.amberGlow : "transparent",
              color: tab === id ? T.amber : T.textMid, fontFamily: T.sans }}>{label}</button>
        ))}
      </div>

      {tab === "gotchas" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {highs > 0 && (
            <div style={{ fontSize: 10, color: T.red, marginBottom: 2 }}>
              {highs} high-severity item{highs === 1 ? "" : "s"} — read these before trusting a number.
            </div>
          )}
          {skill.gotchas.length === 0 && (
            <div style={{ fontSize: 11, color: T.textFaint, lineHeight: 1.7 }}>
              Nothing detected. This file profiled cleanly: one unambiguous time axis, no
              unparseable dates, every dimension large enough to test, no cells below the support floor.
            </div>
          )}
          {skill.gotchas.map((g) => (
            <div key={g.id} style={{ background: T.bg2, borderLeft: `2px solid ${SEV_COLOR[g.severity]}`,
              borderRadius: "0 5px 5px 0", padding: "8px 10px" }}>
              <div style={{ fontFamily: T.mono, fontSize: 8, letterSpacing: "1px",
                color: SEV_COLOR[g.severity], marginBottom: 4 }}>{g.severity.toUpperCase()}</div>
              <div style={{ fontSize: 10.5, color: T.textMid, lineHeight: 1.6 }}
                dangerouslySetInnerHTML={{ __html: mdInline(g.text) }} />
            </div>
          ))}
        </div>
      )}

      {tab === "patterns" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {skill.patterns.map((p) => (
            <div key={p.q} style={{ background: T.bg2, border: `1px solid ${T.border}`,
              borderRadius: 5, padding: "8px 10px" }}>
              <div style={{ fontSize: 11, color: p.works ? T.text : T.textDim, marginBottom: 3 }}>
                {p.works ? "✓" : "✕"} {p.q}
              </div>
              <div style={{ fontSize: 10, color: T.textFaint, lineHeight: 1.55 }}>{p.why}</div>
            </div>
          ))}
        </div>
      )}

      {tab === "limits" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {skill.limits.map((l, i) => (
            <div key={i} style={{ fontSize: 10.5, color: T.textMid, lineHeight: 1.65 }}
              dangerouslySetInnerHTML={{ __html: mdInline(l) }} />
          ))}
        </div>
      )}

      <button onClick={() => download(`skill-${skill.dataset.fileName}.md`, skill.markdown, "text/markdown")}
        style={{ width: "100%", marginTop: 14, padding: "8px", borderRadius: 5, cursor: "pointer",
          border: `1px solid ${T.borderHi}`, background: "transparent", color: T.textMid,
          fontFamily: T.sans, fontSize: 11 }}>
        Export skill as markdown
      </button>
      <div style={{ fontFamily: T.mono, fontSize: 8.5, color: T.textFaint, marginTop: 8,
        wordBreak: "break-all" }}>
        skill {skill.skillHash?.slice(0, 24)}…
      </div>
    </div>
  );
}

/* Minimal inline markdown: backticks and bold only. Input is engine-generated,
   never user text, so there is nothing to escape from an untrusted source. */
function mdInline(t) {
  return t
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, `<code style="color:${T.amber};font-family:${T.mono};font-size:9.5px">$1</code>`)
    .replace(/\*\*([^*]+)\*\*/g, `<strong style="color:${T.text}">$1</strong>`);
}

/* ═══ CONTEXT PANEL ══════════════════════════════════════════════════════ */
export function ContextPanel({ context, onAttach, onClear, busy }) {
  const [paste, setPaste] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const fileRef = useRef(null);

  return (
    <div>
      <Label>Business context</Label>
      <div style={{ fontSize: 10.5, color: T.textMid, lineHeight: 1.65, marginBottom: 12 }}>
        The cube knows what moved. It cannot know that the Partner API was down for nine days,
        because that is not in the CSV. Attach release notes, an incident log or a roadmap and
        entries dated in or just before a finding's period are surfaced beside it — as candidates,
        never as cause.
      </div>

      {!context ? (
        <>
          <input ref={fileRef} type="file" accept=".md,.txt,.csv,.log,text/*" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onAttach(f); }} />
          <button onClick={() => fileRef.current?.click()} disabled={busy}
            style={{ width: "100%", padding: "9px", borderRadius: 5, cursor: "pointer", border: "none",
              background: T.amber, color: T.bg0, fontFamily: T.sans, fontSize: 11.5, fontWeight: 700,
              opacity: busy ? 0.5 : 1 }}>
            Attach a document
          </button>
          <button onClick={() => setShowPaste((s) => !s)}
            style={{ width: "100%", marginTop: 6, padding: "7px", borderRadius: 5, cursor: "pointer",
              border: `1px solid ${T.border}`, background: "transparent", color: T.textMid,
              fontFamily: T.sans, fontSize: 11 }}>
            {showPaste ? "Cancel" : "Or paste text"}
          </button>
          {showPaste && (
            <>
              <textarea value={paste} onChange={(e) => setPaste(e.target.value)}
                placeholder={"- 2025-09-14: Partner API outage, 9 days\n- 2025-09-01: Price increase in West\n\nDates in any common format. Bullets and headings are read as separate entries."}
                rows={7}
                style={{ width: "100%", marginTop: 8, background: T.bg3, border: `1px solid ${T.border}`,
                  borderRadius: 5, padding: 9, color: T.text, fontFamily: T.mono, fontSize: 10.5,
                  outline: "none", resize: "vertical", lineHeight: 1.5 }} />
              <button onClick={() => { onAttach(paste, "pasted notes"); setPaste(""); setShowPaste(false); }}
                disabled={!paste.trim()}
                style={{ width: "100%", marginTop: 6, padding: "8px", borderRadius: 5,
                  cursor: "pointer", border: "none", background: T.amber, color: T.bg0,
                  fontFamily: T.sans, fontSize: 11, fontWeight: 700, opacity: paste.trim() ? 1 : 0.4 }}>
                Index this text
              </button>
            </>
          )}
        </>
      ) : (
        <>
          <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 6,
            padding: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: T.text, marginBottom: 5 }}>{context.fileName}</div>
            <div style={{ fontSize: 10, color: T.textMid, lineHeight: 1.6 }}>
              {context.entryCount} entries · {context.datedCount} carry a date
            </div>
            {context.datedCount === 0 && (
              <div style={{ fontSize: 10, color: T.amber, marginTop: 6, lineHeight: 1.55 }}>
                No dates found. Undated entries can still match on names, but they will never
                rank above a dated one, so retrieval here will be weak. Adding dates fixes it.
              </div>
            )}
            <div style={{ fontFamily: T.mono, fontSize: 8.5, color: T.textFaint, marginTop: 6,
              wordBreak: "break-all" }}>
              {context.docHash?.slice(0, 24)}…
            </div>
          </div>
          <button onClick={onClear}
            style={{ width: "100%", padding: "7px", borderRadius: 5, cursor: "pointer",
              border: `1px solid ${T.border}`, background: "transparent", color: T.textMid,
              fontFamily: T.sans, fontSize: 11 }}>
            Detach
          </button>
        </>
      )}
    </div>
  );
}

/* ═══ CONTEXT HITS — shown inside a card ═════════════════════════════════ */
export function ContextHits({ hits, period }) {
  if (!hits?.length) return null;
  return (
    <div style={{ background: `${T.cyan}0a`, border: `1px solid ${T.cyan}28`, borderRadius: 7,
      padding: "10px 12px", marginTop: 4 }}>
      <div style={{ fontSize: 8.5, letterSpacing: "1.4px", textTransform: "uppercase",
        color: T.cyan, fontWeight: 700, marginBottom: 7 }}>
        Time-aligned context · not tested, not causal
      </div>
      {hits.map((h) => (
        <div key={h.id} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: T.textMid, lineHeight: 1.6 }}>
            {h.heading && <span style={{ color: T.text }}>{h.heading} — </span>}
            {h.text.replace(/\s+/g, " ").slice(0, 260)}{h.text.length > 260 ? "…" : ""}
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 9, color: T.textFaint, marginTop: 3 }}>
            {h.source} · {h.reasons.join(" · ")}
          </div>
        </div>
      ))}
      <div style={{ fontSize: 9.5, color: T.textDim, lineHeight: 1.55, marginTop: 2 }}>
        Retrieved because {hits.length === 1 ? "this entry sits" : "these entries sit"} in or just
        before {period}. Sharing a date with a change is not evidence of causing it.
      </div>
    </div>
  );
}
