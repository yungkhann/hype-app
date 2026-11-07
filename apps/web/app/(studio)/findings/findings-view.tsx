"use client";

import { ArrowDown, ArrowUp, FileDown, Lightbulb, Pencil, Presentation, Printer, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { API_BASE, errorMessage } from "@/lib/api/client";
import { useDeleteFinding, useFindings, useReorderFindings, useUpdateFinding } from "@/lib/api/hooks";
import type { Finding, FindingPatch } from "@/lib/api/types";
import { fmtDate } from "@/lib/format";
import { ChartView } from "@/components/charts/chart-view";
import { PageHeader, PageSkeleton } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, Switch } from "@/components/ui/overlays";
import { Badge, EmptyState, Notice, Panel } from "@/components/ui/surface";

type TextKey = "description" | "methodology" | "interpretation" | "implication" | "limitations";

export const FINDING_TEXT_FIELDS: { key: TextKey; label: string; empty: string }[] = [
  { key: "description", label: "Observation", empty: "No observation written." },
  { key: "methodology", label: "Methodology", empty: "Not documented." },
  { key: "interpretation", label: "Interpretation", empty: "Not interpreted yet — write it yourself once the evidence is checked." },
  { key: "implication", label: "Business implication", empty: "Not written yet." },
  { key: "limitations", label: "Limitations", empty: "None recorded." },
];

