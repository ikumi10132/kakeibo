import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { yen } from '../util';

/** 要素の幅を測る (SVG の文字の大きさを画面幅によらず一定にするため) */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

// ---------- 円グラフ (カテゴリー別の支出) ----------

export interface Slice {
  key: string;
  label: string;
  icon?: string;
  color: string;
  amount: number;
}

/** 7 個以上は、大きい順に 5 個 + 「その他」にまとめる (色が多すぎると見分けられない) */
export function foldSlices(slices: Slice[], max = 6): Slice[] {
  if (slices.length <= max) return slices;
  const head = slices.slice(0, max - 1);
  const rest = slices.slice(max - 1).reduce((s, x) => s + x.amount, 0);
  return [...head, { key: '__other', label: 'その他', color: 'var(--chart-other)', amount: rest }];
}

const arc = (cx: number, cy: number, r: number, a0: number, a1: number) => {
  const p = (a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)] as const;
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
};

export function DonutChart({ slices, total }: { slices: Slice[]; total: number }) {
  const [active, setActive] = useState<string | null>(null);
  const size = 220;
  const r = 84;
  const stroke = 36;
  const c = size / 2;
  // 隙間 (2px) を角度にして、各扇形の両端から引く
  const gap = slices.length > 1 ? 2 / r : 0;
  let a = 0;
  const arcs = slices.map((s) => {
    const sweep = (s.amount / total) * Math.PI * 2;
    const a0 = a + gap / 2;
    const a1 = a + sweep - gap / 2;
    a += sweep;
    return { s, a0, a1: Math.max(a1, a0 + 0.001), full: sweep >= Math.PI * 2 - 1e-6 };
  });
  const shown = slices.find((s) => s.key === active);

  return (
    <div className="donut">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="カテゴリー別の支出の円グラフ">
        {arcs.map(({ s, a0, a1, full }) =>
          full ? (
            <circle key={s.key} cx={c} cy={c} r={r} fill="none" stroke={s.color} strokeWidth={stroke} />
          ) : (
            <path
              key={s.key}
              d={arc(c, c, r, a0, a1)}
              fill="none"
              stroke={s.color}
              strokeWidth={active === s.key ? stroke + 8 : stroke}
              opacity={active && active !== s.key ? 0.35 : 1}
              onPointerEnter={() => setActive(s.key)}
              onPointerLeave={() => setActive(null)}
              style={{ cursor: 'pointer', transition: 'opacity .15s, stroke-width .15s' }}
            >
              <title>{`${s.label} ${yen(s.amount)} (${Math.round((s.amount / total) * 100)}%)`}</title>
            </path>
          ),
        )}
        <text x={c} y={c - 8} textAnchor="middle" className="donut-caption">
          {shown ? shown.label : '支出'}
        </text>
        <text x={c} y={c + 18} textAnchor="middle" className="donut-total">
          {yen(shown ? shown.amount : total)}
        </text>
      </svg>
      {/* 凡例: 色だけに頼らず、名前・金額・割合を並べる (表の代わりにもなる) */}
      <ul className="donut-legend">
        {slices.map((s) => (
          <li
            key={s.key}
            className={active === s.key ? 'active' : ''}
            onPointerEnter={() => setActive(s.key)}
            onPointerLeave={() => setActive(null)}
          >
            <span className="legend-swatch" style={{ background: s.color }} aria-hidden />
            <span className="grow">
              {s.icon ? `${s.icon} ` : ''}
              {s.label}
            </span>
            <span className="num">{yen(s.amount)}</span>
            <span className="muted small legend-pct">{Math.round((s.amount / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- 折れ線グラフ (支出の累計、今月と先月) ----------

export interface LineSeries {
  key: string;
  label: string;
  className: string;
  /** values[i] = (i + 1) 日までの累計。未来の日は含めない */
  values: number[];
}

/** 目盛りの間隔をきりのいい数 (1, 2, 2.5, 5 × 10^n) にし、4〜5 本に収める */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 2500, 5000, 7500, 10000];
  const raw = max / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
  const n = Math.ceil(max / step);
  return Array.from({ length: n + 1 }, (_, i) => i * step);
}

/** 目盛りの金額 (例: 5万 / 2.5万 / 8,000) */
const axisYen = (n: number) => (n >= 10_000 ? `${Number((n / 10_000).toFixed(1))}万` : n.toLocaleString('ja-JP'));

export function CumulativeChart({ series, days }: { series: LineSeries[]; days: number }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const h = 240;
  const pad = { top: 16, right: 16, bottom: 28, left: 52 };
  const w = Math.max(width, 280);
  const iw = w - pad.left - pad.right;
  const ih = h - pad.top - pad.bottom;
  const ticks = niceTicks(Math.max(0, ...series.flatMap((s) => s.values)));
  const yMax = ticks.at(-1)!;
  const x = (day: number) => pad.left + ((day - 1) / Math.max(1, days - 1)) * iw;
  const y = (v: number) => pad.top + ih - (v / yMax) * ih;
  const xTicks = [1, 10, 20, days];

  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const day = Math.round(((e.clientX - rect.left) / rect.width) * (days - 1)) + 1;
    setHover(Math.min(days, Math.max(1, day)));
  };

  return (
    <div className="line-chart" ref={box}>
      {width > 0 && (
        <svg width={w} height={h} role="img" aria-label="今月と先月の支出の累計の折れ線グラフ">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={w - pad.right} y1={y(t)} y2={y(t)} className="grid-line" />
              <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className="axis-text">
                {axisYen(t)}
              </text>
            </g>
          ))}
          {xTicks.map((d) => (
            <text key={d} x={x(d)} y={h - 8} textAnchor="middle" className="axis-text">
              {d}日
            </text>
          ))}
          {series.map((s) =>
            s.values.length > 0 ? (
              <polyline
                key={s.key}
                className={`line ${s.className}`}
                fill="none"
                points={s.values.map((v, i) => `${x(i + 1)},${y(v)}`).join(' ')}
              />
            ) : null,
          )}
          {/* 線の終わりの点 (今日・月末の位置) */}
          {series.map((s) =>
            s.values.length > 0 ? (
              <circle key={s.key} className={`dot ${s.className}`} cx={x(s.values.length)} cy={y(s.values.at(-1)!)} r={4} />
            ) : null,
          )}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + ih} className="crosshair" />
              {series.map((s) =>
                s.values[hover - 1] !== undefined ? (
                  <circle key={s.key} className={`dot ${s.className}`} cx={x(hover)} cy={y(s.values[hover - 1]!)} r={5} />
                ) : null,
              )}
            </g>
          )}
          {/* 当たり判定は描画域全体 (線より広く) */}
          <rect
            x={pad.left}
            y={pad.top}
            width={iw}
            height={ih}
            fill="transparent"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
      )}
      {hover !== null && width > 0 && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(x(hover), 90), w - 90) }}>
          <strong>{hover}日まで</strong>
          {series.map((s) => (
            <span key={s.key}>
              <span className={`legend-line ${s.className}`} aria-hidden />
              {s.label} <span className="num">{s.values[hover - 1] !== undefined ? yen(s.values[hover - 1]!) : '—'}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
