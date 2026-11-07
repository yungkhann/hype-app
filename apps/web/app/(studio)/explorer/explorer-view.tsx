"use client";

import { BarChart3, Bookmark, Columns3, Download, Plus, Search, Sigma, Table2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { apiBlob, errorMessage } from "@/lib/api/client";
import { useAggregate, useChart, useDeleteView, useQueryRows, useSaveView, useViews } from "@/lib/api/hooks";
import type { AggFn, AggregateRequest, ChartSpec, ColumnInfo, DatasetDetail, Filter, Metric, SavedView, SortKey } from "@/lib/api/types";
import { tableCsv } from "@/lib/chart-export";
import { fmtNumber } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { downloadBlob, downloadText, slug } from "@/lib/utils";
import { ChartBuilder, defaultSpec, specProblem } from "@/components/charts/chart-builder";
import { ChartView } from "@/components/charts/chart-view";
import { DataTable } from "@/components/data/data-table";
import { FilterBar } from "@/components/data/filter-bar";
import { SaveFindingButton } from "@/components/findings/save-finding";
import { PageHeader, WithDataset } from "@/components/shell/page";
import { SourceLine } from "@/components/source-line";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import {
  Checkbox,
  Dialog,
  DialogContent,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/overlays";
import { EmptyState, Notice, Panel, Skeleton } from "@/components/ui/surface";

type Tab = "rows" | "group" | "chart";

interface ExplorerState {
  tab: Tab;
  filters: Filter[];
  search: string;
  sort: SortKey[];
  hidden: string[];
  pageSize: number;
  groupBy: string[];
  metrics: Metric[];
  chart: ChartSpec;
}

export function ExplorerView() {
  return (
    <WithDataset purpose="The explorer browses, filters, groups, and charts the active dataset.">
      {(dataset) => <Explorer key={dataset.id} dataset={dataset} />}
    </WithDataset>
  );
}

function initialState(columns: ColumnInfo[]): ExplorerState {
  const category = columns.find((c) => c.kind === "categorical" || c.kind === "boolean");
  return {
    tab: "rows",
    filters: [],
    search: "",
    sort: [],
    hidden: [],
    pageSize: 50,
    groupBy: category ? [category.name] : [],
    metrics: [{ agg: "count", column: null }],
    chart: defaultSpec(columns),
  };
}

function Explorer({ dataset }: { dataset: DatasetDetail }) {
  const columns = dataset.columns;
  const [state, setState] = useState<ExplorerState>(() => initialState(columns));
  const set = (patch: Partial<ExplorerState>) => setState((s) => ({ ...s, ...patch }));

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Explorer"
        description={`${dataset.name} · ${fmtNumber(dataset.n_rows)} rows × ${fmtNumber(dataset.n_cols)} columns. Filters apply to rows, groups, and charts alike.`}
        actions={<SavedViews dataset={dataset} state={state} onApply={(next) => setState({ ...initialState(columns), ...next })} />}
      />
      <Panel className="mb-4 px-3 py-2">
        <FilterBar columns={columns} filters={state.filters} onChange={(filters) => set({ filters })} />
      </Panel>
      <Tabs value={state.tab} onValueChange={(tab) => set({ tab: tab as Tab })}>
        <TabsList className="mb-4">
          <TabsTrigger value="rows">
            <Table2 aria-hidden /> Rows
          </TabsTrigger>
          <TabsTrigger value="group">
            <Sigma aria-hidden /> Group &amp; aggregate
          </TabsTrigger>
          <TabsTrigger value="chart">
            <BarChart3 aria-hidden /> Chart builder
          </TabsTrigger>
        </TabsList>
        <TabsContent value="rows">
          <RowsTab dataset={dataset} state={state} set={set} />
        </TabsContent>
        <TabsContent value="group">
          <GroupTab dataset={dataset} state={state} set={set} />
        </TabsContent>
        <TabsContent value="chart">
          <ChartTab dataset={dataset} state={state} set={set} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ---------------- rows ---------------- */

function RowsTab({ dataset, state, set }: { dataset: DatasetDetail; state: ExplorerState; set: (p: Partial<ExplorerState>) => void }) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState(state.search);
  const debouncedSearch = useDebounced(search, 300);
  const visible = useMemo(() => dataset.columns.filter((c) => !state.hidden.includes(c.name)), [dataset.columns, state.hidden]);
  const [exporting, setExporting] = useState(false);
  const [resetKey, setResetKey] = useState("");
  // A saved view can replace the search from outside; show it in the box (typing is pushed up via the debounce).
  const [syncedSearch, setSyncedSearch] = useState(state.search);
  if (state.search !== syncedSearch) {
    setSyncedSearch(state.search);
    if (state.search !== debouncedSearch) setSearch(state.search);
  }

  useEffect(() => {
    if (debouncedSearch !== state.search) set({ search: debouncedSearch });
  }, [debouncedSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back to page 1 whenever the row set changes.
  const queryKey = JSON.stringify([state.filters, state.search, state.sort, state.pageSize]);
  if (queryKey !== resetKey) {
    setResetKey(queryKey);
    setOffset(0);
  }

  const body = {
    filters: state.filters,
    search: state.search || null,
    sort: state.sort,
    columns: visible.length === dataset.columns.length ? null : visible.map((c) => c.name),
    offset,
    limit: state.pageSize,
  };
  const query = useQueryRows(dataset.id, body);

  async function exportCsv() {
    setExporting(true);
    try {
      const blob = await apiBlob(`/datasets/${dataset.id}/export`, { body: { ...body, offset: 0 } });
      downloadBlob(blob, `${slug(dataset.name)}-filtered.csv`);
    } catch (error) {
      toast.error("Export failed", { description: errorMessage(error) });
    } finally {
      setExporting(false);
    }
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="relative min-w-48 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search all text…" className="pl-8" aria-label="Search rows" />
        </div>
        <ColumnPicker columns={dataset.columns} hidden={state.hidden} onChange={(hidden) => set({ hidden })} />
        <Select value={String(state.pageSize)} onChange={(event) => set({ pageSize: Number(event.target.value) })} aria-label="Rows per page" className="w-32">
          {[25, 50, 100, 200, 500].map((size) => (
            <option key={size} value={size}>
              {size} per page
            </option>
          ))}
        </Select>
        {state.sort.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => set({ sort: [] })}>
            <X /> Clear sort
          </Button>
        )}
        <div className="ml-auto">
          <Button size="sm" variant="secondary" onClick={exportCsv} loading={exporting} disabled={!query.data}>
            <Download /> Export {query.data ? fmtNumber(query.data.filtered_rows) : ""} rows
          </Button>
        </div>
      </div>
      <div className="p-3">
        {query.isError ? (
          <Notice tone="critical">{errorMessage(query.error)}</Notice>
        ) : query.isPending ? (
          <Skeleton className="h-96" />
        ) : (
          <>
            <DataTable
              columns={query.data.columns}
              rows={query.data.rows}
              sort={state.sort}
              onSortChange={(sort) => set({ sort })}
              offset={query.data.offset}
              limit={query.data.limit}
              total={query.data.filtered_rows}
              onPageChange={setOffset}
              loading={query.isFetching}
            />
            <SourceLine
              className="mt-2"
              meta={{
                dataset_id: dataset.id,
                dataset_name: dataset.name,
                n_rows_total: query.data.total_rows,
                n_rows_used: query.data.filtered_rows,
                filters: state.filters,
                sampled: false,
                sample_size: null,
                aggregation: state.search ? `search “${state.search}”` : null,
                notes: [],
              }}
            />
          </>
        )}
      </div>
    </Panel>
  );
}

function ColumnPicker({ columns, hidden, onChange }: { columns: ColumnInfo[]; hidden: string[]; onChange: (hidden: string[]) => void }) {
  const [query, setQuery] = useState("");
  const shown = columns.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="md" variant="secondary">
          <Columns3 /> Columns
          {hidden.length > 0 && (
            <span className="text-ink-3 tabular-nums">
              {columns.length - hidden.length}/{columns.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <div className="border-b border-line p-2">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find column" aria-label="Find column" className="h-7" />
          <div className="mt-2 flex gap-3">
            <Button size="sm" variant="link" onClick={() => onChange([])}>
              Show all
            </Button>
            <Button size="sm" variant="link" onClick={() => onChange(columns.slice(1).map((c) => c.name))}>
              Hide all but first
            </Button>
          </div>
        </div>
        <ul className="max-h-72 overflow-y-auto p-1">
          {shown.map((column) => {
            const checked = !hidden.includes(column.name);
            return (
              <li key={column.name}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-dense hover:bg-hover">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(value) => onChange(value ? hidden.filter((h) => h !== column.name) : [...hidden, column.name])}
                    disabled={checked && hidden.length === columns.length - 1}
                  />
                  <span className="truncate font-mono text-2xs">{column.name}</span>
                  <span className="ml-auto text-2xs text-ink-3">{column.kind}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/* ---------------- group & aggregate ---------------- */

const AGGS: AggFn[] = ["count", "sum", "mean", "median", "min", "max", "nunique", "std"];

function GroupTab({ dataset, state, set }: { dataset: DatasetDetail; state: ExplorerState; set: (p: Partial<ExplorerState>) => void }) {
  const numeric = dataset.columns.filter((c) => c.kind === "numeric");
  const request: AggregateRequest | null = state.groupBy.length
    ? { group_by: state.groupBy, metrics: state.metrics, filters: state.filters, limit: 500 }
    : null;
  const result = useAggregate(dataset.id, request);
  const groupable = dataset.columns;

  function updateMetric(index: number, patch: Partial<Metric>) {
    set({ metrics: state.metrics.map((m, i) => (i === index ? { ...m, ...patch } : m)) });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Panel className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-2">
          <p className="text-dense font-medium text-ink">Group by</p>
          {state.groupBy.map((column, index) => (
            <div key={index} className="flex gap-1">
              <Select
                value={column}
                aria-label={`Group column ${index + 1}`}
                className="min-w-0 flex-1"
                onChange={(event) => set({ groupBy: state.groupBy.map((g, i) => (i === index ? event.target.value : g)) })}
              >
                {groupable.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} · {c.kind}
                  </option>
                ))}
              </Select>
              <Button size="icon" variant="ghost" aria-label="Remove group column" onClick={() => set({ groupBy: state.groupBy.filter((_, i) => i !== index) })}>
                <X />
              </Button>
            </div>
          ))}
          {state.groupBy.length < 3 && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => set({ groupBy: [...state.groupBy, groupable.find((c) => !state.groupBy.includes(c.name))?.name ?? groupable[0].name] })}
            >
              <Plus /> Add group column
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-dense font-medium text-ink">Measures</p>
          {state.metrics.map((metric, index) => (
            <div key={index} className="flex gap-1">
              <Select
                value={metric.agg}
                aria-label={`Aggregation ${index + 1}`}
                className="w-28"
                onChange={(event) => {
                  const agg = event.target.value as AggFn;
                  // sum/mean/… need a numeric column; nunique accepts any. Never keep a column the select cannot show.
                  const keep = agg === "nunique" ? metric.column : numeric.some((c) => c.name === metric.column) ? metric.column : null;
                  const first = agg === "nunique" ? dataset.columns[0]?.name : numeric[0]?.name;
                  updateMetric(index, { agg, column: agg === "count" ? null : (keep ?? first ?? null) });
                }}
              >
                {AGGS.map((agg) => (
                  <option key={agg} value={agg}>
                    {agg}
                  </option>
                ))}
              </Select>
              <Select
                value={metric.column ?? ""}
                aria-label={`Measure column ${index + 1}`}
                className="min-w-0 flex-1"
                onChange={(event) => updateMetric(index, { column: event.target.value || null })}
                disabled={metric.agg === "count"}
              >
                {metric.agg === "count" && <option value="">rows</option>}
                {(metric.agg === "nunique" ? dataset.columns : numeric).map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Remove measure"
                disabled={state.metrics.length === 1}
                onClick={() => set({ metrics: state.metrics.filter((_, i) => i !== index) })}
              >
                <X />
              </Button>
            </div>
          ))}
          {state.metrics.length < 10 && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              disabled={!numeric.length}
              onClick={() => set({ metrics: [...state.metrics, { agg: "mean", column: numeric[0]?.name ?? null }] })}
            >
              <Plus /> Add measure
            </Button>
          )}
        </div>
      </Panel>
      <Panel>
        {!request ? (
          <EmptyState icon={Sigma} title="Pick a column to group by" />
        ) : result.isError ? (
          <div className="p-4">
            <Notice tone="warning" title="This grouping cannot be computed">
              {errorMessage(result.error)}
            </Notice>
          </div>
        ) : result.isPending ? (
          <Skeleton className="m-4 h-72" />
        ) : (
          <div className="flex flex-col gap-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-dense text-ink-2 tabular-nums">
                {fmtNumber(result.data.total_groups)} groups{result.data.truncated && ` · first ${fmtNumber(result.data.rows.length)} shown`}
              </p>
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" onClick={() => downloadText(tableCsv(result.data.columns, result.data.rows), `${slug(dataset.name)}-grouped.csv`, "text/csv")}>
                  <Download /> CSV
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const metric = state.metrics[0];
                    // A chart shows one measure over at most two dimensions; say what the table had that it drops.
                    const extra = [...state.groupBy.slice(2).map((c) => `group "${c}"`), ...state.metrics.slice(1).map((m) => `measure ${m.agg}${m.column ? `(${m.column})` : ""}`)];
                    if (extra.length) toast("Charted the first measure over the first two groups", { description: `Not in the chart: ${extra.join(", ")}.` });
                    set({
                      tab: "chart",
                      chart: { type: "bar", x: state.groupBy[0], y: metric.agg === "count" ? null : metric.column, agg: metric.agg, group: state.groupBy[1] ?? null },
                    });
                  }}
                >
                  <BarChart3 /> Chart this
                </Button>
              </div>
            </div>
            <DataTable
              columns={result.data.columns.map((name, index) => ({ name, dtype: "", kind: index < state.groupBy.length ? "categorical" : "numeric" }))}
              rows={result.data.rows}
              loading={result.isFetching}
            />
            <SourceLine meta={result.data.meta} />
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ---------------- chart builder ---------------- */

function ChartTab({ dataset, state, set }: { dataset: DatasetDetail; state: ExplorerState; set: (p: Partial<ExplorerState>) => void }) {
  const spec = useMemo(() => ({ ...state.chart, filters: state.filters }), [state.chart, state.filters]);
  const problem = specProblem(spec);
  const debounced = useDebounced(problem ? null : spec, 250);
  const chart = useChart(dataset.id, debounced);

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Panel className="p-4">
        <ChartBuilder spec={state.chart} columns={dataset.columns} onChange={(chartSpec) => set({ chart: chartSpec })} />
      </Panel>
      <Panel className="min-h-96 p-4">
        {problem ? (
          <EmptyState icon={BarChart3} title="Almost there">
            {problem}
          </EmptyState>
        ) : chart.isError ? (
          <Notice tone="warning" title="This combination cannot be drawn">
            {errorMessage(chart.error)}
          </Notice>
        ) : chart.isPending || !chart.data ? (
          <Skeleton className="h-80" />
        ) : (
          <ChartView data={chart.data} actions={<SaveFindingButton draft={{ title: "", chart: chart.data }} />} />
        )}
      </Panel>
    </div>
  );
}

/* ---------------- saved views ---------------- */

function SavedViews({ dataset, state, onApply }: { dataset: DatasetDetail; state: ExplorerState; onApply: (state: Partial<ExplorerState>) => void }) {
  const views = useViews(dataset.id);
  const save = useSaveView();
  const remove = useDeleteView();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const known = new Set(dataset.columns.map((c) => c.name));

  // A view saved on another dataset (or before a column was renamed) may name columns that no longer exist.
  // Drop those parts and say so, instead of sending queries the API will reject.
  function apply(view: SavedView) {
    const spec = view.spec as Partial<ExplorerState>;
    let dropped = 0;
    function keep<T>(list: T[] | undefined, column: (item: T) => string | null | undefined): T[] | undefined {
      if (!list) return undefined;
      const kept = list.filter((item) => {
        const name = column(item);
        return name === null || name === undefined || known.has(name);
      });
      dropped += list.length - kept.length;
      return kept;
    }
    const next: Partial<ExplorerState> = {
      ...spec,
      filters: keep(spec.filters, (f) => f.column) ?? [],
      sort: keep(spec.sort, (k) => k.column),
      hidden: keep(spec.hidden, (c) => c),
      groupBy: keep(spec.groupBy, (c) => c),
      metrics: keep(spec.metrics, (m) => m.column),
    };
    if (next.metrics?.length === 0) delete next.metrics;
    if (spec.chart) {
      const chart = { ...spec.chart };
      for (const key of ["x", "y", "group"] as const) {
        const name = chart[key];
        if (typeof name === "string" && !known.has(name)) {
          chart[key] = null;
          dropped += 1;
        }
      }
      next.chart = chart;
    }
    for (const key of Object.keys(next) as (keyof ExplorerState)[]) if (next[key] === undefined) delete next[key];
    onApply(next);
    toast(`Applied “${view.name}”`, dropped ? { description: `${dropped} setting(s) skipped: their columns are not in this dataset.` } : undefined);
  }

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="secondary">
            <Bookmark /> Saved views {views.data?.length ? <span className="text-ink-3 tabular-nums">{views.data.length}</span> : null}
          </Button>
        </MenuTrigger>
        <MenuContent className="w-72">
          <MenuItem
            onSelect={() => {
              setName(state.tab === "chart" ? `${state.chart.type} of ${state.chart.x ?? "columns"}` : `View ${(views.data?.length ?? 0) + 1}`);
              setOpen(true);
            }}
          >
            <Plus aria-hidden /> Save current view…
          </MenuItem>
          {(views.data?.length ?? 0) > 0 && <MenuSeparator />}
          {(views.data?.length ?? 0) > 0 && <MenuLabel>This dataset</MenuLabel>}
          {views.data?.map((view) => (
            <div key={view.id} className="flex items-center">
              <MenuItem className="min-w-0 flex-1" onSelect={() => apply(view)}>
                {view.kind === "chart" ? <BarChart3 aria-hidden /> : <Table2 aria-hidden />}
                <span className="truncate">{view.name}</span>
              </MenuItem>
              {/* A menu item too, so arrow keys reach it; "Delete view …" is its accessible name. */}
              <MenuItem
                danger
                className="shrink-0 px-1.5"
                aria-label={`Delete view ${view.name}`}
                onSelect={() =>
                  remove.mutate(view.id, {
                    onSuccess: () => toast(`Deleted view “${view.name}”`),
                    onError: (error) => toast.error("Could not delete the view", { description: errorMessage(error) }),
                  })
                }
              >
                <Trash2 aria-hidden />
              </MenuItem>
            </div>
          ))}
        </MenuContent>
      </Menu>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <DialogContent
            title="Save view"
            description="Stores the filters, search, sorting, visible columns, grouping, and chart settings."
            footer={
              <>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={save.isPending}
                  disabled={!name.trim()}
                  onClick={async () => {
                    try {
                      await save.mutateAsync({
                        name: name.trim(),
                        dataset_id: dataset.id,
                        kind: state.tab === "chart" ? "chart" : "table",
                        spec: state as unknown as Record<string, unknown>,
                      });
                      toast.success("View saved");
                      setOpen(false);
                    } catch (error) {
                      toast.error(errorMessage(error));
                    }
                  }}
                >
                  Save
                </Button>
              </>
            }
          >
            <Field label="Name" htmlFor="view-name">
              <Input id="view-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoFocus />
            </Field>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
