"use client";

import { ArrowDown, ArrowUp, Download, Eye, FileJson, GitBranch, Plus, Save, Trash2, Upload, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { setActiveDataset } from "@/lib/active-dataset";
import { errorMessage } from "@/lib/api/client";
import { useTransform } from "@/lib/api/hooks";
import type { ColumnInfo, ColumnKind, DatasetDetail, SplitConfig, TransformOp, TransformResult, TransformStep } from "@/lib/api/types";
import { fmtNumber } from "@/lib/format";
import { downloadText, slug } from "@/lib/utils";
import { ColumnMultiSelect } from "@/components/data/column-multi";
import { DataTable } from "@/components/data/data-table";
import { FilterBar } from "@/components/data/filter-bar";
import { SplitFields } from "@/components/data/split-fields";
import { PageHeader, WithDataset } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Field, Input, NumberInput, Select, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Switch } from "@/components/ui/overlays";
import { Badge, EmptyState, Notice, Panel, PanelHeader } from "@/components/ui/surface";

type StepDef = { op: TransformOp; label: string; group: "Columns" | "Rows" | "Values" | "Features"; kinds?: ColumnKind[]; fitted?: boolean; hint: string };

const STEP_DEFS: StepDef[] = [
  { op: "select_columns", label: "Keep columns", group: "Columns", hint: "Keep only the chosen columns." },
  { op: "drop_columns", label: "Drop columns", group: "Columns", hint: "Remove the chosen columns." },
  { op: "rename", label: "Rename columns", group: "Columns", hint: "old → new names." },
  { op: "drop_duplicates", label: "Remove duplicate rows", group: "Rows", hint: "Compare on all or chosen columns; keeps the first." },
  { op: "drop_missing", label: "Drop rows with missing values", group: "Rows", hint: "In any or the chosen columns." },
  { op: "filter_rows", label: "Keep rows matching filters", group: "Rows", hint: "Rows that fail are removed (counted in the log)." },
  { op: "fill_missing", label: "Fill missing values", group: "Values", fitted: true, hint: "Mean/median/mode learn from train rows when a split exists." },
  { op: "cast", label: "Change type", group: "Values", hint: "Values that cannot convert become missing, and are counted." },
  { op: "parse_dates", label: "Parse dates", group: "Values", kinds: ["text", "categorical"], hint: "Optional format, e.g. %d.%m.%Y." },
  { op: "derive_date_parts", label: "Date parts", group: "Features", kinds: ["datetime"], hint: "Year, month, day of week, … as new columns." },
  { op: "derive_ratio", label: "Ratio of two columns", group: "Features", hint: "numerator ÷ denominator; division by zero → missing." },
  { op: "derive_log", label: "Log transform", group: "Features", kinds: ["numeric"], hint: "log(1 + x) for non-negative columns." },
  { op: "bin_numeric", label: "Quantile bins", group: "Features", kinds: ["numeric"], fitted: true, hint: "Bin edges learn from train rows when a split exists." },
  { op: "one_hot", label: "One-hot encode", group: "Features", kinds: ["categorical", "boolean", "text"], fitted: true, hint: "Categories learn from train rows when a split exists." },
  { op: "scale", label: "Scale numbers", group: "Features", kinds: ["numeric"], fitted: true, hint: "Standard or min–max; learns from train rows when a split exists." },
];

const defOf = (op: TransformOp) => STEP_DEFS.find((d) => d.op === op)!;

type DraftStep = TransformStep & { key: number };

let counter = 0;
const newStep = (op: TransformOp): DraftStep => {
  counter += 1;
  const base: DraftStep = { key: counter, op, columns: [] };
  if (op === "fill_missing") return { ...base, strategy: "median" };
  if (op === "cast") return { ...base, to: "numeric" };
  if (op === "bin_numeric") return { ...base, bins: 5 };
  if (op === "scale") return { ...base, method: "standard" };
  if (op === "rename") return { ...base, mapping: {} };
  if (op === "filter_rows") return { ...base, filters: [] };
  return base;
};

