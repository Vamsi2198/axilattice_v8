import { useState, useRef, useCallback } from "react";
import { T, GLOBAL_CSS } from "./tokens.js";
import { loadDataset } from "../engine/index.js";
import { fingerprintDataset } from "../provenance.js";

const PHASE_LABEL = {
  parse: "Reading the file",
  profile: "Profiling the schema",
  cube: "Building the cube",
  done: "Ready",
};

export function UploadScreen({ onReady }) {
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  const handleFile = useCallback(async (file) => {
    setError("");
    setProgress({ phase: "parse", done: 0, total: 1 });
    try {
      const text = await file.text();
      await new Promise((r) => setTimeout(r, 20));
      const { parsed, profile: prof, cube, warnings } = await loadDataset(text, {
        fileName: file.name,
        onProgress: (p) => setProgress(p),
      });
      const fingerprint = await fingerprintDataset(text, parsed, prof, file.name);
      onReady({ parsed, profile: prof, cube, warnings, fingerprint });
    } catch (e) {
      setError(e.message || String(e));
      setProgress(null);
    }
  }, [onReady]);

  const busy = !!progress;
  const pctDone = progress && progress.total
    ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "100vh", gap: 30, padding: 24,
      background: `radial-gradient(ellipse at 50% 35%, #0e1220 0%, ${T.bg0} 70%)` }}>
      <style>{GLOBAL_CSS}</style>

      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 42, fontWeight: 800, letterSpacing: "-2px", fontFamily: T.sans,
          background: "linear-gradient(135deg,#f59e0b,#06b6d4)", WebkitBackgroundClip: "text",
          WebkitTextFillColor: "transparent" }}>axilattice</div>
        <div style={{ fontSize: 10, letterSpacing: "3.5px", textTransform: "uppercase",
          color: T.textDim, marginTop: 8 }}>evidence, not dashboards</div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false);
          const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
        onClick={() => !busy && fileRef.current?.click()}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !busy) fileRef.current?.click(); }}
        role="button" tabIndex={0}
        style={{ width: "100%", maxWidth: 420, padding: 40, borderRadius: 12, textAlign: "center",
          cursor: busy ? "default" : "pointer",
          border: `2px dashed ${dragging ? T.amber : T.border}`,
          background: dragging ? T.amberGlow : T.bg2, transition: "border-color .2s, background .2s" }}>
        <input ref={fileRef} type="file" accept=".csv,.tsv,text/csv" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
        {busy ? (
          <>
            <div style={{ width: "100%", height: 3, background: T.bg4, borderRadius: 2,
              overflow: "hidden", marginBottom: 16 }}>
              <div style={{ width: `${pctDone}%`, height: "100%", background: T.amber,
                transition: "width .12s linear" }} />
            </div>
            <div style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>
              {PHASE_LABEL[progress.phase] || progress.phase}
            </div>
            <div style={{ color: T.textDim, fontSize: 11, marginTop: 6, fontFamily: T.mono }}>
              {progress.total > 1
                ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} rows`
                : "…"}
            </div>
            <div style={{ color: T.textDim, fontSize: 11, marginTop: 10 }}>
              The file stays in this tab. Nothing is uploaded.
            </div>
          </>
        ) : (
          <>
            <div style={{ fontSize: 30, marginBottom: 12, color: T.amber }}>⬡</div>
            <div style={{ color: T.text, fontSize: 14, fontWeight: 600 }}>Drop a CSV to begin</div>
            <div style={{ color: T.textDim, fontSize: 11, marginTop: 10, lineHeight: 1.7 }}>
              Needs one date column and one numeric column.<br />
              Everything runs in this browser tab.
            </div>
          </>
        )}
      </div>

      {error && (
        <div style={{ maxWidth: 420, background: `${T.red}12`, border: `1px solid ${T.red}40`,
          borderRadius: 8, padding: "12px 15px", fontSize: 12, color: T.red, lineHeight: 1.6 }}>
          {error}
        </div>
      )}

      <div style={{ maxWidth: 480, textAlign: "center", fontSize: 11, color: T.textDim, lineHeight: 1.8 }}>
        Findings are tested and corrected for multiple comparisons. When the data is flat,
        this says so instead of inventing six insights.
      </div>
    </div>
  );
}
