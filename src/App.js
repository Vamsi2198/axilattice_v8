import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { T, GLOBAL_CSS, fmtKpi, PRIORITY } from "./ui/tokens.js";
import { UploadScreen } from "./ui/UploadScreen.js";
import { InsightCard, AgentTrace } from "./ui/InsightCard.js";
import { SchemaPanel, AuditPanel, PinnedPanel } from "./ui/Panels.js";
import { SkillPanel, ContextPanel } from "./ui/ContextPanel.js";
import { generateSkill } from "./skill.js";
import { indexContext, retrieveContext } from "./context.js";
import { narrate } from "./narrate.js";
import {
  buildCube, withTimeColumn, withAggregation,
  queryBreakdown, queryTrend, queryTotal, queryTopK,
  resolveGrain, latestPeriod,
} from "./engine/index.js";
import { runAgent, buildFeed } from "./agents.js";
import { parseIntent, suggestions } from "./nlu.js";
import {
  createJournal, appendToJournal, verifyJournal, verifyRecord,
} from "./provenance.js";

/* Deterministic card IDs. v7 used Math.random(), which meant the same question
   produced a different identity every time and nothing could be reconciled
   against an exported record. */
let cardSeq = 0;
const nextCardId = (question) =>
  `c${(++cardSeq).toString(36)}-${question.slice(0, 12).replace(/\W+/g, "").toLowerCase()}`;

function useIsMobile(bp = 860) {
  const [m, setM] = useState(typeof window !== "undefined" && window.innerWidth < bp);
  useEffect(() => {
    const on = () => setM(window.innerWidth < bp);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [bp]);
  return m;
}

function useVoice({ onTranscript }) {
  const recogRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");

  const start = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setError("Voice input needs Chrome or Edge. Typing works everywhere."); return; }
    const r = new SR();
    r.continuous = false; r.interimResults = true; r.lang = navigator.language || "en-US";
    r.onresult = (e) => {
      let final = "", part = "";
      for (const res of e.results) { if (res.isFinal) final += res[0].transcript; else part += res[0].transcript; }
      setInterim(part);
      if (final) { setInterim(""); onTranscript(final.trim()); }
    };
    r.onerror = (e) => { setListening(false); setError(`Voice stopped: ${e.error}`); };
    r.onend = () => { setListening(false); setInterim(""); };
    r.start(); recogRef.current = r; setListening(true); setError("");
  }, [onTranscript]);

  const stop = useCallback(() => { recogRef.current?.stop(); setListening(false); }, []);
  const speak = useCallback((text) => {
    if (!window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.slice(0, 320));
    u.rate = 1.05;
    window.speechSynthesis.speak(u);
  }, []);

  return { listening, interim, error, start, stop, speak };
}

