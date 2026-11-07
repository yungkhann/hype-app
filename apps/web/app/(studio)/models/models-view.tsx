"use client";

import { BrainCircuit, CircleCheck, Download, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { API_BASE, errorMessage } from "@/lib/api/client";
import { useDeleteExperiment, useExperiment, useExperiments, useModelCheck, useModels, useStartExperiment } from "@/lib/api/hooks";
import type {
  DatasetDetail,
  ExperimentDetail,
  ExperimentSummary,
  MetricValue,
  ModelCheckRequest,
  ModelCheckResponse,
  ModelName,
  SourceMeta,
  SplitConfig,
  TaskType,
} from "@/lib/api/types";
import { fmtDate, fmtDuration, fmtNumber, fmtPct } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { localChart } from "@/lib/local-chart";
import { cn } from "@/lib/utils";
import { ChartView } from "@/components/charts/chart-view";
import { ColumnMultiSelect } from "@/components/data/column-multi";
import { SplitFields } from "@/components/data/split-fields";
import { SaveFindingButton } from "@/components/findings/save-finding";
import { PageHeader, WithDataset } from "@/components/shell/page";
import { SourceLine } from "@/components/source-line";
import { Button } from "@/components/ui/button";
import { Field, Input, NumberInput, Select } from "@/components/ui/input";
import { Badge, EmptyState, Notice, Panel, PanelHeader, SeverityIcon, Skeleton, Spinner } from "@/components/ui/surface";

/** Hyperparameters exposed per model. Bounds mirror PARAM_BOUNDS in the API, which re-validates. */
const MODEL_PARAMS: Record<string, { key: string; label: string; min: number; max: number; step: number; default: number | null; hint?: string }[]> = {
  logistic_regression: [{ key: "C", label: "Inverse regularisation C", min: 0.0001, max: 10000, step: 0.1, default: 1 }],
  ridge: [{ key: "alpha", label: "Alpha", min: 0.000001, max: 10000, step: 0.1, default: 1 }],
  random_forest: [
    { key: "n_estimators", label: "Trees", min: 10, max: 1000, step: 10, default: 200 },
    { key: "max_depth", label: "Max depth", min: 1, max: 50, step: 1, default: null, hint: "blank = unlimited" },
    { key: "min_samples_leaf", label: "Min rows per leaf", min: 1, max: 500, step: 1, default: 1 },
  ],
  catboost: [
    { key: "iterations", label: "Iterations", min: 10, max: 3000, step: 10, default: 500 },
    { key: "depth", label: "Depth", min: 1, max: 10, step: 1, default: 6 },
    { key: "learning_rate", label: "Learning rate", min: 0.001, max: 1, step: 0.01, default: null, hint: "blank = auto" },
  ],
};
const BALANCE_MODELS = new Set(["logistic_regression", "random_forest", "catboost"]);
const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export function ModelsView() {
  return (
    <WithDataset purpose="Model Lab trains baseline models on the active dataset.">
      {(dataset) => <ModelLab key={dataset.id} dataset={dataset} />}
    </WithDataset>
  );
}

function ModelLab({ dataset }: { dataset: DatasetDetail }) {
  const experiments = useExperiments(dataset.id);
  const [selected, setSelected] = useState<string | null>(null);
  // A deleted experiment must not stay selected: fall back to the newest one that still exists.
  const current = (selected && experiments.data?.some((e) => e.id === selected) ? selected : null) ?? experiments.data?.[0]?.id ?? null;
  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Model Lab"
        description="Optional. Train a model against an honest baseline on a held-out split. Readiness checks flag leakage and identifiers before anything trains."
      />
      <div className="grid gap-4 xl:grid-cols-[400px_minmax(0,1fr)]">
        <Configurator dataset={dataset} onStarted={setSelected} />
        <div className="flex min-w-0 flex-col gap-4">
          <ExperimentList experiments={experiments.data} loading={experiments.isPending} selected={current} onSelect={setSelected} />
          {current && <ExperimentResult id={current} />}
        </div>
      </div>
    </div>
  );
}

