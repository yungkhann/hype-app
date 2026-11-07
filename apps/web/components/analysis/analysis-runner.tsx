"use client";

import { Download, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { errorMessage } from "@/lib/api/client";
import { useRunAnalysis } from "@/lib/api/hooks";
import type { AnalysisInfo, AnalysisResult, ColumnInfo, DatasetDetail, Filter } from "@/lib/api/types";
import { tableCsv } from "@/lib/chart-export";
import { cleanValues, columnsForField, defaultValues, fieldsFromSchema, missingRequired, type FormField } from "@/lib/schema-form";
import { downloadText, slug } from "@/lib/utils";
import { ChartView } from "@/components/charts/chart-view";
import { ColumnMultiSelect } from "@/components/data/column-multi";
import { DataTable } from "@/components/data/data-table";
import { SaveFindingButton } from "@/components/findings/save-finding";
import { SourceLine } from "@/components/source-line";
import { Button } from "@/components/ui/button";
import { Field, Input, NumberInput, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/overlays";
import { Notice, Panel, PanelHeader, Stat } from "@/components/ui/surface";

/** Guess sensible starting columns so the first run needs as few clicks as possible. */
function seedValues(fields: FormField[], columns: ColumnInfo[]): Record<string, unknown> {
  const values = defaultValues(fields);
  const taken = new Set<string>();
  for (const field of fields) {
    if (values[field.name] !== undefined && values[field.name] !== null) continue;
    const eligible = columnsForField(field, columns).filter((c) => !taken.has(c.name));
    if (field.widget === "column" && field.required && eligible[0]) {
      values[field.name] = eligible[0].name;
      taken.add(eligible[0].name);
    }
    if (field.widget === "columns" && field.required) values[field.name] = eligible.slice(0, 4).map((c) => c.name);
  }
  return values;
}

export function AnalysisRunner({ dataset, analysis, filters }: { dataset: DatasetDetail; analysis: AnalysisInfo; filters: Filter[] }) {
  const fields = useMemo(() => fieldsFromSchema(analysis.params_schema as Record<string, unknown>), [analysis.params_schema]);
  const [values, setValues] = useState<Record<string, unknown>>(() => seedValues(fields, dataset.columns));
  const run = useRunAnalysis();
  const missing = missingRequired(fields, values);

  function execute() {
    run.mutate({ datasetId: dataset.id, analysisId: analysis.id, params: cleanValues(fields, values), filters });
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader title={analysis.title} description={analysis.description} />
        <form
          className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            execute();
          }}
        >
          {fields.map((field) => (
            <ParamField
              key={field.name}
              field={field}
              columns={dataset.columns}
              value={values[field.name]}
              onChange={(value) => setValues((v) => ({ ...v, [field.name]: value }))}
            />
          ))}
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2 xl:col-span-3">
            <Button type="submit" variant="primary" loading={run.isPending} disabled={missing.length > 0} data-testid="run-analysis">
              <Play /> Run
            </Button>
            {missing.length > 0 && <p className="text-2xs text-ink-3">Required: {missing.join(", ")}</p>}
            {filters.length > 0 && <p className="text-2xs text-ink-3">Runs on rows matching {filters.length} filter(s).</p>}
          </div>
        </form>
      </Panel>
      {run.isError && (
        <Notice tone="warning" title="The analysis could not run with these settings">
          {errorMessage(run.error)}
        </Notice>
      )}
      {run.data && <AnalysisResultView result={run.data} datasetName={dataset.name} />}
    </div>
  );
}

function ParamField({ field, columns, value, onChange }: { field: FormField; columns: ColumnInfo[]; value: unknown; onChange: (value: unknown) => void }) {
  const id = `param-${field.name}`;
  const label = field.required ? field.label : `${field.label} (optional)`;
  const hint = field.description || (field.kinds ? field.kinds.join(" / ") : undefined);
  switch (field.widget) {
    case "column": {
      const eligible = columnsForField(field, columns);
      return (
        <Field label={label} hint={hint} htmlFor={id}>
          <Select id={id} value={String(value ?? "")} onChange={(event) => onChange(event.target.value || null)}>
            <option value="">{eligible.length ? "Select…" : "No suitable columns"}</option>
            {eligible.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      );
    }
    case "columns":
      return (
        <Field label={label} hint={hint} htmlFor={id}>
          <ColumnMultiSelect id={id} columns={columnsForField(field, columns)} value={(value as string[]) ?? []} onChange={onChange} />
        </Field>
      );
    case "boolean":
      return (
        <Field label={label} hint={hint} htmlFor={id}>
          <Switch id={id} checked={Boolean(value)} onCheckedChange={onChange} />
        </Field>
      );
    case "select":
      return (
        <Field label={label} hint={hint} htmlFor={id}>
          <Select id={id} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
            {field.options?.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "number":
    case "integer":
      return (
        <Field label={label} hint={hint ?? rangeHint(field)} htmlFor={id}>
          <NumberInput
            id={id}
            allowEmpty
            integer={field.widget === "integer"}
            min={field.minimum}
            max={field.maximum}
            value={typeof value === "number" ? value : null}
            onValueChange={onChange}
          />
        </Field>
      );
    default:
      return (
        <Field label={label} hint={hint} htmlFor={id}>
          <Input id={id} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
        </Field>
      );
  }
}

function rangeHint(field: FormField) {
  if (field.minimum !== undefined && field.maximum !== undefined) return `${field.minimum} – ${field.maximum}`;
  if (field.minimum !== undefined) return `≥ ${field.minimum}`;
  if (field.maximum !== undefined) return `≤ ${field.maximum}`;
  return undefined;
}

export function AnalysisResultView({ result, datasetName }: { result: AnalysisResult; datasetName: string }) {
  const evidence = result.summary.map((s) => ({ label: s.label, value: s.value }));
  const table = result.table;
  return (
    <Panel>
      <PanelHeader
        title={`Result · ${result.title}`}
        actions={
          <SaveFindingButton
            draft={{
              title: result.chart ? "" : result.title,
              chart: result.chart,
              meta: result.meta,
              methodology: `Analysis “${result.title}”.`,
              evidence,
              limitations: result.notes.join("\n"),
            }}
          />
        }
      />
      <div className="flex flex-col gap-5 p-4">
        {result.summary.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            {result.summary.map((item) => (
              <Stat key={item.label} label={item.label} value={item.value} detail={item.hint} />
            ))}
          </dl>
        )}
        {result.notes.length > 0 && (
          <Notice tone="info" title="How to read this">
            <ul className="list-disc pl-4">
              {result.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Notice>
        )}
        {result.chart && <ChartView data={result.chart} />}
        {table && table.rows.length > 0 && (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-2xs text-ink-2 tabular-nums">{table.rows.length} rows</p>
              <Button size="sm" variant="ghost" onClick={() => downloadText(tableCsv(table.columns, table.rows), `${slug(datasetName)}-${slug(result.analysis_id)}.csv`, "text/csv")}>
                <Download /> CSV
              </Button>
            </div>
            <DataTable
              columns={table.columns.map((name, index) => ({
                name,
                dtype: "",
                kind: typeof table.rows[0]?.[index] === "number" ? "numeric" : "categorical",
              }))}
              rows={table.rows}
              maxHeight="420px"
            />
          </div>
        )}
        <SourceLine meta={result.meta} />
      </div>
    </Panel>
  );
}
