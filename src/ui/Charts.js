import { useState, useEffect } from "react";
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceArea,
} from "recharts";
import { T, PALETTE, fmtKpi } from "./tokens.js";

/* ResponsiveContainer measures 0x0 on first paint inside a grid cell, so the
   chart renders empty and never recovers. Defer one frame. Carried over from
   v7, where it was already the right fix. */
export function SafeChart({ height = 130, children }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  if (!ready) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 16, height: 16, border: `2px solid ${T.border}`,
          borderTopColor: T.amber, borderRadius: "50%", animation: "spin .8s linear infinite" }} />
      </div>
    );
  }
  return (
    <div style={{ height, width: "100%" }}>
      <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
    </div>
  );
}

function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  return (
    <div style={{ background: T.bg4, border: `1px solid ${T.borderHi}`, borderRadius: 6,
      padding: "8px 11px", fontSize: 11, fontFamily: T.mono, color: T.textMid }}>
      <div style={{ color: T.textDim, marginBottom: 3 }}>{label}</div>
      <div style={{ color: payload[0]?.color || T.amber }}>{fmtKpi(payload[0]?.value)}</div>
      {row.lo != null && (
        <div style={{ color: T.textDim, marginTop: 3 }}>
          80% interval {fmtKpi(row.lo)} – {fmtKpi(row.hi)}
        </div>
      )}
      {row.n != null && (
        <div style={{ color: T.textDim, marginTop: 3 }}>{row.n.toLocaleString()} rows</div>
      )}
    </div>
  );
}

export function renderChart(card) {
  const data = card.chart_data || [];
  if (!data.length) return null;
  const color = T.amber;

  if (card.chart_type === "area") {
    const firstForecast = data.findIndex((d) => d.forecast);
    return (
      <AreaChart data={data} margin={{ top: 6, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id={`g${card.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.32} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {/* Forecast region is visually separated — a projection should never
            look like an observation. */}
        {firstForecast > 0 && (
          <ReferenceArea x1={data[firstForecast].period} x2={data[data.length - 1].period}
            fill={T.purple} fillOpacity={0.07} />
        )}
        <XAxis dataKey="period" tick={{ fontSize: 8, fill: T.textDim }} axisLine={false}
          tickLine={false} interval="preserveStartEnd"
          tickFormatter={(v) => (typeof v === "string" && v.length > 5 ? v.slice(-5) : v)} />
        <YAxis hide domain={["auto", "auto"]} />
        <Tooltip content={<ChartTip />} />
        {data.some((d) => d.hi != null) && (
          <Area type="monotone" dataKey="hi" stroke="none" fill={T.purple} fillOpacity={0.12} isAnimationActive={false} />
        )}
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.7}
          fill={`url(#g${card.id})`} dot={false} isAnimationActive={false} />
      </AreaChart>
    );
  }

  if (card.chart_type === "pie") {
    return (
      <PieChart>
        <Pie data={data} cx="50%" cy="50%" outerRadius={52} innerRadius={28}
          dataKey="value" nameKey="label" paddingAngle={2} isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={PALETTE[i % PALETTE.length]}
              fillOpacity={card.highlight?.length ? (card.highlight.includes(d.label) ? 1 : 0.22) : 0.9} />
          ))}
        </Pie>
        <Tooltip content={<ChartTip />} />
      </PieChart>
    );
  }

  const hl = card.highlight || [];
  const anyHl = hl.length > 0;
  const hasNeg = data.some((d) => d.value < 0);
  return (
    <BarChart data={data} barCategoryGap="26%" margin={{ top: 6, right: 8, left: 8, bottom: 0 }}>
      <XAxis dataKey="label" tick={{ fontSize: 8, fill: T.textDim }} axisLine={false} tickLine={false}
        tickFormatter={(v) => (v && v.length > 10 ? v.slice(0, 9) + "…" : v)} />
      <YAxis hide domain={hasNeg ? ["auto", "auto"] : [0, "auto"]} />
      <Tooltip content={<ChartTip />} />
      <Bar dataKey="value" radius={[3, 3, 0, 0]} isAnimationActive={false}>
        {data.map((d, i) => {
          const isHl = hl.includes(d.label);
          // Negative contributions read red without needing a legend.
          const base = hasNeg ? (d.value < 0 ? T.red : T.green) : PALETTE[i % PALETTE.length];
          return <Cell key={i} fill={base}
            fillOpacity={anyHl ? (isHl ? 1 : 0.22) : 0.85}
            stroke={isHl ? T.text : "none"} strokeWidth={isHl ? 1 : 0} />;
        })}
      </Bar>
    </BarChart>
  );
}

export function Delta({ value }) {
  if (value == null || Number.isNaN(value)) return null;
  const up = value > 0;
  return (
    <span style={{ fontFamily: T.mono, fontSize: 11, padding: "2px 8px", borderRadius: 3,
      marginLeft: 8, background: up ? `${T.green}22` : `${T.red}22`, color: up ? T.green : T.red }}>
      {up ? "▲" : "▼"} {(Math.abs(value) * 100).toFixed(1)}%
    </span>
  );
}
