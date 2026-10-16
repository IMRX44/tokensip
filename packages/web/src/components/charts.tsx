import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";

export interface Series {
  label: string;
  color: string;
  values: number[];
  fill?: boolean;
  dashed?: boolean;
}

const H = 220;
const PAD = { t: 10, r: 8, b: 24, l: 52 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

/** Lightweight SVG area/line chart with hover tooltip. Always rendered left-to-right (time axis). */
export function AreaChart({
  labels,
  series,
  format,
}: {
  labels: string[];
  series: Series[];
  format(v: number): string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // Draw at the real pixel width so axis text is never stretched.
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setW(Math.max(240, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const n = labels.length;
  const max = useMemo(() => niceMax(Math.max(0, ...series.flatMap((s) => s.values))), [series]);
  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(W / 90))));

  const onMove = (e: React.MouseEvent) => {
    const svg = ref.current;
    if (!svg || n === 0) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div ref={box} style={{ position: "relative", direction: "ltr" }}>
      <svg
        ref={ref}
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
      >
        <title>{series.map((s) => s.label).join(" · ")}</title>
        <defs>
          {series.map((s, si) => (
            <linearGradient key={s.label} id={`g${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity="0.32" />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        <g className="chart-grid">
          {ticks.map((tv) => (
            <line key={tv} x1={PAD.l} x2={W - PAD.r} y1={y(tv)} y2={y(tv)} strokeDasharray="3 4" />
          ))}
        </g>
        <g className="chart-axis">
          {ticks.map((tv) => (
            <text key={tv} x={PAD.l - 8} y={y(tv) + 3.5} textAnchor="end">
              {format(tv)}
            </text>
          ))}
          {labels.map((l, i) =>
            i % step === 0 ? (
              <text key={l + String(i)} x={x(i)} y={H - 6} textAnchor="middle">
                {l}
              </text>
            ) : null,
          )}
        </g>
        {series.map((s, si) => {
          if (n === 0) return null;
          const pts = s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
          return (
            <g key={s.label}>
              {s.fill && n > 1 && (
                <polygon points={`${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}`} fill={`url(#g${si})`} />
              )}
              <polyline
                points={pts}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeDasharray={s.dashed ? "5 5" : undefined}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            </g>
          );
        })}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--border-strong)" />
            {series.map((s) => (
              <circle key={s.label} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={3.5} fill={s.color} />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div
          className="tooltip"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            top: 0,
            transform: `translateX(${hover > n / 2 ? "-105%" : "8px"})`,
          }}
        >
          <div className="faint" style={{ marginBottom: 4 }}>
            {labels[hover]}
          </div>
          {series.map((s) => (
            <div key={s.label} className="row" style={{ gap: 6 }}>
              <i style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: "inline-block" }} />
              <span className="muted">{s.label}</span>
              <b style={{ marginInlineStart: "auto", paddingInlineStart: 12 }}>{format(s.values[hover] ?? 0)}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function Ring({ value, size = 64, label }: { value: number; size?: number; label?: string }) {
  const { pct } = useI18n();
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={label}>
      <defs>
        <linearGradient id="ring" x1="0" x2="1">
          <stop offset="0" stopColor="#34E2A1" />
          <stop offset="1" stopColor="#3EC5FF" />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={6} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="url(#ring)"
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={`${c * v} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="54%" textAnchor="middle" fontSize={size / 4.6} fontWeight={700} fill="var(--text)">
        {pct(v)}
      </text>
    </svg>
  );
}
