"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, NumberInput, Select, Textarea, useFieldId } from "@/components/ui/input";
import { Switch } from "@/components/ui/overlays";
import { criterionIdFrom, uniqueId } from "@/lib/cqa/format";
import type { AnswerOption, AnswerType, Criterion, Section } from "@/lib/cqa/types";

/**
 * Every setting of one criterion: name, description, section, weight, answer type (yes/no, numeric scale or
 * scored options), N/A and severe-error rules. Controlled; validation messages come from the parent.
 */
export function CriterionForm({
  value,
  onChange,
  sections,
  idEditable,
  takenIds,
}: {
  value: Criterion;
  onChange: (next: Criterion) => void;
  sections: Section[];
  idEditable: boolean;
  takenIds: string[];
}) {
  const [idTouched, setIdTouched] = useState(false);
  const ids = {
    name: useFieldId("name"),
    id: useFieldId("id"),
    description: useFieldId("desc"),
    section: useFieldId("section"),
    weight: useFieldId("weight"),
    type: useFieldId("type"),
    min: useFieldId("min"),
    max: useFieldId("max"),
    step: useFieldId("step"),
    na: useFieldId("na"),
    naRule: useFieldId("narule"),
    severe: useFieldId("severe"),
    severeRule: useFieldId("severerule"),
  };
  const set = (patch: Partial<Criterion>) => onChange({ ...value, ...patch });
  const scale = { min: value.scale?.min ?? 0, max: value.scale?.max ?? 5, step: value.scale?.step ?? 1, labels: value.scale?.labels ?? {} };
  const type: AnswerType = value.answer_type ?? "binary";
  const options = value.options ?? [];

  const setType = (next: AnswerType) => {
    if (next === "scale") set({ answer_type: next, scale: value.scale ?? { min: 0, max: 5, step: 1 }, options: null });
    else if (next === "options")
      set({
        answer_type: next,
        scale: null,
        options: value.options?.length
          ? value.options
          : [
              { id: "full", label: "Fully", points: 2 },
              { id: "partial", label: "Partly", points: 1 },
              { id: "none", label: "Not at all", points: 0 },
            ],
      });
    else set({ answer_type: next, scale: null, options: null });
  };
  const setOption = (index: number, patch: Partial<AnswerOption>) =>
    set({ options: options.map((o, i) => (i === index ? { ...o, ...patch } : o)) });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <Field label="Name" htmlFor={ids.name}>
          <Input
            id={ids.name}
            value={value.name}
            maxLength={200}
            autoFocus
            onChange={(event) => {
              const name = event.target.value;
              if (idEditable && !idTouched) set({ name, id: uniqueId(criterionIdFrom(name), takenIds) });
              else set({ name });
            }}
          />
        </Field>
        <Field label="Id" htmlFor={ids.id} hint={idEditable ? "Stable key used by evaluations" : "Fixed: past results refer to it"}>
          <Input
            id={ids.id}
            value={value.id}
            disabled={!idEditable}
            maxLength={48}
            className="font-mono"
            spellCheck={false}
            onChange={(event) => {
              setIdTouched(true);
              set({ id: event.target.value.toLowerCase() });
            }}
          />
        </Field>
      </div>
      <Field label="What the evaluator must check" htmlFor={ids.description} hint="Sent to the evaluator verbatim with the transcript.">
        <Textarea id={ids.description} value={value.description ?? ""} maxLength={4000} onChange={(event) => set({ description: event.target.value })} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Section" htmlFor={ids.section}>
          <Select id={ids.section} value={value.section_id ?? ""} onChange={(event) => set({ section_id: event.target.value || null })}>
            <option value="">No section</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Weight" htmlFor={ids.weight} hint="Relative to the other criteria">
          <NumberInput id={ids.weight} value={value.weight} min={0.01} max={1000} fallback={10} onValueChange={(weight) => set({ weight: weight ?? 10 })} />
        </Field>
        <Field label="Answer type" htmlFor={ids.type}>
          <Select id={ids.type} value={type} onChange={(event) => setType(event.target.value as AnswerType)}>
            <option value="binary">Yes / No</option>
            <option value="scale">Numeric scale</option>
            <option value="options">Scored options</option>
          </Select>
        </Field>
      </div>

      {type === "scale" ? (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Minimum" htmlFor={ids.min}>
            <NumberInput id={ids.min} value={value.scale?.min ?? 0} onValueChange={(min) => set({ scale: { ...scale, min: min ?? 0 } })} fallback={0} />
          </Field>
          <Field label="Maximum" htmlFor={ids.max}>
            <NumberInput id={ids.max} value={value.scale?.max ?? 5} onValueChange={(max) => set({ scale: { ...scale, max: max ?? 5 } })} fallback={5} />
          </Field>
          <Field label="Step" htmlFor={ids.step}>
            <NumberInput id={ids.step} value={value.scale?.step ?? 1} min={0.01} onValueChange={(step) => set({ scale: { ...scale, step: step ?? 1 } })} fallback={1} />
          </Field>
          <p className="col-span-3 -mt-1 text-2xs text-ink-3">The minimum scores 0% of the weight, the maximum 100%, linearly in between.</p>
        </div>
      ) : null}

      {type === "options" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-2xs font-medium text-ink-2">Options · the best option scores 100% of the weight, others in proportion to their points</legend>
          {options.map((option, i) => (
            <div key={i} className="grid grid-cols-[7rem_1fr_5rem_auto] items-center gap-2">
              <Input aria-label={`Option ${i + 1} id`} value={option.id} className="font-mono" onChange={(e) => setOption(i, { id: e.target.value.toLowerCase() })} />
              <Input aria-label={`Option ${i + 1} label`} value={option.label} onChange={(e) => setOption(i, { label: e.target.value })} />
              <NumberInput aria-label={`Option ${i + 1} points`} value={option.points} min={0} max={1000} fallback={0} onValueChange={(points) => setOption(i, { points: points ?? 0 })} />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove option ${i + 1}`}
                disabled={options.length <= 2}
                onClick={() => set({ options: options.filter((_, j) => j !== i) })}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={options.length >= 12}
            onClick={() => set({ options: [...options, { id: uniqueId("option", options.map((o) => o.id)), label: "", points: 0 }] })}
          >
            <Plus aria-hidden />
            Add option
          </Button>
        </fieldset>
      ) : null}

      <div className="flex flex-col gap-3 border-t border-line pt-3">
        <div className="flex items-start gap-3">
          <Switch id={ids.na} checked={value.na_allowed ?? false} onCheckedChange={(na_allowed) => set({ na_allowed })} />
          <div className="min-w-0 flex-1">
            <label htmlFor={ids.na} className="text-dense font-medium text-ink">
              N/A allowed
            </label>
            <p className="text-2xs text-ink-3">When N/A, the weight is redistributed over the other applicable criteria.</p>
            {value.na_allowed ? (
              <Textarea
                id={ids.naRule}
                aria-label="When N/A applies"
                placeholder="When does N/A apply? e.g. the conversation never reached an operator."
                value={value.na_rule ?? ""}
                maxLength={2000}
                className="mt-2 min-h-14"
                onChange={(event) => set({ na_rule: event.target.value })}
              />
            ) : null}
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Switch id={ids.severe} checked={value.severe_error_enabled ?? false} onCheckedChange={(severe_error_enabled) => set({ severe_error_enabled })} />
          <div className="min-w-0 flex-1">
            <label htmlFor={ids.severe} className="text-dense font-medium text-ink">
              Can be a severe error
            </label>
            <p className="text-2xs text-ink-3">Severe errors are tracked separately; the checklist’s policy decides whether they change the total.</p>
            {value.severe_error_enabled ? (
              <Textarea
                id={ids.severeRule}
                aria-label="What counts as a severe error"
                placeholder="What counts as a severe error for this criterion?"
                value={value.severe_error_rule ?? ""}
                maxLength={2000}
                className="mt-2 min-h-14"
                onChange={(event) => set({ severe_error_rule: event.target.value })}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
