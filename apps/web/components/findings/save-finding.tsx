"use client";

import { Lightbulb } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api/client";
import { useCreateFinding } from "@/lib/api/hooks";
import type { ChartData, EvidenceItem, FindingIn, SourceMeta } from "@/lib/api/types";
import { sourceText } from "@/lib/format";
import { chartTitle } from "@/components/charts/chart-view";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/overlays";
import { Notice } from "@/components/ui/surface";

export interface FindingDraft {
  title: string;
  chart?: ChartData | null;
  meta?: SourceMeta | null;
  experimentId?: string | null;
  methodology?: string;
  evidence?: EvidenceItem[];
  limitations?: string;
}

/** Facts only: the provenance and sampling disclosures. Interpretation is left to the analyst. */
export function factualMethodology(draft: FindingDraft): string {
  const meta = draft.chart?.meta ?? draft.meta;
  const parts: string[] = [];
  if (draft.methodology) parts.push(draft.methodology);
  if (meta) parts.push(`Computed on ${sourceText(meta)}.`);
  return parts.join("\n");
}

export function factualLimitations(draft: FindingDraft): string {
  const meta = draft.chart?.meta ?? draft.meta;
  const notes = [...(draft.limitations ? [draft.limitations] : []), ...(meta?.notes ?? []).filter((n) => !n.startsWith("Filters:"))];
  if (meta?.sampled) notes.push(`Values come from a sample of ${meta.sample_size ?? "?"} rows.`);
  return [...new Set(notes)].join("\n");
}

export function SaveFindingButton({ draft, size = "sm", label = "Save as finding" }: { draft: FindingDraft; size?: "sm" | "md"; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={size} variant="secondary">
          <Lightbulb /> {label}
        </Button>
      </DialogTrigger>
      {open && <SaveFindingDialog draft={draft} onDone={() => setOpen(false)} />}
    </Dialog>
  );
}

function SaveFindingDialog({ draft, onDone }: { draft: FindingDraft; onDone: () => void }) {
  const create = useCreateFinding();
  const meta = draft.chart?.meta ?? draft.meta ?? null;
  const [form, setForm] = useState({
    title: draft.title || (draft.chart ? chartTitle(draft.chart) : ""),
    description: "",
    methodology: factualMethodology(draft),
    interpretation: "",
    implication: "",
    limitations: factualLimitations(draft),
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value }));

  async function save() {
    const body: FindingIn = {
      ...form,
      title: form.title.trim(),
      chart: draft.chart ?? null,
      dataset_id: meta?.dataset_id ?? null,
      dataset_name: meta?.dataset_name ?? null,
      experiment_id: draft.experimentId ?? null,
      evidence: draft.evidence ?? [],
    };
    try {
      await create.mutateAsync(body);
      toast.success("Finding saved", { description: "It is in the Findings workspace and the pitch deck." });
      onDone();
    } catch (error) {
      toast.error("Could not save the finding", { description: errorMessage(error) });
    }
  }

  return (
    <DialogContent
      title="Save as finding"
      description="The chart and its source line are stored as a snapshot. Write the interpretation yourself — ATLAS never generates conclusions."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={create.isPending} disabled={!form.title.trim()} data-testid="save-finding">
            Save finding
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Title" htmlFor="finding-title">
          <Input id="finding-title" value={form.title} onChange={set("title")} maxLength={200} />
        </Field>
        <Field label="What does the evidence show?" hint="Describe the observation in plain words." htmlFor="finding-description">
          <Textarea id="finding-description" value={form.description} onChange={set("description")} rows={2} />
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Methodology" hint="Pre-filled with how the number was computed." htmlFor="finding-method">
            <Textarea id="finding-method" value={form.methodology} onChange={set("methodology")} rows={3} />
          </Field>
          <Field label="Limitations" hint="Pre-filled with sampling and exclusion notes." htmlFor="finding-limits">
            <Textarea id="finding-limits" value={form.limitations} onChange={set("limitations")} rows={3} />
          </Field>
          <Field label="Interpretation" hint="Your reading; leave empty until you are sure." htmlFor="finding-interp">
            <Textarea id="finding-interp" value={form.interpretation} onChange={set("interpretation")} rows={3} />
          </Field>
          <Field label="Business implication" htmlFor="finding-impl">
            <Textarea id="finding-impl" value={form.implication} onChange={set("implication")} rows={3} />
          </Field>
        </div>
        {draft.evidence?.length ? (
          <Notice tone="neutral" title={`${draft.evidence.length} evidence values attached`}>
            {draft.evidence
              .slice(0, 6)
              .map((e) => `${e.label}: ${e.value}`)
              .join(" · ")}
          </Notice>
        ) : null}
        <p className="text-2xs text-ink-3">
          Edit, reorder, and export later in{" "}
          <Link className="text-accent-ink underline" href="/findings">
            Findings
          </Link>
          .
        </p>
      </div>
    </DialogContent>
  );
}