/* ---------------- configuration ---------------- */

function Configurator({ dataset, onStarted }: { dataset: DatasetDetail; onStarted: (id: string) => void }) {
  const models = useModels();
  const start = useStartExperiment();
  const [target, setTarget] = useState("");
  const [task, setTask] = useState<TaskType | "">("");
  const [model, setModel] = useState<ModelName | "">("");
  const [features, setFeatures] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  const [split, setSplit] = useState<SplitConfig>({ strategy: "random", test_size: 0.2, random_state: 42 });
  const [params, setParams] = useState<Record<string, number | string | null>>({});
  const [name, setName] = useState("");

  const checkBody: ModelCheckRequest | null = target
    ? { dataset_id: dataset.id, target, task: task || null, features: features.length ? features : null, exclude, split }
    : null;
  const check = useModelCheck(useDebounced(checkBody, 300));
  // The query keeps the previous response while the next one loads; never show one column's readiness for another.
  const checkData = check.data?.target === target ? check.data : undefined;
  const effectiveTask: TaskType = (task || checkData?.suggested_task || "classification") as TaskType;
  const options = (models.data ?? []).filter((m) => m.tasks.includes(effectiveTask));
  const fallback = options.find((m) => m.available && m.name !== "dummy") ?? options[0];
  const chosen = options.find((m) => m.name === model) ?? fallback;
  const paramDefs = chosen ? (MODEL_PARAMS[chosen.name] ?? []) : [];
  const showBalance = Boolean(chosen && effectiveTask === "classification" && BALANCE_MODELS.has(chosen.name));
  const others = dataset.columns.filter((c) => c.name !== target);
  const ready = Boolean(checkData?.can_train && chosen?.available && !check.isFetching);

  function chooseTarget(next: string) {
    setTarget(next);
    // The target can never also be a feature.
    setFeatures((list) => list.filter((c) => c !== next));
    setExclude((list) => list.filter((c) => c !== next));
  }

  async function train() {
    if (!chosen) return;
    const cleanParams: Record<string, unknown> = {};
    for (const p of paramDefs) if (params[p.key] !== null && params[p.key] !== undefined && params[p.key] !== "") cleanParams[p.key] = params[p.key];
    if (showBalance && params.class_weight) cleanParams.class_weight = params.class_weight;
    try {
      const response = await start.mutateAsync({
        dataset_id: dataset.id,
        target,
        task: effectiveTask,
        model: chosen.name as ModelName,
        features: features.length ? features : null,
        exclude,
        split,
        params: cleanParams,
        name: name.trim() || null,
      });
      onStarted(response.id);
      toast.success("Training started", { description: "It runs in the background; you can keep working." });
    } catch (error) {
      toast.error("Could not start training", { description: errorMessage(error) });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader title="Setup" />
        <div className="flex flex-col gap-3 p-4">
          <Field label="Target column" htmlFor="m-target">
            <Select id="m-target" value={target} onChange={(event) => chooseTarget(event.target.value)} data-testid="model-target">
              <option value="">Select what to predict…</option>
              {dataset.columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} · {c.kind}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Task" htmlFor="m-task">
              <Select id="m-task" value={task} onChange={(event) => setTask(event.target.value as TaskType | "")}>
                <option value="">Auto{checkData?.suggested_task ? ` (${checkData.suggested_task})` : ""}</option>
                <option value="classification">classification</option>
                <option value="regression">regression</option>
              </Select>
            </Field>
            <Field label="Model" htmlFor="m-model">
              <Select id="m-model" value={chosen?.name ?? ""} onChange={(event) => setModel(event.target.value as ModelName)}>
                {options.map((m) => (
                  <option key={m.name} value={m.name} disabled={!m.available}>
                    {m.label}
                    {m.available ? "" : " (not installed)"}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Features" hint="empty = every usable column" htmlFor="m-features">
            <ColumnMultiSelect id="m-features" columns={others} value={features} onChange={setFeatures} placeholder="All usable columns" />
          </Field>
          <Field label="Exclude" hint="e.g. columns known only after the outcome" htmlFor="m-exclude">
            <ColumnMultiSelect id="m-exclude" columns={others} value={exclude} onChange={setExclude} placeholder="None" />
          </Field>
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Validation split" description="Metrics come only from held-out rows. Preprocessing is fitted inside the pipeline on train rows." />
        <div className="p-4">
          <SplitFields columns={dataset.columns} split={split} onChange={setSplit} stratifyOnTarget idPrefix="m-split" />
        </div>
      </Panel>
      {chosen && (paramDefs.length > 0 || showBalance) && (
        <Panel>
          <PanelHeader title="Parameters" description={chosen.note ?? "Blank fields use the defaults shown."} />
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {paramDefs.map((p) => (
              <Field key={p.key} label={p.label} hint={p.hint ?? `${p.min} – ${p.max}`} htmlFor={`m-p-${p.key}`}>
                <NumberInput
                  id={`m-p-${p.key}`}
                  allowEmpty
                  min={p.min}
                  max={p.max}
                  step={p.step}
                  placeholder={p.default === null ? "" : String(p.default)}
                  value={typeof params[p.key] === "number" ? (params[p.key] as number) : null}
                  onValueChange={(n) => setParams((v) => ({ ...v, [p.key]: n }))}
                />
              </Field>
            ))}
            {showBalance && (
              <Field label="Class weights" htmlFor="m-p-cw">
                <Select id="m-p-cw" value={String(params.class_weight ?? "")} onChange={(event) => setParams((v) => ({ ...v, class_weight: event.target.value || null }))}>
                  <option value="">equal</option>
                  <option value="balanced">balanced</option>
                </Select>
              </Field>
            )}
          </div>
        </Panel>
      )}
      {target && <Readiness check={checkData} loading={check.isFetching || (Boolean(check.data) && !checkData)} error={check.error} />}
      <Panel className="flex flex-col gap-3 p-4">
        <Field label="Experiment name (optional)" htmlFor="m-name">
          <Input id="m-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder={chosen && target ? `${chosen.label} → ${target}` : ""} />
        </Field>
        <Button variant="primary" onClick={train} disabled={!ready} loading={start.isPending} data-testid="train-model">
          <Play /> Train and evaluate
        </Button>
        <p className="text-2xs text-ink-3">A dummy baseline is always trained on the same split for comparison.</p>
      </Panel>
    </div>
  );
}

function Readiness({ check, loading, error }: { check?: ModelCheckResponse; loading: boolean; error: unknown }) {
  if (error && !check) {
    return (
      <Notice tone="warning" title="Readiness check failed">
        {errorMessage(error)}
      </Notice>
    );
  }
  if (!check) return <Skeleton className="h-28" />;
  const warnings = [...check.warnings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
  const total = (check.class_balance ?? []).reduce((sum, x) => sum + x.count, 0);
  return (
    <Panel data-testid="model-readiness">
      <PanelHeader
        title="Readiness"
        actions={
          loading ? (
            <Spinner label="Checking" />
          ) : check.can_train ? (
            <Badge tone="good">
              <CircleCheck aria-hidden /> can train
            </Badge>
          ) : (
            <Badge tone="critical">cannot train</Badge>
          )
        }
      />
      <div className="flex flex-col gap-3 p-4">
        <dl className="grid grid-cols-3 gap-3 text-dense">
          <div>
            <dt className="text-2xs text-ink-2">Rows with target</dt>
            <dd className="tabular-nums">{fmtNumber(check.n_rows - check.n_target_missing)}</dd>
          </div>
          <div>
            <dt className="text-2xs text-ink-2">Usable features</dt>
            <dd className="tabular-nums">{fmtNumber(check.usable_features.length)}</dd>
          </div>
          <div>
            <dt className="text-2xs text-ink-2">{check.n_classes ? "Classes" : "Target kind"}</dt>
            <dd className="tabular-nums">{check.n_classes ?? check.target_kind}</dd>
          </div>
        </dl>
        {check.class_balance && check.class_balance.length > 0 && total > 0 && (
          <ul className="flex flex-col gap-1" aria-label="Class balance">
            {check.class_balance.slice(0, 6).map((c) => (
              <li key={c.value} className="flex items-center gap-2 text-2xs">
                <span className="w-24 truncate font-mono text-ink">{c.value}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line-strong">
                  <span className="block h-full rounded-full bg-series-1" style={{ width: `${(c.count / total) * 100}%` }} />
                </span>
                <span className="w-24 text-right tabular-nums text-ink-2">
                  {fmtNumber(c.count)} · {fmtPct((c.count / total) * 100)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {warnings.map((w, index) => (
          <div key={index} className="flex gap-2 text-dense">
            <SeverityIcon severity={w.severity as "info" | "warning" | "critical"} className="mt-0.5" />
            <p className="text-ink">
              {w.column && <span className="font-mono text-2xs">{w.column}: </span>}
              {w.message}
            </p>
          </div>
        ))}
        {check.dropped_features.length > 0 && (
          <details className="text-2xs text-ink-2">
            <summary className="cursor-pointer">{check.dropped_features.length} column(s) left out automatically</summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {check.dropped_features.map((d) => (
                <li key={d.column}>
                  <span className="font-mono text-ink">{d.column}</span> — {d.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Panel>
  );
}

/* ---------------- experiments ---------------- */

const STATUS_TONE: Record<string, "neutral" | "info" | "good" | "critical"> = { queued: "neutral", running: "info", succeeded: "good", failed: "critical" };

function metricText(metric?: MetricValue | null) {
  if (!metric || metric.value === null || metric.value === undefined) return "—";
  return `${metric.name} ${fmtNumber(metric.value, 3)}`;
}

function ExperimentList({
  experiments,
  loading,
  selected,
  onSelect,
}: {
  experiments?: ExperimentSummary[];
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const remove = useDeleteExperiment();
  if (loading) return <Skeleton className="h-32" />;
  if (!experiments?.length) {
    return (
      <Panel>
        <EmptyState icon={BrainCircuit} title="No experiments on this dataset yet">
          Pick a target on the left. Results appear here and persist across reloads.
        </EmptyState>
      </Panel>
    );
  }
  return (
    <Panel>
      <PanelHeader title="Experiments" description={`${experiments.length} on this dataset`} />
      <div className="overflow-x-auto">
        <table className="w-full text-dense">
          <thead className="text-left text-2xs text-ink-2">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">Status</th>
              <th className="px-2 py-2 font-medium">Model</th>
              <th className="px-2 py-2 font-medium">Baseline</th>
              <th className="px-2 py-2 font-medium">Time</th>
              <th className="w-10">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {experiments.map((e) => (
              <tr key={e.id} className={cn("border-b border-line last:border-0 hover:bg-hover", e.id === selected && "bg-accent-soft/60")}>
                <td className="max-w-64 px-4 py-2">
                  <button
                    type="button"
                    className="block max-w-full truncate text-left font-medium text-ink hover:underline"
                    onClick={() => onSelect(e.id)}
                    aria-current={e.id === selected ? "true" : undefined}
                  >
                    {e.name}
                  </button>
                  <span className="text-2xs text-ink-3">{fmtDate(e.created_at, true)}</span>
                </td>
                <td className="px-2 py-2">
                  <Badge tone={STATUS_TONE[e.status] ?? "neutral"}>{e.status}</Badge>
                </td>
                <td className="px-2 py-2 tabular-nums">{metricText(e.primary_metric)}</td>
                <td className="px-2 py-2 tabular-nums text-ink-2">{metricText(e.baseline_metric)}</td>
                <td className="px-2 py-2 tabular-nums text-ink-2">{e.duration_s ? fmtDuration(e.duration_s) : "—"}</td>
                <td className="px-2 py-2">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete experiment ${e.name}`}
                    disabled={e.status === "running" || e.status === "queued"}
                    onClick={() => remove.mutate(e.id)}
                  >
                    <Trash2 />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function experimentMeta(e: ExperimentDetail): SourceMeta {
  const s = e.split_info;
  return {
    dataset_id: e.dataset_id,
    dataset_name: e.dataset_name,
    n_rows_total: s ? s.n_train + s.n_test : 0,
    n_rows_used: s ? s.n_test : 0,
    filters: [],
    sampled: Boolean(s?.train_sampled),
    sample_size: s?.train_sampled ? s.n_train_used : null,
    aggregation: s ? `held-out ${s.strategy} split · trained on ${fmtNumber(s.n_train_used)} rows` : null,
    notes: [],
  };
}

function ExperimentResult({ id }: { id: string }) {
  const query = useExperiment(id);
  const e = query.data;
  if (query.isError) return <Notice tone="critical">{errorMessage(query.error)}</Notice>;
  if (!e) return <Skeleton className="h-96" />;
  if (e.status === "queued" || e.status === "running") {
    return (
      <Panel className="flex items-center gap-3 p-6" data-testid="experiment-running">
        <Spinner label={e.status === "queued" ? "Queued" : "Training"} />
        <div>
          <p className="text-dense font-medium text-ink">{e.name}</p>
          <p className="text-2xs text-ink-3">Running in the background. This view refreshes on its own.</p>
        </div>
      </Panel>
    );
  }
  if (e.status === "failed") {
    return (
      <Notice tone="critical" title={`Training failed · ${e.name}`}>
        {e.error ?? "Unknown error."}
      </Notice>
    );
  }
  return <ExperimentReport e={e} />;
}

function ExperimentReport({ e }: { e: ExperimentDetail }) {
  const meta = experimentMeta(e);
  const names = Object.keys(e.metrics);
  const primary = e.primary_metric;
  const baseline = e.baseline_metric;
  const beatBaseline =
    primary && baseline && typeof primary.value === "number" && typeof baseline.value === "number"
      ? primary.higher_is_better
        ? primary.value > baseline.value
        : primary.value < baseline.value
      : null;
  const evidence = names.map((n) => ({ label: `${n} (model / baseline)`, value: `${fmtNumber(e.metrics[n], 3)} / ${fmtNumber(e.baseline_metrics[n], 3)}` }));
  const s = e.split_info;
  const histogram = e.residual_histogram;

  const confusion = e.confusion
    ? localChart(
        { type: "heatmap", x: "predicted", y: "actual" },
        {
          meta,
          x_label: "Predicted",
          y_label: "Actual",
          heatmap: { x_labels: e.confusion.labels, y_labels: e.confusion.labels, values: e.confusion.matrix, value_label: "rows" },
        },
      )
    : null;
  const scatter = e.pred_vs_actual?.length
    ? localChart(
        { type: "scatter", x: "actual", y: "predicted" },
        {
          meta,
          x_label: "Actual",
          y_label: "Predicted",
          x_kind: "numeric",
          series: [],
          rows: e.pred_vs_actual.map((p) => ({ x: p.actual, y: p.predicted, series: "points" })),
        },
      )
    : null;
  const residuals = histogram
    ? localChart(
        { type: "histogram", x: "residual" },
        {
          meta,
          x_label: "Residual (actual − predicted)",
          y_label: "rows",
          x_kind: "numeric",
          series: ["rows"],
          rows: histogram.counts.map((count, i) => {
            const x0 = histogram.edges[i];
            const x1 = histogram.edges[i + 1];
            return { x: (x0 + x1) / 2, x0, x1, rows: count };
          }),
        },
      )
    : null;
  const top = e.feature_importance.slice(0, 15);
  const importance = top.length
    ? localChart(
        { type: "bar", x: "feature", y: "importance", agg: "sum", limit: 15 },
        {
          meta: { ...meta, notes: e.importance_method ? [`Importance: ${e.importance_method}.`] : [] },
          x_label: "Feature",
          y_label: "importance",
          x_kind: "categorical",
          series: ["importance"],
          rows: top.map((f) => ({ x: f.feature, importance: f.importance })),
        },
      )
    : null;

  return (
    <Panel data-testid="experiment-report">
      <PanelHeader
        title={e.name}
        description={`${e.task} · target ${e.target} · ${e.features_used.length} features${e.duration_s ? ` · ${fmtDuration(e.duration_s)}` : ""}`}
        actions={
          <>
            <Button size="sm" variant="ghost" asChild>
              <a href={`${API_BASE}/experiments/${e.id}/predictions.csv`} download>
                <Download /> Predictions
              </a>
            </Button>
            <Button size="sm" variant="ghost" asChild>
              <a href={`${API_BASE}/experiments/${e.id}/metrics.json`} download>
                <Download /> Metrics
              </a>
            </Button>
            <SaveFindingButton
              draft={{
                title: `${e.name}: ${metricText(primary)} vs baseline ${fmtNumber(baseline?.value, 3)}`,
                meta,
                experimentId: e.id,
                evidence,
                methodology: `${e.model} on ${e.features_used.length} features; ${s?.strategy ?? "?"} split with ${fmtNumber(s?.n_test)} held-out rows; compared with a dummy baseline on the same split.`,
                limitations: e.warnings.map((w) => w.message).join("\n"),
              }}
            />
          </>
        }
      />
      <div className="flex flex-col gap-5 p-4">
        {beatBaseline === false && (
          <Notice tone="warning" title="Does not beat the baseline">
            On held-out rows the model is no better than always predicting the {e.task === "classification" ? "class prior" : "mean"}. Treat its patterns as noise.
          </Notice>
        )}
        {e.warnings.map((w, i) => (
          <Notice key={i} tone={w.severity === "critical" ? "critical" : w.severity === "warning" ? "warning" : "info"}>
            {w.column && <span className="font-mono text-2xs">{w.column}: </span>}
            {w.message}
          </Notice>
        ))}
        <div className="overflow-x-auto">
          <table className="w-full max-w-xl text-dense" data-testid="metrics-table">
            <thead className="text-left text-2xs text-ink-2">
              <tr className="border-b border-line">
                <th className="py-1.5 pr-4 font-medium">Metric (held-out)</th>
                <th className="py-1.5 pr-4 text-right font-medium">Model</th>
                <th className="py-1.5 pr-4 text-right font-medium">Dummy baseline</th>
                <th className="py-1.5 text-right font-medium">Difference</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {names.map((n) => {
                const m = e.metrics[n];
                const b = e.baseline_metrics[n];
                return (
                  <tr key={n} className={cn("border-b border-line last:border-0", n === primary?.name && "font-semibold")}>
                    <td className="py-1.5 pr-4">
                      {n}
                      {n === primary?.name && <span className="ml-1.5 text-2xs font-normal text-ink-3">primary</span>}
                    </td>
                    <td className="py-1.5 pr-4 text-right">{fmtNumber(m, 3)}</td>
                    <td className="py-1.5 pr-4 text-right text-ink-2">{fmtNumber(b, 3)}</td>
                    <td className="py-1.5 text-right text-ink-2">{typeof m === "number" && typeof b === "number" ? `${m - b >= 0 ? "+" : ""}${fmtNumber(m - b, 3)}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {s && (
          <p className="text-2xs text-ink-2 tabular-nums">
            Split: {s.strategy}, {fmtNumber(s.n_train)} train / {fmtNumber(s.n_test)} held-out rows (seed {s.random_state})
            {s.train_sampled && `, fitted on a sample of ${fmtNumber(s.n_train_used)} train rows`}
            {s.train_period && s.test_period && ` · train ${s.train_period.join(" → ")} · test ${s.test_period.join(" → ")}`}
            {e.positive_label && ` · positive class “${e.positive_label}”`}
          </p>
        )}
        <div className="grid gap-5 2xl:grid-cols-2">
          {confusion && <ChartView data={confusion} title="Confusion matrix (held-out rows)" height={300} />}
          {scatter && <ChartView data={scatter} title="Predicted vs actual (held-out rows)" height={300} />}
          {residuals && <ChartView data={residuals} title="Residuals (held-out rows)" height={300} />}
          {importance && <ChartView data={importance} title="Feature importance (top 15)" height={Math.max(220, top.length * 26)} />}
        </div>
        <SourceLine meta={meta} />
      </div>
    </Panel>
  );
}
