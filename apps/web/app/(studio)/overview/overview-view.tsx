"use client";

import { RefreshCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api/client";
import { useChart, useProfile, useRefreshProfile } from "@/lib/api/hooks";
import type { ChartSpec, ColumnProfile, DatasetDetail, DatasetProfile, QualityFlag } from "@/lib/api/types";
import { fmtBytes, fmtCell, fmtNumber, fmtPct } from "@/lib/format";
import { localChart, profileMeta } from "@/lib/local-chart";
import { SERIES } from "@/lib/palette";
import { cn } from "@/lib/utils";
import { ChartView } from "@/components/charts/chart-view";
import { SaveFindingButton } from "@/components/findings/save-finding";
import { PageHeader, PageSkeleton, WithDataset } from "@/components/shell/page";
import { SourceLine } from "@/components/source-line";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger, Tip } from "@/components/ui/overlays";
import { Badge, ColumnName, EmptyState, Notice, Panel, PanelHeader, SeverityIcon, Skeleton, Spinner, Stat } from "@/components/ui/surface";

export function OverviewView() {
  return <WithDataset purpose="The overview profiles the active dataset.">{(dataset) => <Overview dataset={dataset} />}</WithDataset>;
}

function Overview({ dataset }: { dataset: DatasetDetail }) {
  const profile = useProfile(dataset.id);
  const refresh = useRefreshProfile();

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title={dataset.name}
        description={
          <>
            {fmtNumber(dataset.n_rows)} rows × {fmtNumber(dataset.n_cols)} columns · {dataset.format.toUpperCase()}
            {dataset.original && (
              <>
                {" "}
                · original <span className="font-mono text-2xs">{dataset.original.filename}</span> ({fmtBytes(dataset.original.size_bytes)}, sha256{" "}
                <span className="font-mono text-2xs">{dataset.original.sha256.slice(0, 12)}…</span>)
              </>
            )}
          </>
        }
        actions={
          <Button
            variant="secondary"
            loading={refresh.isPending}
            onClick={() =>
              refresh.mutate(dataset.id, {
                onSuccess: () => toast.success("Profile recomputed"),
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            <RefreshCcw /> Recompute profile
          </Button>
        }
      />
      {dataset.lineage && <LineageNotice dataset={dataset} />}
      {(dataset.notes?.length ?? 0) > 0 && (
        <Notice tone="info" title="Conversions made during import" className="mb-4">
          <ul className="list-disc pl-4">
            {dataset.notes!.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </Notice>
      )}
      {profile.isPending ? (
        <PageSkeleton />
      ) : profile.isError ? (
        <Notice tone="critical" title="Profiling failed">
          {errorMessage(profile.error)}
        </Notice>
      ) : (
        <ProfileBody profile={profile.data} dataset={dataset} />
      )}
    </div>
  );
}

function LineageNotice({ dataset }: { dataset: DatasetDetail }) {
  const lineage = dataset.lineage!;
  return (
    <Notice tone="neutral" title={`Derived from “${lineage.parent_name}” by ${lineage.log.length} recorded steps`} className="mb-4">
      <ol className="mt-1 list-decimal pl-4">
        {lineage.log.map((step, index) => (
          <li key={index}>
            {String(step.description ?? step.op)}
            {typeof step.fit_scope === "string" && step.fit_scope !== "none" && (
              <Badge tone={step.fit_scope === "train_only" ? "good" : "warning"} className="ml-1.5">
                fitted on {step.fit_scope.replace("_", " ")}
              </Badge>
            )}
          </li>
        ))}
      </ol>
    </Notice>
  );
}

function ProfileBody({ profile, dataset }: { profile: DatasetProfile; dataset: DatasetDetail }) {
  const { overview } = profile;
  const [selected, setSelected] = useState<string | null>(profile.columns[0]?.name ?? null);
  const meta = profileMeta(profile, { aggregation: "profile" });
  const kinds = Object.entries(overview.kinds)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(" · ");

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Rows" value={fmtNumber(overview.n_rows)} />
          <Stat label="Columns" value={fmtNumber(overview.n_cols)} detail={kinds} />
          <Stat label="Missing cells" value={fmtPct(overview.missing_pct)} detail={`${fmtNumber(overview.missing_cells)} cells`} />
          <Stat label="Duplicate rows" value={fmtNumber(overview.duplicate_rows)} detail={fmtPct(overview.duplicate_pct)} />
          <Stat label="In memory" value={fmtBytes(overview.memory_bytes)} detail={overview.file_size_bytes ? `file ${fmtBytes(overview.file_size_bytes)}` : undefined} />
          <Stat label="Quality flags" value={fmtNumber(profile.quality.length)} detail={`${profile.quality.filter((q) => q.basis === "detected").length} detected · ${profile.quality.filter((q) => q.basis === "heuristic").length} heuristic`} />
        </dl>
        <div className="border-t border-line px-4 py-2">
          <SourceLine meta={meta} extra={[`profiled ${new Date(profile.generated_at).toLocaleString("en-GB")}`]} />
        </div>
      </Panel>
      {profile.sampling.sampled && profile.sampling.note && <Notice tone="warning">{profile.sampling.note}</Notice>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <QualityPanel profile={profile} onSelect={setSelected} />
        <MissingnessPanel profile={profile} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <ColumnsPanel profile={profile} selected={selected} onSelect={setSelected} />
        {selected && <ColumnDetail key={selected} dataset={dataset} profile={profile} column={profile.columns.find((c) => c.name === selected)!} />}
      </div>

      <CorrelationPanel profile={profile} />
    </div>
  );
}

/* ---------- quality: detected facts are separated from heuristics ---------- */

function QualityPanel({ profile, onSelect }: { profile: DatasetProfile; onSelect: (column: string) => void }) {
  const detected = profile.quality.filter((q) => q.basis === "detected");
  const heuristic = profile.quality.filter((q) => q.basis === "heuristic");
  const order = { critical: 0, warning: 1, info: 2 } as const;
  const sort = (list: QualityFlag[]) => [...list].sort((a, b) => order[a.severity] - order[b.severity]);

  const list = (items: QualityFlag[], empty: string) =>
    items.length === 0 ? (
      <p className="px-4 py-6 text-center text-dense text-ink-2">{empty}</p>
    ) : (
      <ul className="max-h-80 divide-y divide-line overflow-y-auto">
        {sort(items).map((flag, index) => (
          <li key={`${flag.code}-${flag.column}-${index}`} className="flex gap-2.5 px-4 py-2.5">
            <SeverityIcon severity={flag.severity} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-dense text-ink">{flag.message}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-3">
                <span className="font-mono">{flag.code}</span>
                {flag.column && (
                  <button type="button" className="font-mono text-accent-ink underline-offset-2 hover:underline" onClick={() => onSelect(flag.column!)}>
                    {flag.column}
                  </button>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    );

  return (
    <Panel>
      <PanelHeader title="Data quality" description="Detected conditions are exact facts. Heuristics are suspicions that need a human decision." />
      <Tabs defaultValue="detected">
        <TabsList className="px-3">
          <TabsTrigger value="detected">
            Detected <Badge>{detected.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="heuristic">
            Heuristic <Badge>{heuristic.length}</Badge>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="detected">{list(detected, "No exact data problems detected.")}</TabsContent>
        <TabsContent value="heuristic">{list(heuristic, "No heuristic warnings.")}</TabsContent>
      </Tabs>
    </Panel>
  );
}

function MissingnessPanel({ profile }: { profile: DatasetProfile }) {
  const withMissing = profile.columns.filter((c) => c.missing > 0).sort((a, b) => b.missing_pct - a.missing_pct);
  const chart = localChart(
    { type: "bar", x: "column" },
    {
      x_label: "column",
      y_label: "% of rows missing",
      x_kind: "categorical",
      rows: withMissing.slice(0, 25).map((c) => ({ x: c.name, value: c.missing_pct })),
      meta: profileMeta(profile, { aggregation: "% missing per column (all rows)" }),
      warnings: [],
    },
  );
  return (
    <Panel>
      <PanelHeader title="Missing values" description={withMissing.length ? `${withMissing.length} of ${profile.columns.length} columns have gaps` : "Every column is complete."} />
      <div className="p-4">
        {withMissing.length ? (
          <ChartView data={chart} title="Share of rows missing, by column" showTitle={false} actions={<SaveFindingButton draft={{ title: "Missing values by column", chart }} />} />
        ) : (
          <EmptyState title="No missing values">All {fmtNumber(profile.overview.n_rows)} rows are complete in every column.</EmptyState>
        )}
      </div>
    </Panel>
  );
}

/* ---------- columns ---------- */

function Sparkline({ column }: { column: ColumnProfile }) {
  const counts = column.histogram?.counts ?? column.top?.slice(0, 12).map((t) => t.count) ?? [];
  if (!counts.length) return null;
  const max = Math.max(...counts, 1);
  const width = 72;
  const bar = width / counts.length;
  return (
    <svg width={width} height={20} aria-hidden className="shrink-0">
      {counts.map((count, index) => {
        const h = Math.max(1, (count / max) * 18);
        return <rect key={index} x={index * bar + 0.5} y={20 - h} width={Math.max(1, bar - 1)} height={h} rx={1} fill={SERIES[0]} opacity={0.75} />;
      })}
    </svg>
  );
}

function summary(column: ColumnProfile): string {
  if (column.numeric) {
    const n = column.numeric;
    return `median ${fmtNumber(n.median)} · range ${fmtNumber(n.min)} – ${fmtNumber(n.max)}`;
  }
  if (column.datetime) return `${fmtCell(column.datetime.min)} → ${fmtCell(column.datetime.max)}`;
  // A "top value" of a column where every value is distinct is noise; say what it is instead.
  if (column.non_null > 1 && column.unique === column.non_null) return `all values distinct · e.g. ${column.examples.slice(0, 2).join(", ")}`;
  if (column.top?.length) return `top “${column.top[0].value}” (${fmtPct((column.top[0].count / Math.max(1, column.non_null)) * 100)})`;
  return column.examples.slice(0, 2).join(", ");
}

function ColumnsPanel({ profile, selected, onSelect }: { profile: DatasetProfile; selected: string | null; onSelect: (name: string) => void }) {
  const [query, setQuery] = useState("");
  const columns = useMemo(
    () => profile.columns.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()) || c.kind.includes(query.toLowerCase())),
    [profile.columns, query],
  );
  return (
    <Panel className="flex min-h-0 flex-col">
      <PanelHeader
        title="Columns"
        description={`${profile.columns.length} columns · statistics over all ${fmtNumber(profile.overview.n_rows)} rows`}
        actions={
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find column" className="h-7 w-44 pl-7" aria-label="Find column" />
          </div>
        }
      />
      <div className="max-h-[560px] overflow-auto">
        <table className="w-full text-dense">
          <thead className="sticky top-0 z-10 bg-sunken text-left text-2xs text-ink-2">
            <tr>
              <th scope="col" className="px-4 py-1.5 font-medium">
                Column
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                Missing
              </th>
              <th scope="col" className="px-2 py-1.5 text-right font-medium">
                Unique
              </th>
              <th scope="col" className="hidden px-2 py-1.5 font-medium md:table-cell">
                Summary
              </th>
              <th scope="col" className="hidden px-4 py-1.5 font-medium sm:table-cell">
                <span className="sr-only">Distribution</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr
                key={column.name}
                onClick={() => onSelect(column.name)}
                className={cn("cursor-pointer border-t border-line hover:bg-canvas", selected === column.name && "bg-accent-soft/60 hover:bg-accent-soft/60")}
                aria-selected={selected === column.name}
              >
                <td className="max-w-56 px-4 py-1.5">
                  <button type="button" className="flex min-w-0 items-center gap-1.5 text-left" onClick={() => onSelect(column.name)}>
                    <ColumnName name={column.name} kind={column.kind} />
                    {column.flags.length > 0 && (
                      <Tip content={column.flags.join(", ")}>
                        <span className="shrink-0">
                          <Badge tone="warning">{column.flags.length}</Badge>
                        </span>
                      </Tip>
                    )}
                  </button>
                </td>
                <td className={cn("px-2 py-1.5 text-right tabular-nums", column.missing === 0 ? "text-ink-3" : "text-ink")}>{fmtPct(column.missing_pct)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{fmtNumber(column.unique)}</td>
                <td className="hidden max-w-72 truncate px-2 py-1.5 text-ink-2 md:table-cell">{summary(column)}</td>
                <td className="hidden px-4 py-1.5 sm:table-cell">
                  <Sparkline column={column} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function detailSpec(column: ColumnProfile): ChartSpec | null {
  if (column.kind === "numeric") return { type: "histogram", x: column.name, bins: 30 };
  if (column.kind === "datetime") return { type: "line", x: column.name, agg: "count", time_bucket: "auto" };
  if (column.kind === "categorical" || column.kind === "boolean") return { type: "bar", x: column.name, agg: "count", limit: 20 };
  return null;
}

function ColumnDetail({ dataset, profile, column }: { dataset: DatasetDetail; profile: DatasetProfile; column: ColumnProfile }) {
  const spec = detailSpec(column);
  const chart = useChart(dataset.id, spec);
  const stats: [string, string][] = [
    ["Type", `${column.kind} (${column.dtype})`],
    ["Non-missing", `${fmtNumber(column.non_null)} (${fmtPct(100 - column.missing_pct)})`],
    ["Unique values", `${fmtNumber(column.unique)} (${fmtPct(column.unique_pct)})`],
  ];
  if (column.numeric) {
    const n = column.numeric;
    stats.push(
      ["Mean · median", `${fmtNumber(n.mean)} · ${fmtNumber(n.median)}`],
      ["Std · skew", `${fmtNumber(n.std)} · ${fmtNumber(n.skew, 2)}`],
      ["Q1 · Q3", `${fmtNumber(n.q1)} · ${fmtNumber(n.q3)}`],
      ["Min · max", `${fmtNumber(n.min)} · ${fmtNumber(n.max)}`],
      ["Zeros · negatives", `${fmtNumber(n.zeros)} · ${fmtNumber(n.negatives)}`],
      ["Outside 1.5×IQR", `${fmtNumber(n.outliers_iqr)} (fences ${fmtNumber(n.lower_fence)} / ${fmtNumber(n.upper_fence)})`],
    );
  }
  if (column.datetime) {
    stats.push(["Range", `${fmtCell(column.datetime.min)} → ${fmtCell(column.datetime.max)}`], ["Span", `${fmtNumber(column.datetime.span_days)} days`]);
  }
  const flags = profile.quality.filter((q) => q.column === column.name);

  return (
    <Panel>
      <PanelHeader title={<ColumnName name={column.name} kind={column.kind} className="text-sm" />} description="Column detail" />
      <div className="flex flex-col gap-4 p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-dense">
          {stats.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-ink-2">{label}</dt>
              <dd className="text-right tabular-nums text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        {flags.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {flags.map((flag) => (
              <li key={flag.code} className="flex gap-2 text-dense">
                <SeverityIcon severity={flag.severity} className="mt-0.5" />
                <span className="text-ink-2">
                  {flag.message} <Badge className="ml-1">{flag.basis}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
        {spec === null ? (
          <div>
            <p className="mb-1 text-2xs text-ink-2">Examples</p>
            <ul className="flex flex-wrap gap-1">
              {column.examples.map((example) => (
                <li key={example} className="max-w-full truncate rounded-sm bg-hover px-1.5 py-0.5 font-mono text-2xs">
                  {example}
                </li>
              ))}
            </ul>
          </div>
        ) : chart.isPending ? (
          <Skeleton className="h-64" />
        ) : chart.isError ? (
          <Notice tone="warning">{errorMessage(chart.error)}</Notice>
        ) : (
          <ChartView data={chart.data} height={240} actions={<SaveFindingButton draft={{ title: `Distribution of ${column.name}`, chart: chart.data }} />} />
        )}
        {chart.isFetching && !chart.isPending && <Spinner label="Updating" />}
      </div>
    </Panel>
  );
}

function CorrelationPanel({ profile }: { profile: DatasetProfile }) {
  const correlation = profile.correlation;
  if (!correlation || correlation.columns.length < 2) {
    return (
      <Panel>
        <PanelHeader title="Correlation" />
        <EmptyState title="Not enough numeric columns">Correlation needs at least two numeric columns.</EmptyState>
      </Panel>
    );
  }
  const chart = localChart(
    { type: "heatmap" },
    {
      heatmap: {
        x_labels: correlation.columns,
        y_labels: correlation.columns,
        values: correlation.matrix,
        value_label: correlation.method === "pearson" ? "Pearson r" : "Spearman ρ",
      },
      series: [],
      meta: {
        ...profileMeta(profile, { sampled: correlation.sampled, aggregation: `${correlation.method} correlation, pairwise complete rows` }),
        n_rows_used: correlation.n_rows_used,
      },
    },
  );
  return (
    <Panel>
      <PanelHeader title="Correlation between numeric columns" description="Association only — correlation does not establish cause." />
      <div className="p-4">
        <ChartView data={chart} showTitle={false} actions={<SaveFindingButton draft={{ title: "Correlation between numeric columns", chart }} />} />
      </div>
    </Panel>
  );
}
