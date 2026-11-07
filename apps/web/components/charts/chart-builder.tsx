"use client";

import type { AggFn, ChartSpec, ChartType, ColumnInfo, ColumnKind } from "@/lib/api/types";
import { Field, NumberInput, Select } from "@/components/ui/input";

const TYPES: { type: ChartType; label: string; hint: string }[] = [
  { type: "bar", label: "Bar", hint: "Compare a measure across categories" },
  { type: "line", label: "Line", hint: "A measure over time" },
  { type: "scatter", label: "Scatter", hint: "Relationship between two numbers" },
  { type: "histogram", label: "Histogram", hint: "Distribution of one number" },
  { type: "box", label: "Box", hint: "Distribution of a number per group" },
  { type: "heatmap", label: "Heatmap", hint: "Correlation, or counts across two categories" },
];

const AGGS: AggFn[] = ["count", "sum", "mean", "median", "min", "max", "nunique", "std"];

type Role = "x" | "y" | "group";

/** Which column kinds make sense for each role of each chart type (invalid combos are not offered). */
const ALLOWED: Record<ChartType, Partial<Record<Role, ColumnKind[]>>> = {
  bar: { x: ["categorical", "boolean", "text", "datetime", "numeric"], y: ["numeric"], group: ["categorical", "boolean"] },
  line: { x: ["datetime", "numeric"], y: ["numeric"], group: ["categorical", "boolean"] },
  scatter: { x: ["numeric", "datetime"], y: ["numeric"], group: ["categorical", "boolean"] },
  histogram: { x: ["numeric"], group: ["categorical", "boolean"] },
  box: { x: ["categorical", "boolean"], y: ["numeric"] },
  heatmap: { x: ["categorical", "boolean"], y: ["categorical", "boolean"] },
};

export function allowedColumns(type: ChartType, role: Role, columns: ColumnInfo[]) {
  const kinds = ALLOWED[type][role];
  return kinds ? columns.filter((c) => kinds.includes(c.kind)) : [];
}

/** Reasonable first chart for a dataset. */
export function defaultSpec(columns: ColumnInfo[]): ChartSpec {
  const category = columns.find((c) => c.kind === "categorical" || c.kind === "boolean");
  if (category) return { type: "bar", x: category.name, agg: "count" };
  const numeric = columns.find((c) => c.kind === "numeric");
  if (numeric) return { type: "histogram", x: numeric.name };
  return { type: "bar", x: columns[0]?.name ?? null, agg: "count" };
}

/** Keep a spec valid when the type changes: drop columns the new type cannot use. */
export function adaptSpec(spec: ChartSpec, type: ChartType, columns: ColumnInfo[]): ChartSpec {
  const keep = (role: Role, value: string | null | undefined) =>
    value && allowedColumns(type, role, columns).some((c) => c.name === value) ? value : null;
  const next: ChartSpec = { ...spec, type, x: keep("x", spec.x), y: keep("y", spec.y), group: keep("group", spec.group) };
  if (!next.x && type !== "heatmap") next.x = allowedColumns(type, "x", columns)[0]?.name ?? null;
  if ((type === "scatter" || type === "box") && !next.y) {
    next.y = allowedColumns(type, "y", columns).find((c) => c.name !== next.x)?.name ?? null;
  }
  if (type === "heatmap" && next.x && !next.y) next.x = null;
  if (type === "heatmap") next.agg = "count";
  return next;
}

/** Client-side explanation of why a spec cannot be drawn yet; the server re-validates. */
export function specProblem(spec: ChartSpec): string | null {
  const needs = (value: unknown, message: string) => (value ? null : message);
  switch (spec.type) {
    case "bar":
      return needs(spec.x, "Choose a category for X.") ?? (spec.agg !== "count" && !spec.y ? "Choose a numeric Y to aggregate, or use count." : null);
    case "line":
      return needs(spec.x, "Choose a date or number for X.") ?? (spec.agg !== "count" && !spec.y ? "Choose a numeric Y, or use count." : null);
    case "scatter":
      return needs(spec.x, "Choose a numeric X.") ?? needs(spec.y, "Choose a numeric Y.");
    case "histogram":
      return needs(spec.x, "Choose a numeric column.");
    case "box":
      return needs(spec.x, "Choose a grouping column.") ?? needs(spec.y, "Choose a numeric Y.");
    case "heatmap":
      return Boolean(spec.x) !== Boolean(spec.y) ? "Pick both axes for a crosstab, or neither for a correlation matrix." : null;
  }
}

