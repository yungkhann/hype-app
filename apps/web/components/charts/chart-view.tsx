"use client";

import { BarChart3, Download, ImageDown, Table as TableIcon } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { toast } from "sonner";
import type { ChartData } from "@/lib/api/types";
import { exportPng, exportSvg, tableCsv, type LegendEntry } from "@/lib/chart-export";
import { fmtCell, fmtCompact, fmtDate, fmtNumber, sourceText } from "@/lib/format";
import { OTHER_LABEL, seriesColor, type ChartTheme } from "@/lib/palette";
import { cn, downloadText, slug } from "@/lib/utils";
import { SourceLine } from "@/components/source-line";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger, Tip } from "@/components/ui/overlays";
import { EmptyState, Notice } from "@/components/ui/surface";
import { useChartTheme } from "./chart-theme";
import { BoxPlot, Heatmap } from "./svg-charts";

export function chartTitle(data: ChartData): string {
  const { spec } = data;
  const text = (() => {
    switch (spec.type) {
      case "histogram":
        return `Distribution of ${spec.x}`;
      case "scatter":
        return `${spec.y} vs ${spec.x}`;
      case "box":
        return `${spec.y} by ${spec.x}`;
      case "heatmap":
        return spec.x && spec.y ? `${data.heatmap?.value_label ?? "rows"} by ${spec.y} × ${spec.x}` : "Correlation between numeric columns";
      default:
        return `${data.y_label ?? "value"} by ${spec.x}`;
    }
  })();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isDateText(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value);
}

function tickText(value: unknown, kind?: string | null): string {
  if (kind === "datetime" && isDateText(value)) return fmtDate(String(value));
  if (typeof value === "number") return fmtCompact(value);
  const text = String(value ?? "");
  return text.length > 18 ? `${text.slice(0, 17)}…` : text;
}

function legendFor(data: ChartData, theme: ChartTheme): LegendEntry[] {
  if (data.spec.type === "box" || data.spec.type === "heatmap") return [];
  const names = data.series.filter((s) => s !== "value" && s !== "count" && s !== "points");
  return names.map((name, index) => ({ label: name, color: seriesColor(name, index, theme) }));
}

/* ---------------- tooltip ---------------- */

type TooltipEntry = { name?: string | number; value?: unknown; color?: string; dataKey?: string | number; payload?: Record<string, unknown> };

