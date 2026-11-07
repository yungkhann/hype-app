"use client";

import { Filter as FilterIcon, Plus, X } from "lucide-react";
import { useState } from "react";
import type { ColumnInfo, ColumnKind, Filter, FilterOp } from "@/lib/api/types";
import { describeFilter } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";

const OPS_BY_KIND: Record<ColumnKind, { op: FilterOp; label: string }[]> = {
  numeric: [
    { op: "between", label: "between" },
    { op: "gte", label: "≥" },
    { op: "lte", label: "≤" },
    { op: "gt", label: ">" },
    { op: "lt", label: "<" },
    { op: "eq", label: "=" },
    { op: "neq", label: "≠" },
    { op: "is_null", label: "is empty" },
    { op: "not_null", label: "is not empty" },
  ],
  datetime: [
    { op: "between", label: "between" },
    { op: "gte", label: "on or after" },
    { op: "lte", label: "on or before" },
    { op: "is_null", label: "is empty" },
    { op: "not_null", label: "is not empty" },
  ],
  categorical: [
    { op: "in", label: "is any of" },
    { op: "not_in", label: "is none of" },
    { op: "eq", label: "equals" },
    { op: "contains", label: "contains" },
    { op: "is_null", label: "is empty" },
    { op: "not_null", label: "is not empty" },
  ],
  boolean: [
    { op: "eq", label: "is" },
    { op: "is_null", label: "is empty" },
    { op: "not_null", label: "is not empty" },
  ],
  text: [
    { op: "contains", label: "contains" },
    { op: "not_contains", label: "does not contain" },
    { op: "eq", label: "equals" },
    { op: "is_null", label: "is empty" },
    { op: "not_null", label: "is not empty" },
  ],
};

export function opsFor(kind: ColumnKind) {
  return OPS_BY_KIND[kind] ?? OPS_BY_KIND.text;
}

/** Build a Filter from editor state; null when incomplete. Exported for unit tests. */
export function buildFilter(column: string, kind: ColumnKind, op: FilterOp, value: string, value2 = ""): Filter | null {
  if (!column) return null;
  if (op === "is_null" || op === "not_null") return { column, op, value: null };
  if (op === "between") {
    if (value === "" && value2 === "") return null;
    return { column, op, value: [value === "" ? null : value, value2 === "" ? null : value2] };
  }
  if (op === "in" || op === "not_in") {
    const list = value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return list.length ? { column, op, value: list } : null;
  }
  if (kind === "boolean") return { column, op, value: value || "true" };
  return value.trim() === "" ? null : { column, op, value: value.trim() };
}

function FilterEditor({ columns, onAdd, onDone }: { columns: ColumnInfo[]; onAdd: (filter: Filter) => void; onDone: () => void }) {
  const [column, setColumn] = useState(columns[0]?.name ?? "");
  const kind = columns.find((c) => c.name === column)?.kind ?? "text";
  const ops = opsFor(kind);
  const [op, setOp] = useState<FilterOp>(ops[0].op);
  const [value, setValue] = useState("");
  const [value2, setValue2] = useState("");
  const activeOp = ops.some((o) => o.op === op) ? op : ops[0].op;
  const needsValue = activeOp !== "is_null" && activeOp !== "not_null";
  const inputType = kind === "numeric" ? "number" : kind === "datetime" ? "date" : "text";
  const filter = buildFilter(column, kind, activeOp, value, value2);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (filter) {
          onAdd(filter);
          onDone();
        }
      }}
    >
      <Field label="Column">
        <Select
          value={column}
          onChange={(event) => {
            setColumn(event.target.value);
            setValue("");
            setValue2("");
          }}
          aria-label="Filter column"
        >
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name} · {c.kind}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Condition">
        <Select value={activeOp} onChange={(event) => setOp(event.target.value as FilterOp)} aria-label="Filter condition">
          {ops.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
      {needsValue &&
        (kind === "boolean" ? (
          <Field label="Value">
            <Select value={value || "true"} onChange={(event) => setValue(event.target.value)} aria-label="Filter value">
              <option value="true">true</option>
              <option value="false">false</option>
            </Select>
          </Field>
        ) : activeOp === "between" ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="From">
              <Input type={inputType} value={value} onChange={(event) => setValue(event.target.value)} aria-label="From" step="any" />
            </Field>
            <Field label="To">
              <Input type={inputType} value={value2} onChange={(event) => setValue2(event.target.value)} aria-label="To" step="any" />
            </Field>
          </div>
        ) : (
          <Field label="Value" hint={activeOp === "in" || activeOp === "not_in" ? "Separate several values with commas." : undefined}>
            <Input
              type={activeOp === "in" || activeOp === "not_in" ? "text" : inputType}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-label="Filter value"
              step="any"
              autoFocus
            />
          </Field>
        ))}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={!filter}>
          Add filter
        </Button>
      </div>
    </form>
  );
}

export function FilterBar({
  columns,
  filters,
  onChange,
  className,
}: {
  columns: ColumnInfo[];
  filters: Filter[];
  onChange: (filters: Filter[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-1.5">
        <FilterIcon className="size-4 text-ink-3" aria-hidden />
        {filters.length === 0 && <span className="text-dense text-ink-3">No filters</span>}
        {filters.map((filter, index) => (
          <span
            key={`${filter.column}-${index}`}
            className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-line-strong bg-panel pr-1 pl-2 text-dense"
          >
            <span className="truncate">{describeFilter(filter)}</span>
            <button
              type="button"
              className="rounded-sm p-0.5 text-ink-3 hover:bg-hover hover:text-ink"
              aria-label={`Remove filter ${describeFilter(filter)}`}
              onClick={() => onChange(filters.filter((_, i) => i !== index))}
            >
              <X className="size-3.5" />
            </button>
          </span>
        ))}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" disabled={!columns.length}>
              <Plus /> Add filter
            </Button>
          </PopoverTrigger>
          <PopoverContent>
            <FilterEditor columns={columns} onAdd={(filter) => onChange([...filters, filter])} onDone={() => setOpen(false)} />
          </PopoverContent>
        </Popover>
        {filters.length > 0 && (
          <Button size="sm" variant="link" onClick={() => onChange([])}>
            Clear all
          </Button>
        )}
      </div>
    </div>
  );
}
