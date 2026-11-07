"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BoxStats, HeatmapData } from "@/lib/api/types";
import { fmtCompact, fmtNumber } from "@/lib/format";
import { diverging, inkOn, sequential } from "@/lib/palette";
import { useChartTheme } from "./chart-theme";

/** Container width via ResizeObserver; charts render once a real width is known. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(Math.floor(element.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => span / s <= count) ?? magnitude * 10;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= max + step * 0.5; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

function HoverCard({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(8, x + 12), Math.max(8, width - 220));
  return (
    <div
      className="pointer-events-none absolute z-10 w-52 rounded-md border border-line bg-panel px-2.5 py-2 text-2xs text-ink shadow-overlay"
      style={{ left, top: Math.max(0, y - 10) }}
    >
      {children}
    </div>
  );
}

/* ---------------- Box plot ---------------- */

export function BoxPlot({ boxes, yLabel, height = 320 }: { boxes: BoxStats[]; yLabel?: string | null; height?: number }) {
  const theme = useChartTheme();
  const { grid: GRID, axis: AXIS, ink: INK, ink2: INK_2, ink3: INK_3, series: SERIES } = theme;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const margin = { top: 12, right: 16, bottom: 44, left: 64 };
  const innerW = Math.max(0, width - margin.left - margin.right);
  const innerH = height - margin.top - margin.bottom;
  const low = Math.min(...boxes.map((b) => b.whisker_low));
  const high = Math.max(...boxes.map((b) => b.whisker_high));
  const ticks = niceTicks(low, high);
  const domainLow = Math.min(low, ticks[0] ?? low);
  const domainHigh = Math.max(high, ticks[ticks.length - 1] ?? high);
  const y = (value: number) => margin.top + innerH - ((value - domainLow) / (domainHigh - domainLow || 1)) * innerH;
  const band = innerW / Math.max(1, boxes.length);
  const boxWidth = Math.min(48, band * 0.5);
  const useCompact = Math.max(Math.abs(domainLow), Math.abs(domainHigh)) >= 10_000;

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} data-chart-root role="img" aria-label={`Box plot of ${yLabel ?? "values"}`}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={margin.left} x2={width - margin.right} y1={y(tick)} y2={y(tick)} stroke={GRID} strokeWidth={1} />
              <text x={margin.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" fontSize={11} fill={INK_3}>
                {useCompact ? fmtCompact(tick) : fmtNumber(tick)}
              </text>
            </g>
          ))}
          <line x1={margin.left} x2={width - margin.right} y1={margin.top + innerH} y2={margin.top + innerH} stroke={AXIS} />
          {boxes.map((box, index) => {
            const cx = margin.left + band * index + band / 2;
            const active = hover?.index === index;
            return (
              <g
                key={box.group}
                onMouseMove={(event) => {
                  const rect = (event.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setHover({ index, x: event.clientX - rect.left, y: event.clientY - rect.top });
                }}
                onMouseLeave={() => setHover(null)}
              >
                <rect x={cx - band / 2} y={margin.top} width={band} height={innerH} fill="transparent" />
                <line x1={cx} x2={cx} y1={y(box.whisker_low)} y2={y(box.q1)} stroke={INK_2} strokeWidth={1.25} />
                <line x1={cx} x2={cx} y1={y(box.q3)} y2={y(box.whisker_high)} stroke={INK_2} strokeWidth={1.25} />
                <line x1={cx - boxWidth / 4} x2={cx + boxWidth / 4} y1={y(box.whisker_low)} y2={y(box.whisker_low)} stroke={INK_2} strokeWidth={1.25} />
                <line x1={cx - boxWidth / 4} x2={cx + boxWidth / 4} y1={y(box.whisker_high)} y2={y(box.whisker_high)} stroke={INK_2} strokeWidth={1.25} />
                <rect
                  x={cx - boxWidth / 2}
                  y={y(box.q3)}
                  width={boxWidth}
                  height={Math.max(1, y(box.q1) - y(box.q3))}
                  rx={3}
                  fill={SERIES[0]}
                  fillOpacity={active ? 0.32 : 0.2}
                  stroke={SERIES[0]}
                  strokeWidth={1.5}
                />
                <line x1={cx - boxWidth / 2} x2={cx + boxWidth / 2} y1={y(box.median)} y2={y(box.median)} stroke={INK} strokeWidth={2} />
                <circle cx={cx} cy={y(box.mean)} r={3} fill={theme.surface} stroke={INK} strokeWidth={1.25} />
                <text x={cx} y={margin.top + innerH + 16} textAnchor="middle" fontSize={11} fill={INK_2}>
                  {box.group.length > 14 ? `${box.group.slice(0, 13)}…` : box.group}
                </text>
                <text x={cx} y={margin.top + innerH + 30} textAnchor="middle" fontSize={10} fill={INK_3}>
                  n={fmtCompact(box.n)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {hover && boxes[hover.index] && (
        <HoverCard x={hover.x} y={hover.y} width={width}>
          <BoxTooltip box={boxes[hover.index]} />
        </HoverCard>
      )}
    </div>
  );
}

function BoxTooltip({ box }: { box: BoxStats }) {
  const rows: [string, number][] = [
    ["Max (whisker)", box.whisker_high],
    ["Q3", box.q3],
    ["Median", box.median],
    ["Mean ○", box.mean],
    ["Q1", box.q1],
    ["Min (whisker)", box.whisker_low],
  ];
  return (
    <>
      <p className="mb-1 font-medium">{box.group}</p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 tabular-nums">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-2">{label}</dt>
            <dd className="text-right">{fmtNumber(value)}</dd>
          </div>
        ))}
        <dt className="text-ink-2">n · outliers</dt>
        <dd className="text-right">
          {fmtNumber(box.n)} · {fmtNumber(box.outliers)}
        </dd>
      </dl>
    </>
  );
}

/* ---------------- Heatmap ---------------- */

/** Correlations are polar (diverging around 0); everything else is magnitude (sequential). */
export function isPolar(valueLabel: string) {
  return /pearson|spearman|correlation/i.test(valueLabel);
}

export function Heatmap({ data }: { data: HeatmapData }) {
  const theme = useChartTheme();
  const { ink: INK, ink2: INK_2 } = theme;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ row: number; col: number; x: number; y: number } | null>(null);
  const polar = isPolar(data.value_label);
  const values = data.values.flat().filter((v): v is number => v !== null && Number.isFinite(v));
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const labelWidth = Math.min(168, Math.max(60, ...data.y_labels.map((l) => Math.min(l.length, 22) * 6.4))) + 8;
  const cols = data.x_labels.length;
  const rows = data.y_labels.length;
  const cell = Math.max(16, Math.min(56, (width - labelWidth - 8) / Math.max(1, cols)));
  // Rotate column labels only when one would not fit its cell; short labels (e.g. classes 0/1) stay upright.
  const rotate = data.x_labels.some((l) => Math.min(l.length, 18) * 6.4 > cell - 6);
  const bottom = rotate ? Math.min(110, Math.max(40, ...data.x_labels.map((l) => Math.min(l.length, 18) * 5.6))) : 26;
  const height = rows * cell + bottom + 16;
  const showValues = cell >= 34;
  const color = (value: number | null) => {
    if (value === null || !Number.isFinite(value)) return theme.missing;
    if (polar) return diverging(value, theme);
    return sequential(max === min ? 0.5 : (value - min) / (max - min), theme);
  };

  return (
    <div>
      <div ref={ref} className="relative w-full overflow-x-auto" style={{ minHeight: height }}>
        {width > 0 && (
          <svg
            width={Math.max(width, labelWidth + cols * cell + 8)}
            height={height}
            data-chart-root
            role="img"
            aria-label={`Heatmap of ${data.value_label}`}
          >
            {data.y_labels.map((label, r) => (
              <text key={`y-${r}`} x={labelWidth - 8} y={8 + r * cell + cell / 2} dy="0.32em" textAnchor="end" fontSize={11} fill={INK_2}>
                {label.length > 22 ? `${label.slice(0, 21)}…` : label}
              </text>
            ))}
            {data.x_labels.map((label, c) => {
              const x = labelWidth + c * cell + cell / 2;
              const y = 8 + rows * cell + (rotate ? 10 : 16);
              return (
                <text key={`x-${c}`} x={x} y={y} textAnchor={rotate ? "end" : "middle"} fontSize={11} fill={INK_2} transform={rotate ? `rotate(-40 ${x} ${y})` : undefined}>
                  {label.length > 18 ? `${label.slice(0, 17)}…` : label}
                </text>
              );
            })}
            {data.values.map((row, r) =>
              row.map((value, c) => {
                // A correlation matrix's diagonal is always 1: draw it quietly so it does not outshine the real pairs.
                const self = polar && data.x_labels[c] === data.y_labels[r];
                const fill = self ? theme.missing : color(value);
                return (
                  <g
                    key={`${r}-${c}`}
                    onMouseMove={(event) => {
                      const rect = (event.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                      setHover({ row: r, col: c, x: event.clientX - rect.left, y: event.clientY - rect.top });
                    }}
                    onMouseLeave={() => setHover(null)}
                  >
                    <rect
                      x={labelWidth + c * cell + 1}
                      y={8 + r * cell + 1}
                      width={cell - 2}
                      height={cell - 2}
                      rx={3}
                      fill={fill}
                      stroke={hover?.row === r && hover?.col === c ? INK : "none"}
                      strokeWidth={1.5}
                    />
                    {showValues && value !== null && (
                      <text
                        x={labelWidth + c * cell + cell / 2}
                        y={8 + r * cell + cell / 2}
                        dy="0.32em"
                        textAnchor="middle"
                        fontSize={10.5}
                        fill={self ? theme.ink3 : inkOn(fill)}
                        style={{ fontVariantNumeric: "tabular-nums" }}
                      >
                        {polar ? value.toFixed(2) : fmtCompact(value)}
                      </text>
                    )}
                  </g>
                );
              }),
            )}
          </svg>
        )}
        {hover && (
          <HoverCard x={hover.x} y={hover.y} width={width}>
            <p className="font-medium">
              {data.y_labels[hover.row]} × {data.x_labels[hover.col]}
            </p>
            <p className="mt-0.5 tabular-nums text-ink-2">
              {data.value_label}: <span className="text-ink">{fmtNumber(data.values[hover.row][hover.col])}</span>
            </p>
          </HoverCard>
        )}
      </div>
      <ScaleLegend polar={polar} min={polar ? -1 : min} max={polar ? 1 : max} label={data.value_label} />
    </div>
  );
}

function ScaleLegend({ polar, min, max, label }: { polar: boolean; min: number; max: number; label: string }) {
  const theme = useChartTheme();
  const stops = Array.from({ length: 11 }, (_, i) => i / 10);
  const gradient = stops.map((t) => (polar ? diverging(t * 2 - 1, theme) : sequential(t, theme))).join(", ");
  return (
    <div className="mt-2 flex items-center gap-2 text-2xs text-ink-3 tabular-nums">
      <span>{fmtNumber(min)}</span>
      <span aria-hidden className="h-2 w-40 rounded-full" style={{ background: `linear-gradient(90deg, ${gradient})` }} />
      <span>{fmtNumber(max)}</span>
      <span className="ml-1 text-ink-2">{label}</span>
    </div>
  );
}