function ChartTooltip({
  active,
  payload,
  label,
  data,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: unknown;
  data: ChartData;
}) {
  if (!active || !payload?.length) return null;
  const type = data.spec.type;
  const row = payload[0]?.payload ?? {};
  let heading: string;
  if (type === "histogram") heading = `${fmtNumber(row.x0)} – ${fmtNumber(row.x1)}`;
  else if (type === "scatter") heading = String(row.series ?? "") === "points" ? "Point" : String(row.series ?? "");
  else heading = data.x_kind === "datetime" && isDateText(label) ? fmtDate(String(label)) : fmtCell(label);
  return (
    <div className="min-w-36 rounded-md border border-line bg-panel px-2.5 py-2 text-2xs text-ink shadow-overlay">
      <p className="mb-1 font-medium">{heading}</p>
      {type === "scatter" ? (
        <dl className="grid grid-cols-[auto_auto] gap-x-3 tabular-nums">
          <dt className="text-ink-2">{data.x_label}</dt>
          <dd className="text-right">{data.x_kind === "datetime" ? fmtDate(new Date(Number(row.x)).toISOString()) : fmtNumber(row.x)}</dd>
          <dt className="text-ink-2">{data.y_label}</dt>
          <dd className="text-right">{fmtNumber(row.y)}</dd>
        </dl>
      ) : (
        <ul className="flex flex-col gap-0.5 tabular-nums">
          {payload.map((entry) => (
            <li key={String(entry.dataKey)} className="flex items-center gap-2">
              <span aria-hidden className="size-2 rounded-[2px]" style={{ background: entry.color }} />
              <span className="flex-1 text-ink-2">
                {entry.name === "value" || entry.name === "count" ? (data.y_label ?? "value") : entry.name}
              </span>
              <span>{fmtNumber(entry.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------- plot by type ---------------- */

function Plot({ data, height }: { data: ChartData; height: number }) {
  const theme = useChartTheme();
  const { grid: GRID, axis: AXIS, ink2: INK_2, ink3: INK_3, series: SERIES } = theme;
  const AXIS_TICK = { fontSize: 11, fill: INK_3 };
  const type = data.spec.type;
  const series = data.series.length ? data.series : ["value"];
  const multi = series.length > 1;
  const color = (name: string, index: number) => (multi ? seriesColor(name, index, theme) : SERIES[0]);
  const yValues = data.rows.flatMap((row) => series.map((s) => Number(row[s]))).filter(Number.isFinite);
  const yCompact = Math.max(0, ...yValues.map(Math.abs)) >= 10_000;
  const yTick = (value: number) => (yCompact ? fmtCompact(value) : fmtNumber(value));
  const tooltip = <Tooltip content={(props) => <ChartTooltip {...(props as object)} data={data} />} cursor={{ fill: theme.cursor, stroke: AXIS }} isAnimationActive={false} />;

  if (type === "box") {
    return data.box?.length ? <BoxPlot boxes={data.box} yLabel={data.y_label} height={height} /> : null;
  }
  if (type === "heatmap") {
    return data.heatmap ? <Heatmap data={data.heatmap} /> : null;
  }

  if (type === "bar") {
    const horizontal = data.x_kind !== "datetime" && data.x_kind !== "numeric";
    if (horizontal) {
      const rowHeight = Math.max(18, series.length * 9 + 10);
      const chartHeight = Math.min(720, Math.max(160, data.rows.length * rowHeight + 36));
      // ~6.8px per character at 11px plus the axis tick offset; long labels are truncated by tickText.
      const labelWidth = Math.min(170, Math.max(48, ...data.rows.map((r) => Math.min(String(tickText(r.x, data.x_kind)).length, 22) * 6.8 + 14)));
      return (
        <ResponsiveContainer width="100%" height={chartHeight}>
          <BarChart data={data.rows} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 4 }} barGap={2} barCategoryGap={multi ? "18%" : "22%"}>
            <CartesianGrid horizontal={false} stroke={GRID} />
            <XAxis type="number" tick={AXIS_TICK} tickFormatter={yTick} axisLine={{ stroke: AXIS }} tickLine={false} />
            <YAxis type="category" dataKey="x" width={labelWidth} tick={{ ...AXIS_TICK, fill: INK_2 }} tickFormatter={(v) => tickText(v, data.x_kind)} axisLine={{ stroke: AXIS }} tickLine={false} interval={0} />
            {tooltip}
            {series.map((name, index) => (
              <Bar key={name} dataKey={name} name={name} fill={color(name, index)} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      );
    }
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data.rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }} barGap={2} barCategoryGap="18%">
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="x" tick={AXIS_TICK} tickFormatter={(v) => tickText(v, data.x_kind)} axisLine={{ stroke: AXIS }} tickLine={false} minTickGap={16} />
          <YAxis tick={AXIS_TICK} tickFormatter={yTick} axisLine={false} tickLine={false} width={56} />
          {tooltip}
          {series.map((name, index) => (
            <Bar key={name} dataKey={name} name={name} fill={color(name, index)} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (type === "histogram") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data.rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }} barGap={0} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="x" tick={AXIS_TICK} tickFormatter={(v) => fmtCompact(v)} axisLine={{ stroke: AXIS }} tickLine={false} minTickGap={20} />
          <YAxis tick={AXIS_TICK} tickFormatter={yTick} axisLine={false} tickLine={false} width={56} />
          {tooltip}
          {series.map((name, index) => (
            <Bar key={name} dataKey={name} name={name} fill={color(name, index)} radius={[3, 3, 0, 0]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (type === "line") {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data.rows} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="x" tick={AXIS_TICK} tickFormatter={(v) => tickText(v, data.x_kind)} axisLine={{ stroke: AXIS }} tickLine={false} minTickGap={28} />
          <YAxis tick={AXIS_TICK} tickFormatter={yTick} axisLine={false} tickLine={false} width={56} />
          <Tooltip content={(props) => <ChartTooltip {...(props as object)} data={data} />} cursor={{ stroke: INK_3, strokeWidth: 1 }} isAnimationActive={false} />
          {series.map((name, index) => (
            <Line
              key={name}
              dataKey={name}
              name={name}
              type="monotone"
              stroke={color(name, index)}
              strokeWidth={2}
              dot={data.rows.length <= 24 ? { r: 3, strokeWidth: 0, fill: color(name, index) } : false}
              activeDot={{ r: 4.5, stroke: theme.surface, strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // scatter
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of data.rows) {
    const key = String(row.series ?? "points");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const names = data.series.length ? data.series : [...groups.keys()];
  const xDate = data.x_kind === "datetime";
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
        <CartesianGrid stroke={GRID} />
        <XAxis
          type="number"
          dataKey="x"
          name={data.x_label ?? "x"}
          domain={["auto", "auto"]}
          tick={AXIS_TICK}
          tickFormatter={(v) => (xDate ? fmtDate(new Date(v).toISOString()) : fmtCompact(v))}
          axisLine={{ stroke: AXIS }}
          tickLine={false}
          minTickGap={24}
        />
        <YAxis type="number" dataKey="y" name={data.y_label ?? "y"} domain={["auto", "auto"]} tick={AXIS_TICK} tickFormatter={yTick} axisLine={false} tickLine={false} width={56} />
        <ZAxis range={[52, 52]} />
        <Tooltip content={(props) => <ChartTooltip {...(props as object)} data={data} />} cursor={{ stroke: AXIS }} isAnimationActive={false} />
        {names.map((name, index) => (
          <Scatter
            key={name}
            name={name}
            data={groups.get(name) ?? []}
            fill={name === "points" ? SERIES[0] : seriesColor(name, index, theme)}
            fillOpacity={0.72}
            stroke={theme.surface}
            strokeWidth={1}
            isAnimationActive={false}
          />
        ))}
      </ScatterChart>
    </ResponsiveContainer>
  );
}

/* ---------------- table view (relief rule: every chart has one) ---------------- */

export function chartTable(data: ChartData): { columns: string[]; rows: unknown[][] } {
  if (data.spec.type === "box" && data.box) {
    const columns = [data.x_label ?? "group", "n", "min", "q1", "median", "mean", "q3", "max", "outliers"];
    return { columns, rows: data.box.map((b) => [b.group, b.n, b.min, b.q1, b.median, b.mean, b.q3, b.max, b.outliers]) };
  }
  if (data.spec.type === "heatmap" && data.heatmap) {
    const { x_labels, y_labels, values } = data.heatmap;
    return { columns: ["", ...x_labels], rows: y_labels.map((label, i) => [label, ...values[i]]) };
  }
  if (data.spec.type === "histogram") {
    const series = data.series.length ? data.series : ["count"];
    return {
      columns: ["bin from", "bin to", ...series],
      rows: data.rows.map((row) => [row.x0, row.x1, ...series.map((s) => row[s])]),
    };
  }
  if (data.spec.type === "scatter") {
    const grouped = data.series.length > 1 || (data.series[0] && data.series[0] !== "points");
    return {
      columns: [data.x_label ?? "x", data.y_label ?? "y", ...(grouped ? [data.spec.group ?? "group"] : [])],
      rows: data.rows.map((row) => [
        data.x_kind === "datetime" ? new Date(Number(row.x)).toISOString().slice(0, 10) : row.x,
        row.y,
        ...(grouped ? [row.series] : []),
      ]),
    };
  }
  const series = data.series.length ? data.series : ["value"];
  return {
    columns: [data.x_label ?? "x", ...series.map((s) => (s === "value" ? (data.y_label ?? "value") : s))],
    rows: data.rows.map((row) => [row.x, ...series.map((s) => row[s])]),
  };
}

function ChartTable({ data }: { data: ChartData }) {
  const table = chartTable(data);
  return (
    <div className="max-h-96 overflow-auto rounded-md border border-line">
      <table className="w-full text-dense">
        <thead className="sticky top-0 bg-sunken text-left text-2xs text-ink-2">
          <tr>
            {table.columns.map((column, index) => (
              <th key={`${column}-${index}`} scope="col" className="px-3 py-1.5 font-medium whitespace-nowrap">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.slice(0, 500).map((row, r) => (
            <tr key={r} className="border-t border-line">
              {row.map((value, c) => (
                <td key={c} className={cn("px-3 py-1 whitespace-nowrap", typeof value === "number" && "text-right tabular-nums")}>
                  {fmtCell(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length > 500 && <p className="px-3 py-2 text-2xs text-ink-3">First 500 of {fmtNumber(table.rows.length)} rows shown; export CSV for all.</p>}
    </div>
  );
}

/* ---------------- the frame every chart lives in ---------------- */

export function ChartView({
  data,
  title,
  height = 320,
  actions,
  showTitle = true,
  toolbar = true,
  className,
}: {
  data: ChartData;
  title?: string;
  height?: number;
  actions?: ReactNode;
  showTitle?: boolean;
  toolbar?: boolean;
  className?: string;
}) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const frame = useRef<HTMLDivElement>(null);
  const heading = title ?? chartTitle(data);
  const theme = useChartTheme();
  const legend = useMemo(() => legendFor(data, theme), [data, theme]);
  const empty = data.rows.length === 0 && !data.box?.length && !data.heatmap;
  const source = sourceText(data.meta);

  async function exportImage(kind: "png" | "svg") {
    const svg = frame.current?.querySelector<SVGSVGElement>("svg.recharts-surface, svg[data-chart-root]");
    if (!svg) {
      toast.error("Switch to the chart view to export an image.");
      return;
    }
    try {
      if (kind === "svg") exportSvg(svg, heading, source, legend, theme);
      else await exportPng(svg, heading, source, legend, theme);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  function exportCsv() {
    const table = chartTable(data);
    downloadText(tableCsv(table.columns, table.rows), `${slug(heading, "chart")}.csv`, "text/csv");
  }

  return (
    <figure className={cn("flex min-w-0 flex-col gap-3", className)} data-testid="chart-view">
      {(showTitle || toolbar) && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          {showTitle ? <figcaption className="min-w-0 text-sm font-semibold text-ink">{heading}</figcaption> : <span />}
          {toolbar && (
            <div className="no-print flex items-center gap-1">
              <div className="flex rounded-md border border-line-strong p-0.5" role="group" aria-label="View as">
                <Tip content="Chart">
                  <button
                    type="button"
                    aria-pressed={mode === "chart"}
                    onClick={() => setMode("chart")}
                    className={cn("rounded-[4px] p-1 text-ink-3 hover:text-ink", mode === "chart" && "bg-hover text-ink")}
                  >
                    <BarChart3 className="size-4" aria-label="Chart view" />
                  </button>
                </Tip>
                <Tip content="Table of the plotted values">
                  <button
                    type="button"
                    aria-pressed={mode === "table"}
                    onClick={() => setMode("table")}
                    className={cn("rounded-[4px] p-1 text-ink-3 hover:text-ink", mode === "table" && "bg-hover text-ink")}
                  >
                    <TableIcon className="size-4" aria-label="Table view" />
                  </button>
                </Tip>
              </div>
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Export chart">
                    <Download />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => void exportImage("png")}>
                    <ImageDown aria-hidden /> PNG image
                  </MenuItem>
                  <MenuItem onSelect={() => void exportImage("svg")}>
                    <ImageDown aria-hidden /> SVG vector
                  </MenuItem>
                  <MenuItem onSelect={exportCsv}>
                    <TableIcon aria-hidden /> CSV of plotted values
                  </MenuItem>
                </MenuContent>
              </Menu>
              {actions}
            </div>
          )}
        </div>
      )}
      {data.warnings.map((warning) => (
        <Notice key={warning} tone="warning">
          {warning}
        </Notice>
      ))}
      {legend.length > 1 && mode === "chart" && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-ink-2" aria-label="Legend">
          {legend.map((entry) => (
            <li key={entry.label} className="flex items-center gap-1.5">
              <span aria-hidden className="size-2.5 rounded-[3px]" style={{ background: entry.color }} />
              {entry.label === OTHER_LABEL ? <span className="italic">{entry.label}</span> : entry.label}
            </li>
          ))}
        </ul>
      )}
      <div ref={frame} className="min-w-0">
        {empty ? (
          <EmptyState title="Nothing to plot">No rows match the current filters or the selected columns are empty.</EmptyState>
        ) : mode === "chart" ? (
          <Plot data={data} height={height} />
        ) : (
          <ChartTable data={data} />
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <SourceLine meta={data.meta} />
        {data.meta.notes
          .filter((note) => !note.startsWith("Filters:"))
          .map((note) => (
            <p key={note} className="pl-[18px] text-2xs text-ink-3">
              {note}
            </p>
          ))}
      </div>
    </figure>
  );
}