export default function App() {
  const [data, setData] = useState(null);      // { parsed, profile, cube, warnings, fingerprint }
  const [cards, setCards] = useState([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState(null);
  const [traceLive, setTraceLive] = useState(false);
  const [pinned, setPinned] = useState([]);
  /* The journal lives in a ref, not in state.
     It was in state first, and that was a real bug: appendToJournal is async,
     so the write for a scan landed on whichever journal object the callback
     had closed over at render time. Load a second file and the first record of
     the new session chained onto the previous file's hash. The audit trail --
     the one thing in this product that has to be exactly right -- would have
     been quietly wrong. A ref always reads the current object. State holds
     only a version counter, purely to trigger re-render. */
  const journalRef = useRef(createJournal());
  const [journalVersion, setJournalVersion] = useState(0);
  const journal = journalRef.current;
  const [records, setRecords] = useState({});  // cardId -> record
  const [verify, setVerify] = useState({});    // cardId -> verification
  const [chainVerify, setChainVerify] = useState(null);
  const [feedAudit, setFeedAudit] = useState(null);
  const [tierFilter, setTierFilter] = useState("all");
  const dataRef = useRef(null);
  const [skill, setSkill] = useState(null);
  const [context, setContext] = useState(null);
  const contextRef = useRef(null);
  const skillRef = useRef(null);
  const [panel, setPanel] = useState("schema");
  const [mobilePanel, setMobilePanel] = useState(null);
  const [speakOn, setSpeakOn] = useState(false);
  const isMobile = useIsMobile();
  const inputRef = useRef(null);

  const askRef = useRef(null);
  const voice = useVoice({ onTranscript: (t) => { setQuery(t); askRef.current?.(t); } });

  /* ── Load ────────────────────────────────────────────────────────────── */
  const handleReady = useCallback(async (loaded) => {
    setData(loaded);
    dataRef.current = loaded;
    // The skill is generated here, once, from profiling output that already
    // exists. It costs nothing and it is regenerated on any schema override.
    const sk = await generateSkill(loaded);
    skillRef.current = sk; setSkill(sk);
    setCards([]); setPinned([]); setRecords({}); setVerify({});
    journalRef.current = createJournal();   // a new file starts a new chain
    setJournalVersion((v) => v + 1);
    setChainVerify(null);
    // Auto-scan on load. Unlike v7 this can legitimately return nothing, and
    // saying "nothing survived correction" is the useful answer when true.
    runScan(loaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Attach context and narration to a finished card.
     Order matters and is deliberate: the engine has already produced every
     number by the time this runs. Retrieval and narration are strictly
     downstream and can only add prose, never alter a value. */
  const enrich = useCallback(async (card) => {
    const sk = skillRef.current;
    const ctx = contextRef.current;
    let hits = [];
    if (ctx) {
      const ev = card.evidence || {};
      const subjects = [card.measure, card.dimension, ev.value, ev.a, ev.b,
        card.decomposition?.additive?.rows?.[0]?.key,
        card.crossLocalization?.lead?.key].filter(Boolean);
      hits = retrieveContext(ctx, {
        period: card.period, grain: card.grain, subjects, queryText: card.title || "",
      });
    }
    card.contextHits = hits;
    // llm is null by default — see narrate.js. The numeric guard runs either way.
    card.narration = await narrate({ card, skill: sk, contextHits: hits, llm: null });
    return card;
  }, []);

  const writeRecord = useCallback(async (card, loaded) => {
    const src = loaded || dataRef.current;
    if (!src) return null;
    try {
      const rec = await appendToJournal(journalRef.current, {
        dataset: src.fingerprint,
        question: card.title,
        intent: card.intent || null,
        grain: card.grain, period: card.period,
        agent: card.agent || null,
        finding: card.evidence || null,
        audit: card.audit || null,
        result: { summary: card.narration?.text || card.summary, kpi: card.kpi ?? null },
        skillHash: skillRef.current?.skillHash || null,
        context: contextRef.current ? {
          source: contextRef.current.fileName,
          docHash: contextRef.current.docHash,
          entriesConsulted: (card.contextHits || []).map((h) => h.id),
        } : null,
        narration: card.narration || null,
      });
      setJournalVersion((v) => v + 1);
      setRecords((r) => ({ ...r, [card.id]: rec }));
      return rec;
    } catch (e) {
      // A provenance write must never take the answer down with it. The card
      // still renders; the proof drawer simply shows no record.
      console.warn("record write failed:", e);
      return null;
    }
  }, []);

  /* On connect, build the whole ranked feed rather than a single card.
     The engine was already locating dozens of corrected findings; the old
     version dropped all but the top three into a summary paragraph. */
  const runScan = useCallback(async (loaded) => {
    const src = loaded || dataRef.current;
    if (!src) return;
    setBusy(true); setTraceLive(true);
    setTrace([{ phase: "TRAVERSE", label: "Walk the cube",
      detail: `Testing every measure × dimension × cross-cell across ${src.cube.meta.dims.length} dimension(s) and ${src.cube.meta.measures.length} measure(s).` }]);

    // Yield once so the trace paints before the traversal blocks the thread.
    await new Promise((r) => setTimeout(r, 30));
    const { cards: feedCards, audit, tierCounts } = buildFeed(src.cube);

    setTrace((t) => [...(t || []), {
      phase: "CORRECT", label: "Control the false discovery rate",
      detail: `${audit.testsRun} tests run, ${audit.survived} survive Benjamini-Hochberg at q ≤ ${audit.fdrQ}. ` +
        `Without correction roughly ${Math.round(audit.testsRun * 0.05)} cells would look significant by chance alone.`,
    }, {
      phase: "RANK", label: "Sort into priority tiers",
      detail: `${tierCounts.high} high, ${tierCounts.medium} medium, ${tierCounts.low} low. ` +
        `The tier is the evidence standard — nothing is promoted beyond what its statistics support.`,
    }]);
    await new Promise((r) => setTimeout(r, 400));

    setTraceLive(false); setTrace(null); setBusy(false);
    setFeedAudit({ audit, tierCounts });
    setCards(feedCards);
    // Enrich and record progressively so the feed is readable immediately
    // rather than after forty hash computations.
    for (const c of feedCards) { await enrich(c); }
    setCards((p) => [...p]);
    for (const c of feedCards.slice(0, 12)) await writeRecord(c, src);
  }, [writeRecord, enrich]);

  /* ── Ask ─────────────────────────────────────────────────────────────── */
  const handleAsk = useCallback(async (text) => {
    const q = (text ?? query).trim();
    if (!q || !data) return;
    setBusy(true); setQuery(""); setTrace(null);

    const intent = parseIntent(q, data.profile);
    intent.title = q;

    let card;
    if (intent.agent) {
      setTraceLive(true); setTrace([]);
      card = await runAgent(data.cube, intent, setTrace);
      setTraceLive(false); setTrace(null);
    } else {
      card = fastPath(data.cube, intent);
    }
    card.id = nextCardId(q);
    card.title = q;
    card.intent = { agent: intent.agent, measure: intent.measure, dimension: intent.dimension,
      grain: intent.grain, unresolved: intent.unresolved };
    card.aggNote = data.profile.measures.find((m) => m.col === card.measure)?.aggReason;

    await enrich(card);
    setCards((prev) => [card, ...prev]);
    setBusy(false);
    await writeRecord(card);
    const spoken = card.narration?.text || card.summary;
    if (speakOn && spoken) voice.speak(spoken);
  }, [query, data, writeRecord, speakOn, voice, enrich]);
  askRef.current = handleAsk;

  /* ── Schema overrides — rebuild the cube ─────────────────────────────── */
  const rebuild = useCallback(async (nextProfile) => {
    setBusy(true);
    try {
      const cube = await buildCube(nextProfile);
      const next = { ...data, profile: nextProfile, cube };
      setData(next);
      dataRef.current = next;
      // A schema override changes what the data means, so the skill is
      // regenerated rather than patched. Its hash changes with it, which is
      // what makes a stale interpretation visible in the audit trail.
      const sk = await generateSkill(next);
      skillRef.current = sk; setSkill(sk);
      setCards([]);
      await runScan(next);
    } finally { setBusy(false); }
  }, [data, runScan]);

  const onSetTimeColumn = useCallback((col) => {
    if (!data || col === data.profile.timeCol) return;
    rebuild(withTimeColumn(data.profile, col));
  }, [data, rebuild]);

  const onSetAggregation = useCallback((col, agg) => {
    if (!data) return;
    rebuild(withAggregation(data.profile, col, agg));
  }, [data, rebuild]);

  /* ── Verification ────────────────────────────────────────────────────── */
  const onAttachContext = useCallback(async (fileOrText, name) => {
    if (!dataRef.current) return;
    setBusy(true);
    try {
      const text = typeof fileOrText === "string" ? fileOrText : await fileOrText.text();
      const fileName = typeof fileOrText === "string" ? (name || "pasted notes") : fileOrText.name;
      const d = dataRef.current;
      // Subjects are every name a context entry could plausibly refer to.
      const subjects = [
        ...d.cube.meta.dims.map((x) => x.col),
        ...d.cube.meta.dims.flatMap((x) => x.values || []),
        ...d.cube.meta.measures.map((x) => x.col),
      ];
      const idx = await indexContext(text, { fileName, subjects });
      contextRef.current = idx; setContext(idx);
      // Re-enrich the cards already on screen so attaching context is
      // retroactive. Numbers are untouched; only prose and footers change.
      setCards((prev) => {
        Promise.all(prev.map((c) => enrich(c))).then(() => setCards((p) => [...p]));
        return prev;
      });
    } finally { setBusy(false); }
  }, [enrich]);

  const onClearContext = useCallback(() => {
    contextRef.current = null; setContext(null);
    setCards((prev) => {
      Promise.all(prev.map((c) => enrich(c))).then(() => setCards((p) => [...p]));
      return prev;
    });
  }, [enrich]);

  const onVerifyRecord = useCallback(async (rec) => {
    const v = await verifyRecord(rec);
    const cardId = Object.keys(records).find((k) => records[k].recordHash === rec.recordHash);
    if (cardId) setVerify((s) => ({ ...s, [cardId]: v }));
  }, [records]);

  const onVerifyAll = useCallback(async () => {
    setChainVerify(await verifyJournal(journalRef.current));
  }, []);

  const chips = useMemo(() => (data ? suggestions(data.profile) : []), [data]);
  // Freshness is the newest date IN THE DATA, not the time the analysis ran.
  // Those differ, and the one that matters for trusting a number is the former.
  const freshness = skill?.grain?.latest || null;

  if (!data) return <UploadScreen onReady={handleReady} />;

  const { profile: prof, cube } = data;
  const panelBody =
    panel === "schema" ? (
      <SchemaPanel profile={prof} warnings={data.warnings}
        onSetTimeColumn={onSetTimeColumn} onSetAggregation={onSetAggregation}
        onAsk={(q) => { setMobilePanel(null); handleAsk(q); }} />
    ) : panel === "skill" ? (
      <SkillPanel skill={skill} />
    ) : panel === "context" ? (
      <ContextPanel context={context} onAttach={onAttachContext} onClear={onClearContext} busy={busy} />
    ) : panel === "audit" ? (
      <AuditPanel key={journalVersion} journal={journal} verification={chainVerify}
        onVerifyAll={onVerifyAll} fingerprint={data.fingerprint} />
    ) : (
      <PinnedPanel pinned={pinned} onUnpin={(id) => setPinned((p) => p.filter((x) => x.id !== id))} />
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh",
      background: T.bg0, color: T.text, fontFamily: T.sans, maxWidth: "100%", overflowX: "hidden" }}>
      <style>{GLOBAL_CSS}</style>

      {/* HEADER */}
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        maxWidth: "100%", padding: isMobile ? "10px 12px" : "12px 22px", borderBottom: `1px solid ${T.border}`,
        background: T.bg1, position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <span style={{ fontSize: isMobile ? 14 : 17, fontWeight: 800, letterSpacing: "-1px",
            whiteSpace: "nowrap" }}>
            axilattice <span style={{ color: T.amber }}>·</span> v8
          </span>
          {!isMobile && (
            <span style={{ fontFamily: T.mono, fontSize: 9, color: T.textMid,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }}>
              {data.fingerprint.fileName} · {data.fingerprint.contentHash.hex.slice(0, 10)}…
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 10 : 18 }}>
          {!isMobile && [
            { v: cube.meta.rowCount.toLocaleString(), l: "Rows" },
            { v: cube.meta.cellCount.toLocaleString(), l: "Cells" },
            { v: `${cube.meta.buildMs}ms`, l: "Build" },
          ].map(({ v, l }) => (
            <div key={l} style={{ textAlign: "right" }}>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.amber }}>{v}</div>
              <div style={{ fontSize: 8, color: T.textDim, letterSpacing: "1px",
                textTransform: "uppercase" }}>{l}</div>
            </div>
          ))}
          <button onClick={() => { setData(null); dataRef.current = null; }}
            style={{ padding: isMobile ? "6px 10px" : "7px 13px", borderRadius: 5,
              border: `1px solid ${T.border}`, background: "transparent", color: T.textMid,
              fontFamily: T.sans, fontSize: 11, cursor: "pointer" }}>
            {isMobile ? "↩" : "New file"}
          </button>
        </div>
      </header>

      {/* QUERY BAR */}
      <div style={{ padding: isMobile ? "12px 14px 0" : "16px 22px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: T.bg2,
          border: `1px solid ${voice.listening ? T.amber : T.borderHi}`, borderRadius: 10,
          padding: "9px 13px", animation: voice.listening ? "mic-ring 1.5s infinite" : "none" }}>
          <span style={{ fontSize: 15, color: T.textDim }}>⌕</span>
          <input ref={inputRef} value={voice.listening && voice.interim ? voice.interim : query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAsk()}
            placeholder={voice.listening ? "Listening…" : "Ask anything — try “why did revenue drop?”"}
            aria-label="Ask a question about this data"
            style={{ flex: 1, minWidth: 0, background: "none", border: "none", outline: "none",
              fontFamily: T.sans, fontSize: 14, color: T.text }} />
          <button onClick={voice.listening ? voice.stop : voice.start}
            aria-label={voice.listening ? "Stop listening" : "Ask by voice"}
            style={{ width: 32, height: 32, borderRadius: "50%", border: "none", cursor: "pointer",
              background: voice.listening ? T.amber : T.bg3, color: voice.listening ? T.bg0 : T.textMid,
              fontSize: 13, flexShrink: 0 }}>●</button>
          <button onClick={() => handleAsk()} disabled={busy || !query.trim()}
            style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: T.amber,
              color: T.bg0, fontFamily: T.sans, fontSize: 12, fontWeight: 700, cursor: "pointer",
              opacity: busy || !query.trim() ? 0.35 : 1, flexShrink: 0 }}>Ask</button>
        </div>
        {voice.error && (
          <div style={{ fontSize: 11, color: T.amber, marginTop: 7 }}>{voice.error}</div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {chips.map((c) => (
            <button key={c.text} onClick={() => handleAsk(c.text)}
              style={{ fontSize: 11, color: c.agent ? T.purple : T.textMid, background: T.bg2,
                border: `1px solid ${c.agent ? `${T.purple}38` : T.border}`, borderRadius: 20,
                padding: "4px 11px", cursor: "pointer", fontFamily: T.sans }}>
              {c.agent ? "✦ " : ""}{c.text}
            </button>
          ))}
          <button onClick={() => setSpeakOn((s) => !s)}
            style={{ fontSize: 11, color: speakOn ? T.amber : T.textDim, background: "transparent",
              border: `1px solid ${speakOn ? `${T.amber}45` : T.border}`, borderRadius: 20,
              padding: "4px 11px", cursor: "pointer", fontFamily: T.sans, marginLeft: "auto" }}>
            {speakOn ? "Speaking on" : "Speaking off"}
          </button>
        </div>
      </div>

      {/* BODY */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative",
        alignItems: "flex-start", maxWidth: "100%", overflowX: "hidden" }}>
        <main style={{ flex: 1, minWidth: 0, maxWidth: "100%", overflowX: "hidden",
          padding: isMobile ? "16px 12px 78px" : "18px 22px", width: "100%" }}>
          {trace && <AgentTrace trace={trace} live={traceLive} />}

          {busy && !trace && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, background: T.bg2,
              border: `1px solid ${T.border}`, borderRadius: 10, padding: 16, marginBottom: 16 }}>
              <div style={{ width: 18, height: 18, border: `2px solid ${T.border}`,
                borderTopColor: T.amber, borderRadius: "50%", animation: "spin .8s linear infinite" }} />
              <span style={{ fontSize: 12, color: T.textMid }}>Resolving from the cube…</span>
            </div>
          )}

          {cards.length === 0 && !busy && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", height: 280, gap: 14, color: T.textDim, textAlign: "center" }}>
              <div style={{ fontSize: 40, opacity: 0.2 }}>◈</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.8, maxWidth: 380 }}>
                Ask a question, or start with a chip above.<br />
                Every answer carries the test behind it.
              </div>
            </div>
          )}

          {feedAudit && cards.some((c) => c.fromFeed) && (
            <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10,
              padding: 13, marginBottom: 16, minWidth: 0 }}>
              <div className="ax-wrap" style={{ fontSize: 11.5, color: T.textMid, lineHeight: 1.6 }}>
                {feedAudit.audit.verdict}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 11, flexWrap: "wrap" }}>
                {[["all", `All ${cards.length}`],
                  ["high", `High ${feedAudit.tierCounts.high}`],
                  ["medium", `Medium ${feedAudit.tierCounts.medium}`],
                  ["low", `Low ${feedAudit.tierCounts.low}`]].map(([id, label]) => {
                  const on = tierFilter === id;
                  const col = id === "all" ? T.amber : PRIORITY[id].color;
                  return (
                    <button key={id} onClick={() => setTierFilter(id)}
                      style={{ fontSize: 11, padding: "5px 12px", borderRadius: 20, cursor: "pointer",
                        fontFamily: T.sans, border: `1px solid ${on ? col : T.border}`,
                        background: on ? `${col}1a` : "transparent", color: on ? col : T.textMid }}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ display: "grid",
            gridTemplateColumns: isMobile ? "minmax(0, 1fr)" : "repeat(auto-fill, minmax(320px, 1fr))",
            gap: 14 }}>
            {cards.filter((c) => tierFilter === "all" || !c.fromFeed || c.tier === tierFilter).map((c) => (
              <InsightCard key={c.id} card={c} pinned={pinned} skill={skill} freshness={freshness}
                record={records[c.id]} verification={verify[c.id]} onVerify={onVerifyRecord}
                onPin={(card) => setPinned((p) => p.some((x) => x.id === card.id)
                  ? p.filter((x) => x.id !== card.id) : [...p, card])}
                onSpeak={voice.speak} />
            ))}
          </div>
        </main>

        {/* SIDE PANEL */}
        {(!isMobile || mobilePanel) && (
          <aside style={{
            width: isMobile ? "86%" : 260, maxWidth: isMobile ? 340 : 260, flexShrink: 0,
            background: T.bg1, borderLeft: `1px solid ${T.border}`,
            padding: "16px 15px 80px", overflowY: "auto",
            position: isMobile ? "fixed" : "sticky",
            top: isMobile ? 0 : 62, right: 0, bottom: 0,
            height: isMobile ? "100%" : "calc(100vh - 62px)",
            zIndex: isMobile ? 70 : 1,
            boxShadow: isMobile ? "-4px 0 24px rgba(0,0,0,.55)" : "none",
          }}>
            {isMobile && (
              <button onClick={() => setMobilePanel(null)} aria-label="Close panel"
                style={{ position: "absolute", top: 12, right: 12, background: "transparent",
                  border: "none", color: T.textMid, fontSize: 18, cursor: "pointer" }}>✕</button>
            )}
            <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
              {[["schema", "Schema"], ["skill", `Skill${skill?.gotchas.length ? ` ${skill.gotchas.length}` : ""}`],
                ["context", context ? "Context ✓" : "Context"], ["audit", "Audit"],
                ["pins", `Pins ${pinned.length}`]].map(([id, label]) => (
                <button key={id} onClick={() => setPanel(id)}
                  style={{ flex: 1, padding: "6px 2px", borderRadius: 5, cursor: "pointer",
                    fontSize: 9.5, fontFamily: T.sans, whiteSpace: "nowrap",
                    border: `1px solid ${panel === id ? `${T.amber}50` : T.border}`,
                    background: panel === id ? T.amberGlow : "transparent",
                    color: panel === id ? T.amber : T.textMid }}>
                  {label}
                </button>
              ))}
            </div>
            {panelBody}
          </aside>
        )}

        {isMobile && mobilePanel && (
          <div onClick={() => setMobilePanel(null)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 60 }} />
        )}
      </div>

      {/* MOBILE TABS */}
      {isMobile && (
        <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 80, display: "flex",
          background: T.bg1, borderTop: `1px solid ${T.border}`, height: 54 }}>
          {[
            { id: null, label: "Insights", icon: "◆" },
            { id: "schema", label: "Schema", icon: "◈", panel: "schema" },
            { id: "skill", label: "Skill", icon: "▤", panel: "skill" },
            { id: "context", label: "Context", icon: "❐", panel: "context" },
            { id: "audit", label: "Audit", icon: "⛓", panel: "audit" },
            { id: "pins", label: `Pins ${pinned.length}`, icon: "◉", panel: "pins" },
          ].map((tab) => (
            <button key={tab.label}
              onClick={() => { setMobilePanel(tab.id); if (tab.panel) setPanel(tab.panel); }}
              style={{ flex: 1, border: "none", background: "transparent", cursor: "pointer",
                display: "flex", flexDirection: "column", alignItems: "center",
                justifyContent: "center", gap: 2,
                color: mobilePanel === tab.id ? T.amber : T.textMid, fontFamily: T.sans }}>
              <span style={{ fontSize: 15 }}>{tab.icon}</span>
              <span style={{ fontSize: 9.5 }}>{tab.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

/* ─── FAST PATH — direct cube lookups, no agent ──────────────────────────── */
function fastPath(cube, intent) {
  const grain = resolveGrain(cube, intent.grain);
  const period = intent.period || latestPeriod(cube, grain);
  const measure = intent.measure;
  const base = { kind: "card", agent: null, measure, grain, period,
    dimension: intent.dimension, insightClass: "behavioral", evidence: null, audit: null };

  if (intent.shape === "trend") {
    const data = queryTrend(cube, measure, grain, 18, intent.dimension, intent.dimensionValue);
    const last = data[data.length - 1], prev = data[data.length - 2];
    return { ...base, chart_type: "area", chart_data: data,
      kpi: last?.value ?? null,
      delta: prev?.value ? (last.value - prev.value) / prev.value : null,
      summary: `${measure} across ${data.length} ${grain} periods. Latest ${fmtKpi(last?.value)} on ${last?.n?.toLocaleString() ?? 0} rows. Raw lookup — no test applied.` };
  }
  if (intent.shape === "total") {
    const t = queryTotal(cube, measure, grain, period);
    return { ...base, chart_type: "area", chart_data: queryTrend(cube, measure, grain, 12),
      kpi: t.value, delta: t.delta,
      summary: `${measure} for ${t.period} is ${fmtKpi(t.value)} across ${t.n.toLocaleString()} rows, aggregated by ${t.agg.toUpperCase()}.` };
  }
  const dim = intent.dimension || cube.meta.dims[0]?.col;
  const rows = intent.shape === "topk"
    ? queryTopK(cube, dim, measure, grain, intent.k, period)
    : queryBreakdown(cube, dim, measure, grain, period);
  const thin = rows.filter((r) => r.n < 30).length;
  return { ...base, dimension: dim,
    chart_type: rows.length <= 5 ? "pie" : "bar",
    chart_data: rows.map((r) => ({ label: r.label, value: r.value, n: r.n })),
    kpi: queryTotal(cube, measure, grain, period).value,
    summary: `${measure} by ${dim} for ${period}. ${rows.length} member(s)` +
      (thin ? `, of which ${thin} rest on fewer than 30 rows and should not be read as evidence` : "") +
      `. Raw lookup — no test applied.` };
}