/** Strip UI-only keys and empty optionals so the recipe JSON is clean and reproducible. */
export function toRecipe(steps: (TransformStep & { key?: number })[]): TransformStep[] {
  return steps.map((step) => {
    const clean: Record<string, unknown> = { op: step.op };
    for (const [k, v] of Object.entries(step)) {
      if (k === "key" || k === "op") continue;
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
      clean[k] = v;
    }
    return clean as TransformStep;
  });
}

export function PrepareView() {
  return (
    <WithDataset purpose="Preparation builds a reproducible recipe on the active dataset.">
      {(dataset) => <Prepare key={dataset.id} dataset={dataset} />}
    </WithDataset>
  );
}

function Prepare({ dataset }: { dataset: DatasetDetail }) {
  const router = useRouter();
  const transform = useTransform();
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [useSplit, setUseSplit] = useState(false);
  const [split, setSplit] = useState<SplitConfig>({ strategy: "random", test_size: 0.2, random_state: 42 });
  const [result, setResult] = useState<TransformResult | null>(null);
  const [resultKey, setResultKey] = useState("");
  const [name, setName] = useState(`${dataset.name} (prepared)`);
  const [loadOpen, setLoadOpen] = useState(false);
  const [running, setRunning] = useState<"preview" | "save" | null>(null);
  const columns = dataset.columns;

  const body = useMemo(() => ({ steps: toRecipe(steps), split: useSplit ? split : null }), [steps, useSplit, split]);
  const bodyKey = JSON.stringify(body);

  async function run(preview: boolean) {
    setRunning(preview ? "preview" : "save");
    const key = bodyKey;
    try {
      const response = await transform.mutateAsync({ id: dataset.id, body: { ...body, preview, name: preview ? null : name.trim() || null } });
      setResult(response);
      setResultKey(key);
      if (!preview && response.dataset_id) {
        toast.success("Derived dataset created", {
          description: `${fmtNumber(response.n_rows_after)} rows × ${fmtNumber(response.n_cols_after)} columns. The original is unchanged.`,
        });
        setActiveDataset(response.dataset_id);
        router.push("/overview");
      }
    } catch (error) {
      setResult(null);
      toast.error(preview ? "Preview failed" : "Could not save", { description: errorMessage(error) });
    } finally {
      setRunning(null);
    }
  }

  const update = (key: number, patch: Partial<TransformStep>) => setSteps((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const move = (index: number, delta: number) =>
    setSteps((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item);
      return next;
    });
  const nothing = !steps.length && !useSplit;

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Prepare"
        description={`Build an explicit recipe on ${dataset.name}. Preview first; saving creates a new derived dataset with the full log — the source stays untouched.`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setLoadOpen(true)}>
              <Upload /> Load recipe
            </Button>
            <Button
              variant="secondary"
              disabled={!steps.length}
              onClick={() => downloadText(JSON.stringify({ source: dataset.name, ...body }, null, 2), `${slug(dataset.name)}-recipe.json`, "application/json")}
            >
              <FileJson /> Download recipe
            </Button>
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,460px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Panel>
            <PanelHeader
              title="Recipe"
              description={steps.length ? `${steps.length} step${steps.length === 1 ? "" : "s"}, applied top to bottom` : "No steps yet"}
              actions={<AddStepMenu onAdd={(op) => setSteps((list) => [...list, newStep(op)])} />}
            />
            {steps.length === 0 ? (
              <EmptyState icon={Wand2} title="Add the first step">
                Nothing is changed silently: every step reports the rows and columns it touched.
              </EmptyState>
            ) : (
              <ol className="divide-y divide-line">
                {steps.map((step, index) => (
                  <li key={step.key} className="px-4 py-3">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="grid size-5 place-items-center rounded-sm bg-hover text-2xs text-ink-2 tabular-nums">{index + 1}</span>
                      <p className="flex-1 text-dense font-medium text-ink">{defOf(step.op).label}</p>
                      {defOf(step.op).fitted && <Badge tone={useSplit ? "good" : "warning"}>{useSplit ? "learns from train" : "learns from all rows"}</Badge>}
                      <Button size="icon-sm" variant="ghost" aria-label="Move step up" disabled={index === 0} onClick={() => move(index, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label="Move step down" disabled={index === steps.length - 1} onClick={() => move(index, 1)}>
                        <ArrowDown />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label="Remove step" onClick={() => setSteps((list) => list.filter((s) => s.key !== step.key))}>
                        <Trash2 />
                      </Button>
                    </div>
                    <StepFields step={step} columns={columns} onChange={(patch) => update(step.key, patch)} />
                    <p className="mt-1.5 text-2xs text-ink-3">{defOf(step.op).hint}</p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
          <SplitPanel columns={columns} enabled={useSplit} onEnabled={setUseSplit} split={split} onChange={setSplit} />
          <Panel className="flex flex-col gap-3 p-4">
            <Field label="Derived dataset name" htmlFor="prep-name">
              <Input id="prep-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => run(true)} loading={running === "preview"} disabled={nothing || running !== null}>
                <Eye /> Preview
              </Button>
              <Button variant="primary" onClick={() => run(false)} loading={running === "save"} disabled={nothing || running !== null}>
                <Save /> Save as new dataset
              </Button>
            </div>
          </Panel>
        </div>
        <ResultPanel result={result} dataset={dataset} stale={Boolean(result) && resultKey !== bodyKey} />
      </div>
      <LoadRecipeDialog
        open={loadOpen}
        onOpenChange={setLoadOpen}
        onLoad={(recipe) => {
          setSteps(recipe.steps.map((s) => ({ ...newStep(s.op), ...s })));
          // The loaded file is the whole recipe: no split in the file means no split.
          setUseSplit(Boolean(recipe.split));
          if (recipe.split) setSplit(recipe.split);
          setResult(null);
        }}
      />
    </div>
  );
}

function AddStepMenu({ onAdd }: { onAdd: (op: TransformOp) => void }) {
  const groups = ["Columns", "Rows", "Values", "Features"] as const;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" variant="primary">
          <Plus /> Add step
        </Button>
      </MenuTrigger>
      <MenuContent className="max-h-[70vh] w-64 overflow-y-auto">
        {groups.map((group, index) => (
          <div key={group}>
            {index > 0 && <MenuSeparator />}
            <MenuLabel>{group}</MenuLabel>
            {STEP_DEFS.filter((d) => d.group === group).map((def) => (
              <MenuItem key={def.op} onSelect={() => onAdd(def.op)}>
                {def.label}
              </MenuItem>
            ))}
          </div>
        ))}
      </MenuContent>
    </Menu>
  );
}

function StepFields({ step, columns, onChange }: { step: DraftStep; columns: ColumnInfo[]; onChange: (patch: Partial<TransformStep>) => void }) {
  const def = defOf(step.op);
  const eligible = def.kinds ? columns.filter((c) => def.kinds!.includes(c.kind)) : columns;
  const numeric = columns.filter((c) => c.kind === "numeric");
  const id = `step-${step.key}`;

  const columnPicker = (label: string, optional = false) => (
    <Field label={optional ? `${label} (optional)` : label} htmlFor={`${id}-cols`}>
      <ColumnMultiSelect
        id={`${id}-cols`}
        columns={eligible}
        value={step.columns ?? []}
        onChange={(value) => onChange({ columns: value })}
        placeholder={optional ? "All columns" : "Choose columns"}
      />
    </Field>
  );

  switch (step.op) {
    case "select_columns":
    case "drop_columns":
    case "derive_date_parts":
    case "derive_log":
    case "one_hot":
      return columnPicker("Columns");
    case "drop_duplicates":
    case "drop_missing":
      return columnPicker("Compare on", true);
    case "rename":
      return <RenameFields step={step} columns={columns} onChange={onChange} />;
    case "filter_rows":
      return <FilterBar columns={columns} filters={step.filters ?? []} onChange={(filters) => onChange({ filters })} />;
    case "fill_missing":
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
          {columnPicker("Columns")}
          <Field label="Strategy" htmlFor={`${id}-strategy`}>
            <Select id={`${id}-strategy`} value={step.strategy ?? "median"} onChange={(event) => onChange({ strategy: event.target.value as TransformStep["strategy"] })}>
              <option value="median">median</option>
              <option value="mean">mean</option>
              <option value="mode">most frequent</option>
              <option value="constant">constant</option>
            </Select>
          </Field>
          {step.strategy === "constant" && (
            <Field label="Value" htmlFor={`${id}-value`} className="sm:col-span-2">
              <Input id={`${id}-value`} value={String(step.value ?? "")} onChange={(event) => onChange({ value: event.target.value })} />
            </Field>
          )}
        </div>
      );
    case "cast":
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
          {columnPicker("Columns")}
          <Field label="To" htmlFor={`${id}-to`}>
            <Select id={`${id}-to`} value={step.to ?? "numeric"} onChange={(event) => onChange({ to: event.target.value as TransformStep["to"] })}>
              {["numeric", "string", "category", "datetime", "boolean"].map((to) => (
                <option key={to} value={to}>
                  {to}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      );
    case "parse_dates":
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
          {columnPicker("Columns")}
          <Field label="Format" htmlFor={`${id}-format`} hint="blank = infer">
            <Input id={`${id}-format`} value={step.format ?? ""} placeholder="%d.%m.%Y" onChange={(event) => onChange({ format: event.target.value || null })} />
          </Field>
        </div>
      );
    case "derive_ratio":
      return (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Numerator" htmlFor={`${id}-num`}>
            <Select id={`${id}-num`} value={step.numerator ?? ""} onChange={(event) => onChange({ numerator: event.target.value || null })}>
              <option value="">Select…</option>
              {numeric.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Denominator" htmlFor={`${id}-den`}>
            <Select id={`${id}-den`} value={step.denominator ?? ""} onChange={(event) => onChange({ denominator: event.target.value || null })}>
              <option value="">Select…</option>
              {numeric.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="New column" htmlFor={`${id}-new`}>
            <Input id={`${id}-new`} value={step.new_column ?? ""} placeholder="ratio" onChange={(event) => onChange({ new_column: event.target.value || null })} />
          </Field>
        </div>
      );
    case "bin_numeric":
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_100px]">
          {columnPicker("Columns")}
          <Field label="Bins" htmlFor={`${id}-bins`}>
            <NumberInput id={`${id}-bins`} integer min={2} max={50} fallback={5} value={step.bins ?? 5} onValueChange={(bins) => onChange({ bins: bins ?? 5 })} />
          </Field>
        </div>
      );
    case "scale":
      return (
        <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
          {columnPicker("Columns")}
          <Field label="Method" htmlFor={`${id}-method`}>
            <Select id={`${id}-method`} value={step.method ?? "standard"} onChange={(event) => onChange({ method: event.target.value as TransformStep["method"] })}>
              <option value="standard">standard (z)</option>
              <option value="minmax">min–max</option>
            </Select>
          </Field>
        </div>
      );
    default:
      return null;
  }
}

function RenameFields({ step, columns, onChange }: { step: DraftStep; columns: ColumnInfo[]; onChange: (patch: Partial<TransformStep>) => void }) {
  const mapping = step.mapping ?? {};
  const entries = Object.entries(mapping);
  const unused = columns.filter((c) => !(c.name in mapping));
  return (
    <div className="flex flex-col gap-1.5">
      {entries.map(([from, to]) => (
        <div key={from} className="flex items-center gap-2">
          <span className="w-40 truncate font-mono text-2xs text-ink">{from}</span>
          <span className="text-ink-3" aria-hidden>
            →
          </span>
          <Input value={to} aria-label={`New name for ${from}`} className="flex-1" onChange={(event) => onChange({ mapping: { ...mapping, [from]: event.target.value } })} />
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Stop renaming ${from}`}
            onClick={() => {
              const next = { ...mapping };
              delete next[from];
              onChange({ mapping: next });
            }}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Select value="" aria-label="Add column to rename" onChange={(event) => event.target.value && onChange({ mapping: { ...mapping, [event.target.value]: event.target.value } })}>
        <option value="">Add a column to rename…</option>
        {unused.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

function SplitPanel({
  columns,
  enabled,
  onEnabled,
  split,
  onChange,
}: {
  columns: ColumnInfo[];
  enabled: boolean;
  onEnabled: (value: boolean) => void;
  split: SplitConfig;
  onChange: (split: SplitConfig) => void;
}) {
  return (
    <Panel>
      <PanelHeader
        title="Train / validation split"
        description="Adds a “split” column first, so fitted steps (fill, bins, one-hot, scale) learn only from train rows."
        actions={<Switch checked={enabled} onCheckedChange={onEnabled} aria-label="Enable train/validation split" />}
      />
      {enabled && (
        <div className="p-4">
          <SplitFields columns={columns} split={split} onChange={onChange} />
        </div>
      )}
    </Panel>
  );
}

function ResultPanel({ result, dataset, stale }: { result: TransformResult | null; dataset: DatasetDetail; stale: boolean }) {
  if (!result) {
    return (
      <Panel>
        <EmptyState icon={Eye} title="Preview the recipe">
          See the exact effect of every step on {fmtNumber(dataset.n_rows)} rows before anything is saved.
        </EmptyState>
      </Panel>
    );
  }
  return (
    <Panel>
      <PanelHeader
        title={result.preview ? "Preview" : "Saved"}
        description={
          <span className="tabular-nums">
            rows {fmtNumber(result.n_rows_before)} → {fmtNumber(result.n_rows_after)} · columns {fmtNumber(result.n_cols_before)} → {fmtNumber(result.n_cols_after)}
          </span>
        }
        actions={
          result.dataset_id ? (
            <Badge tone="good">
              <GitBranch aria-hidden /> derived dataset created
            </Badge>
          ) : (
            <Badge>not saved</Badge>
          )
        }
      />
      <div className="flex flex-col gap-4 p-4">
        {stale && (
          <Notice tone="warning" title="Out of date">
            The recipe changed after this {result.preview ? "preview" : "save"}. Preview again to see the effect of the current steps.
          </Notice>
        )}
        {result.warnings.map((warning) => (
          <Notice key={warning} tone="warning">
            {warning}
          </Notice>
        ))}
        <ol className="flex flex-col gap-1.5">
          {result.log.map((step, index) => (
            <li key={index} className="flex gap-2 text-dense">
              <span className="grid size-5 shrink-0 place-items-center rounded-sm bg-hover text-2xs text-ink-2 tabular-nums">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-ink">{step.description}</p>
                <p className="text-2xs text-ink-3 tabular-nums">
                  {fmtNumber(step.rows_before)} → {fmtNumber(step.rows_after)} rows
                  {step.columns_added.length > 0 && ` · added ${step.columns_added.join(", ")}`}
                  {step.columns_removed.length > 0 && ` · removed ${step.columns_removed.join(", ")}`}
                  {step.fit_scope !== "none" && ` · fitted on ${step.fit_scope.replace("_", " ")}`}
                </p>
              </div>
            </li>
          ))}
        </ol>
        <div>
          <p className="mb-1.5 text-2xs text-ink-2">First {result.rows.length} rows of the result</p>
          <DataTable columns={result.columns} rows={result.rows} maxHeight="420px" />
        </div>
        <Button size="sm" variant="ghost" className="self-start" onClick={() => downloadText(JSON.stringify(result.log, null, 2), "transform-log.json", "application/json")}>
          <Download /> Download step log
        </Button>
      </div>
    </Panel>
  );
}

function LoadRecipeDialog({
  open,
  onOpenChange,
  onLoad,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoad: (recipe: { steps: TransformStep[]; split?: SplitConfig | null }) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const known = new Set(STEP_DEFS.map((d) => d.op));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          title="Load recipe"
          description="Paste a recipe downloaded from ATLAS. It is validated again when you preview."
          footer={
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  try {
                    const parsed = JSON.parse(text) as { steps?: TransformStep[]; split?: SplitConfig | null };
                    if (!Array.isArray(parsed.steps) || parsed.steps.some((s) => !known.has(s.op))) throw new Error("The recipe needs a “steps” list of known operations.");
                    onLoad({ steps: parsed.steps, split: parsed.split ?? null });
                    setError(null);
                    onOpenChange(false);
                  } catch (cause) {
                    setError((cause as Error).message);
                  }
                }}
              >
                Load
              </Button>
            </>
          }
        >
          <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={10} className="font-mono text-2xs" aria-label="Recipe JSON" />
          {error && (
            <Notice tone="critical" className="mt-2">
              {error}
            </Notice>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}
