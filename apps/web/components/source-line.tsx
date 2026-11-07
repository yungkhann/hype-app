import { Database } from "lucide-react";
import type { SourceMeta } from "@/lib/api/types";
import { describeFilter, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The signature element: every number in ATLAS says where it came from.
 * dataset · n of N rows · filters · sampling · aggregation
 */
export function SourceLine({ meta, className, extra }: { meta: SourceMeta; className?: string; extra?: string[] }) {
  const partial = meta.n_rows_used !== meta.n_rows_total;
  return (
    <p className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-2xs leading-4 text-ink-3", className)}>
      <Database className="size-3 shrink-0" aria-hidden />
      <span className="sr-only">Source:</span>
      <span className="font-medium text-ink-2">{meta.dataset_name}</span>
      <Dot />
      <span className="tabular-nums">
        {partial ? (
          <>
            n = {fmtNumber(meta.n_rows_used)} of {fmtNumber(meta.n_rows_total)} rows
          </>
        ) : (
          <>n = {fmtNumber(meta.n_rows_total)} rows</>
        )}
      </span>
      <Dot />
      <span>{meta.filters?.length ? `filtered: ${meta.filters.map(describeFilter).join("; ")}` : "unfiltered"}</span>
      {meta.sampled && (
        <>
          <Dot />
          <span className="font-medium text-warning">
            sampled{meta.sample_size ? ` ${fmtNumber(meta.sample_size)}` : ""}
          </span>
        </>
      )}
      {meta.aggregation && (
        <>
          <Dot />
          <span>{meta.aggregation}</span>
        </>
      )}
      {extra?.map((item) => (
        <span key={item} className="contents">
          <Dot />
          <span>{item}</span>
        </span>
      ))}
    </p>
  );
}

function Dot() {
  return (
    <span aria-hidden className="text-line-strong">
      ·
    </span>
  );
}