export function FindingsView() {
  const findings = useFindings();
  const reorder = useReorderFindings();
  const list = findings.data ?? [];

  function move(index: number, delta: number) {
    const ids = list.map((f) => f.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    reorder.mutate(ids, { onError: (error) => toast.error("Could not reorder", { description: errorMessage(error) }) });
  }

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title="Findings"
        description="Evidence you chose to keep. Charts are frozen snapshots with their source line; every interpretation is written by the team, never generated."
        actions={
          <>
            <Button variant="secondary" asChild>
              <a href={`${API_BASE}/findings/export.md`} download="findings.md">
                <FileDown /> Markdown
              </a>
            </Button>
            <Button variant="secondary" asChild>
              <a href={`${API_BASE}/findings/export.json`} download="findings.json">
                <FileDown /> JSON
              </a>
            </Button>
            <Button variant="secondary" asChild>
              <Link href="/report">
                <Printer /> Report
              </Link>
            </Button>
            <Button variant="primary" asChild>
              <Link href="/present">
                <Presentation /> Present
              </Link>
            </Button>
          </>
        }
      />
      {findings.isError ? (
        <Notice tone="critical">{errorMessage(findings.error)}</Notice>
      ) : findings.isPending ? (
        <PageSkeleton />
      ) : list.length === 0 ? (
        <Panel>
          <EmptyState icon={Lightbulb} title="No findings yet">
            Use “Save as finding” on any chart or result in Overview, Explorer, Analysis Lab, or Model Lab.
          </EmptyState>
        </Panel>
      ) : (
        <ol className="flex flex-col gap-4" data-testid="findings-list">
          {list.map((finding, index) => (
            <li key={finding.id}>
              <FindingCard finding={finding} index={index} count={list.length} onMove={(delta) => move(index, delta)} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function FindingCard({ finding, index, count, onMove }: { finding: Finding; index: number; count: number; onMove: (delta: number) => void }) {
  const update = useUpdateFinding();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const needsInterpretation = !finding.interpretation.trim();

  function patch(value: FindingPatch, message?: string, onDone?: () => void) {
    update.mutate(
      { id: finding.id, patch: value },
      {
        onSuccess: () => {
          if (message) toast.success(message);
          onDone?.();
        },
        onError: (error) => toast.error("Could not update the finding", { description: errorMessage(error) }),
      },
    );
  }

  return (
    <Panel data-testid="finding-card">
      <header className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3">
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm bg-hover text-2xs font-medium text-ink-2 tabular-nums">{index + 1}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-ink">{finding.title}</h2>
          <p className="text-2xs text-ink-3">
            {finding.dataset_name ?? "No dataset"} · saved {fmtDate(finding.created_at, true)}
            {finding.updated_at !== finding.created_at && ` · edited ${fmtDate(finding.updated_at, true)}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {needsInterpretation && <Badge tone="warning">needs interpretation</Badge>}
          <label className="ml-2 flex items-center gap-2 text-2xs text-ink-2">
            <Switch checked={finding.include_in_pitch} onCheckedChange={(value) => patch({ include_in_pitch: value })} />
            In pitch
          </label>
          <Button size="icon-sm" variant="ghost" aria-label={`Move up: ${finding.title}`} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Move down: ${finding.title}`} disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Edit finding: ${finding.title}`} aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
            <Pencil />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Delete finding: ${finding.title}`} onClick={() => setConfirmDelete(true)}>
            <Trash2 />
          </Button>
        </div>
      </header>
      <div className="flex flex-col gap-4 p-4">
        {finding.chart && <ChartView data={finding.chart} height={280} />}
        {finding.evidence.length > 0 && (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-dense sm:grid-cols-2">
            {finding.evidence.map((e, i) => (
              <div key={i} className="flex justify-between gap-3 border-b border-line py-1">
                <dt className="text-ink-2">{e.label}</dt>
                <dd className="text-right font-medium text-ink tabular-nums">{e.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {editing ? (
          <FindingEditor
            finding={finding}
            saving={update.isPending}
            onCancel={() => setEditing(false)}
            // Close only once the server has the text, so a failed save keeps everything that was typed.
            onSave={(value) => patch(value, "Finding updated", () => setEditing(false))}
          />
        ) : (
          <dl className="grid gap-x-6 gap-y-3 md:grid-cols-2">
            {FINDING_TEXT_FIELDS.map((field) => {
              const text = finding[field.key].trim();
              return (
                <div key={field.key} className={field.key === "description" ? "md:col-span-2" : undefined}>
                  <dt className="text-2xs font-medium text-ink-2">{field.label}</dt>
                  <dd className={text ? "mt-0.5 text-dense whitespace-pre-line text-ink" : "mt-0.5 text-dense text-ink-3 italic"}>{text || field.empty}</dd>
                </div>
              );
            })}
          </dl>
        )}
      </div>
      <DeleteFindingDialog finding={finding} open={confirmDelete} onOpenChange={setConfirmDelete} />
    </Panel>
  );
}

function FindingEditor({ finding, saving, onSave, onCancel }: { finding: Finding; saving: boolean; onSave: (patch: FindingPatch) => void; onCancel: () => void }) {
  const [form, setForm] = useState<Record<TextKey | "title", string>>({
    title: finding.title,
    description: finding.description,
    methodology: finding.methodology,
    interpretation: finding.interpretation,
    implication: finding.implication,
    limitations: finding.limitations,
  });
  const id = `edit-${finding.id}`;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...form, title: form.title.trim() });
      }}
    >
      <Field label="Title" htmlFor={`${id}-title`}>
        <Input id={`${id}-title`} value={form.title} maxLength={200} onChange={(event) => setForm((f) => ({ ...f, title: event.target.value }))} />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        {FINDING_TEXT_FIELDS.map((field) => (
          <Field key={field.key} label={field.label} htmlFor={`${id}-${field.key}`} className={field.key === "description" ? "md:col-span-2" : undefined}>
            <Textarea id={`${id}-${field.key}`} rows={3} value={form[field.key]} onChange={(event) => setForm((f) => ({ ...f, [field.key]: event.target.value }))} />
          </Field>
        ))}
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={saving} disabled={!form.title.trim()}>
          Save changes
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function DeleteFindingDialog({ finding, open, onOpenChange }: { finding: Finding; open: boolean; onOpenChange: (open: boolean) => void }) {
  const remove = useDeleteFinding();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent
          title="Delete finding?"
          description={`“${finding.title}” and its chart snapshot are removed from findings and the pitch. The dataset is not affected.`}
          footer={
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={() =>
                  remove.mutate(finding.id, {
                    onSuccess: () => {
                      toast.success("Finding deleted");
                      onOpenChange(false);
                    },
                    onError: (error) => toast.error(errorMessage(error)),
                  })
                }
              >
                Delete
              </Button>
            </>
          }
        >
          {null}
        </DialogContent>
      )}
    </Dialog>
  );
}
