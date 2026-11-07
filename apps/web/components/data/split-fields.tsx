"use client";

import type { ColumnInfo, SplitConfig } from "@/lib/api/types";
import { Field, NumberInput, Select } from "@/components/ui/input";

/**
 * Train / validation split settings shared by Prepare and Model Lab.
 * `stratifyOnTarget` hides the stratify column: experiments stratify on their target.
 */
export function SplitFields({
  columns,
  split,
  onChange,
  stratifyOnTarget = false,
  idPrefix = "split",
}: {
  columns: ColumnInfo[];
  split: SplitConfig;
  onChange: (split: SplitConfig) => void;
  stratifyOnTarget?: boolean;
  idPrefix?: string;
}) {
  const set = (patch: Partial<SplitConfig>) => onChange({ ...split, ...patch });
  const strategy = split.strategy ?? "random";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Strategy" htmlFor={`${idPrefix}-strategy`}>
        <Select id={`${idPrefix}-strategy`} value={strategy} onChange={(event) => set({ strategy: event.target.value as SplitConfig["strategy"] })}>
          <option value="random">random</option>
          <option value="stratified">{stratifyOnTarget ? "stratified on target" : "stratified by a column"}</option>
          <option value="chronological">chronological (latest rows validate)</option>
        </Select>
      </Field>
      <Field label="Validation share" htmlFor={`${idPrefix}-size`} hint="0.05 – 0.5">
        <NumberInput
          id={`${idPrefix}-size`}
          step={0.05}
          min={0.05}
          max={0.5}
          fallback={0.2}
          value={split.test_size ?? 0.2}
          onValueChange={(test_size) => set({ test_size: test_size ?? 0.2 })}
        />
      </Field>
      {strategy === "stratified" && !stratifyOnTarget && (
        <Field label="Stratify on" htmlFor={`${idPrefix}-strat`}>
          <Select id={`${idPrefix}-strat`} value={split.stratify_column ?? ""} onChange={(event) => set({ stratify_column: event.target.value || null })}>
            <option value="">Select…</option>
            {columns
              .filter((c) => c.kind === "categorical" || c.kind === "boolean")
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
      )}
      {strategy === "chronological" && (
        <Field label="Time column" htmlFor={`${idPrefix}-time`}>
          <Select id={`${idPrefix}-time`} value={split.time_column ?? ""} onChange={(event) => set({ time_column: event.target.value || null })}>
            <option value="">Select…</option>
            {columns
              .filter((c) => c.kind === "datetime")
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
          </Select>
        </Field>
      )}
      {strategy !== "chronological" && (
        <Field label="Random seed" htmlFor={`${idPrefix}-seed`}>
          <NumberInput id={`${idPrefix}-seed`} integer min={0} fallback={42} value={split.random_state ?? 42} onValueChange={(random_state) => set({ random_state: random_state ?? 42 })} />
        </Field>
      )}
    </div>
  );
}
