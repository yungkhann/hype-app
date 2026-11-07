import type { Filter, SourceMeta } from "@/lib/api/types";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Human number: integers grouped, decimals trimmed to significant precision. */
export function fmtNumber(value: unknown, digits?: number): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (digits !== undefined) {
    return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
  }
  if (Number.isInteger(n)) return integer.format(n);
  const abs = Math.abs(n);
  const max = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
}

export function fmtCompact(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return Math.abs(n) < 10_000 ? fmtNumber(n) : compact.format(n);
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(digits)}%`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function fmtDate(value: string | null | undefined, withTime = false): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

export function fmtRelative(value: string | null | undefined): string {
  if (!value) return "—";
  const seconds = (Date.now() - new Date(value).getTime()) / 1000;
  if (!Number.isFinite(seconds)) return value;
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return fmtDate(value);
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** A table cell value as display text. Dates keep their ISO day; nulls show an em dash. */
export function fmtCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return fmtNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?$/.test(value)) return value.slice(0, 10);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return value.replace("T", " ").replace(/(\.\d+)?$/, "").slice(0, 19);
  }
  return String(value);
}

const OP_TEXT: Record<Filter["op"], string> = {
  eq: "=",
  neq: "≠",
  in: "in",
  not_in: "not in",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  between: "between",
  contains: "contains",
  not_contains: "does not contain",
  is_null: "is empty",
  not_null: "is not empty",
};

export function describeFilter(filter: Filter): string {
  const op = OP_TEXT[filter.op] ?? filter.op;
  if (filter.op === "is_null" || filter.op === "not_null") return `${filter.column} ${op}`;
  const value = filter.value;
  if (filter.op === "between" && Array.isArray(value)) return `${filter.column} ${fmtCell(value[0])}–${fmtCell(value[1])}`;
  if (Array.isArray(value)) {
    const shown = value.slice(0, 3).map(fmtCell).join(", ");
    return `${filter.column} ${op} ${shown}${value.length > 3 ? ` +${value.length - 3}` : ""}`;
  }
  return `${filter.column} ${op} ${fmtCell(value)}`;
}

/**
 * The provenance line carried by every chart, KPI, metric, and finding:
 * dataset · n of N rows · filters · sampling · aggregation.
 */
export function sourceParts(meta: SourceMeta): string[] {
  const parts = [meta.dataset_name];
  parts.push(
    meta.n_rows_used === meta.n_rows_total
      ? `n = ${fmtNumber(meta.n_rows_total)} rows`
      : `n = ${fmtNumber(meta.n_rows_used)} of ${fmtNumber(meta.n_rows_total)} rows`,
  );
  if (meta.filters?.length) parts.push(`filtered: ${meta.filters.map(describeFilter).join("; ")}`);
  else parts.push("unfiltered");
  if (meta.sampled) parts.push(`sampled ${meta.sample_size ? fmtNumber(meta.sample_size) : ""}`.trim());
  if (meta.aggregation) parts.push(meta.aggregation);
  return parts;
}

export function sourceText(meta: SourceMeta): string {
  return sourceParts(meta).join(" · ");
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${fmtNumber(count)} ${count === 1 ? one : many}`;
}