function ColumnSelect({
  label,
  value,
  options,
  onChange,
  optional,
  id,
}: {
  label: string;
  value: string | null | undefined;
  options: ColumnInfo[];
  onChange: (value: string | null) => void;
  optional?: string;
  id: string;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} disabled={!options.length}>
        {optional !== undefined && <option value="">{optional}</option>}
        {!optional && !value && <option value="">Select…</option>}
        {options.map((column) => (
          <option key={column.name} value={column.name}>
            {column.name} · {column.kind}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function ChartBuilder({ spec, columns, onChange }: { spec: ChartSpec; columns: ColumnInfo[]; onChange: (spec: ChartSpec) => void }) {
  const set = (patch: Partial<ChartSpec>) => onChange({ ...spec, ...patch });
  const type = spec.type;
  const showAgg = type === "bar" || type === "line";
  const crosstab = type === "heatmap" && Boolean(spec.x || spec.y);

  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Chart type" className="grid grid-cols-3 gap-1">
        {TYPES.map((option) => (
          <button
            key={option.type}
            type="button"
            role="radio"
            aria-checked={type === option.type}
            title={option.hint}
            onClick={() => onChange(adaptSpec(spec, option.type, columns))}
            className={
              type === option.type
                ? "h-8 rounded-md border border-accent bg-accent-soft text-dense font-medium text-accent-ink"
                : "h-8 rounded-md border border-line-strong bg-panel text-dense text-ink-2 hover:border-control hover:text-ink"
            }
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-2xs text-ink-3">{TYPES.find((t) => t.type === type)?.hint}</p>

      {type === "heatmap" ? (
        <>
          <ColumnSelect id="cb-x" label="Columns (X)" value={spec.x} options={allowedColumns(type, "x", columns)} optional="— correlation matrix —" onChange={(x) => set({ x, y: x ? (spec.y ?? null) : null, agg: "count" })} />
          {crosstab && <ColumnSelect id="cb-y" label="Rows (Y)" value={spec.y} options={allowedColumns(type, "y", columns).filter((c) => c.name !== spec.x)} onChange={(y) => set({ y })} />}
          {crosstab && <p className="text-2xs text-ink-3">Cells count rows for each combination.</p>}
        </>
      ) : (
        <>
          <ColumnSelect id="cb-x" label={type === "box" ? "Group (X)" : type === "histogram" ? "Column" : "X axis"} value={spec.x} options={allowedColumns(type, "x", columns)} onChange={(x) => set({ x })} />
          {type !== "histogram" && (
            <ColumnSelect
              id="cb-y"
              label={type === "bar" || type === "line" ? "Measure (Y)" : "Y axis"}
              value={spec.y}
              options={allowedColumns(type, "y", columns).filter((c) => c.name !== spec.x)}
              optional={showAgg ? "— count rows —" : undefined}
              onChange={(y) => set({ y, agg: y ? (spec.agg === "count" ? "mean" : spec.agg) : "count" })}
            />
          )}
        </>
      )}
      {showAgg && spec.y && (
        <Field label="Aggregation" htmlFor="cb-agg">
          <Select id="cb-agg" value={spec.agg ?? "mean"} onChange={(event) => set({ agg: event.target.value as AggFn })}>
            {AGGS.filter((a) => a !== "count").map((agg) => (
              <option key={agg} value={agg}>
                {agg}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {ALLOWED[type].group && (
        <ColumnSelect
          id="cb-group"
          label={type === "scatter" ? "Color by (top 3 + Other)" : "Split by (top 8 + Other)"}
          value={spec.group}
          options={allowedColumns(type, "group", columns).filter((c) => c.name !== spec.x)}
          optional="— none —"
          onChange={(group) => set({ group })}
        />
      )}
      {type === "histogram" && (
        <Field label="Bins" htmlFor="cb-bins">
          <NumberInput id="cb-bins" integer min={5} max={100} fallback={30} value={spec.bins ?? 30} onValueChange={(bins) => set({ bins: bins ?? 30 })} />
        </Field>
      )}
      {type === "line" && columns.find((c) => c.name === spec.x)?.kind === "datetime" && (
        <Field label="Time bucket" htmlFor="cb-bucket">
          <Select id="cb-bucket" value={spec.time_bucket ?? "auto"} onChange={(event) => set({ time_bucket: event.target.value as ChartSpec["time_bucket"] })}>
            {["auto", "day", "week", "month", "quarter", "year"].map((bucket) => (
              <option key={bucket} value={bucket}>
                {bucket}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {(type === "bar" || type === "box" || crosstab) && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Show top" htmlFor="cb-limit">
            <NumberInput id="cb-limit" integer min={2} max={50} fallback={20} value={spec.limit ?? 20} onValueChange={(limit) => set({ limit: limit ?? 20 })} />
          </Field>
          {type !== "heatmap" && (
            <Field label="Order" htmlFor="cb-sort">
              <Select id="cb-sort" value={spec.sort ?? "value_desc"} onChange={(event) => set({ sort: event.target.value as ChartSpec["sort"] })}>
                <option value="value_desc">Largest first</option>
                <option value="value_asc">Smallest first</option>
                <option value="label">By label</option>
              </Select>
            </Field>
          )}
        </div>
      )}
    </div>
  );
}
