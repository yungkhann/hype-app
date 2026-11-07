"use client";

import {
  AlertOctagon,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Ban,
  ClipboardCheck,
  Copy,
  Download,
  Pencil,
  Plus,
  Replace,
  Settings2,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { toast } from "sonner";
import { OriginBadge } from "@/components/cqa/bits";
import { CriterionForm } from "@/components/cqa/criterion-form";
import { EvaluateDialog } from "@/components/cqa/evaluate-dialog";
import { PageHeader, PageSkeleton } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Field, Input, NumberInput, Select, Textarea, useFieldId } from "@/components/ui/input";
import { Dialog, DialogContent, Switch, Tip } from "@/components/ui/overlays";
import { Badge, EmptyState, Notice, Panel, PanelHeader } from "@/components/ui/surface";
import { ApiError, apiBlob, errorMessage } from "@/lib/api/client";
import { checklistExportPath, useChecklist, useDeleteChecklist, useDuplicateChecklist, useReplaceCriterion, useUpdateChecklist } from "@/lib/cqa/api";
import {
  answerTypeSummary,
  blankCriterion,
  criterionIdFrom,
  criterionIssues,
  fmtPoints,
  fmtShare,
  moveItem,
  normalizeCriterion,
  uniqueId,
  weightShares,
} from "@/lib/cqa/format";
import type { Checklist, ChecklistConfig, ChecklistOrigin, Criterion, RoundingMode } from "@/lib/cqa/types";
import { fmtDate, plural } from "@/lib/format";
import { downloadBlob, slug } from "@/lib/utils";

type Editing = { mode: "add" | "edit" | "replace"; index: number; value: Criterion; note: string } | null;

export function ChecklistView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const checklist = useChecklist(id);
  const [saved, setSaved] = useState<{ version: number; message: string } | null>(null);

  if (checklist.isPending) return <PageSkeleton />;
  if (checklist.isError) {
    const missing = checklist.error instanceof ApiError && checklist.error.status === 404;
    return (
      <Panel>
        <EmptyState
          icon={ClipboardCheck}
          title={missing ? "Checklist not found" : "Could not load the checklist"}
          action={
            <Button asChild>
              <Link href="/cqa/checklists">All checklists</Link>
            </Button>
          }
        >
          {errorMessage(checklist.error)}
        </EmptyState>
      </Panel>
    );
  }
  return (
    <ChecklistEditor
      key={`${checklist.data.id}:${checklist.data.latest_version}`}
      checklist={checklist.data}
      saved={saved && saved.version === checklist.data.latest_version ? saved : null}
      onSaved={setSaved}
    />
  );
}

function ChecklistEditor({
  checklist,
  saved,
  onSaved,
}: {
  checklist: Checklist;
  saved: { version: number; message: string } | null;
  onSaved: (saved: { version: number; message: string } | null) => void;
}) {
  const router = useRouter();
  const update = useUpdateChecklist(checklist.id);
  const replace = useReplaceCriterion(checklist.id);
  const duplicate = useDuplicateChecklist(checklist.id);
  const remove = useDeleteChecklist();
  const latest = checklist.versions.find((v) => v.version === checklist.latest_version) ?? checklist.versions[checklist.versions.length - 1];
  const [viewing, setViewing] = useState<number>(latest.version);
  const [draft, setDraft] = useState<ChecklistConfig | null>(null);
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [details, setDetails] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const noteId = useFieldId("note");
  const replaceNoteId = useFieldId("rnote");

  const shown = checklist.versions.find((v) => v.version === viewing) ?? latest;
  const readOnly = shown.version !== latest.version;
  const config: ChecklistConfig = readOnly ? shown.config : (draft ?? latest.config);
  const criteria = config.criteria;
  const sections = config.sections ?? [];
  const scoring: Partial<NonNullable<ChecklistConfig["scoring"]>> = config.scoring ?? {};
  const shares = weightShares(criteria);
  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0);
  const savedIds = new Set(latest.config.criteria.map((c) => c.id));
  const dirty = draft !== null;

  const edit = (change: (current: ChecklistConfig) => ChecklistConfig) => {
    const base: ChecklistConfig = structuredClone(draft ?? latest.config);
    setDraft(change(base));
  };

  async function save() {
    if (!draft) return;
    try {
      const result = await update.mutateAsync({
        base_version: latest.version,
        config: { ...draft, criteria: draft.criteria.map(normalizeCriterion) },
        note: note.trim() || "Edited in the checklist editor",
      });
      if (result.latest_version === latest.version) {
        toast.info("Nothing to save", { description: `The configuration is identical to v${latest.version}.` });
        setDraft(null);
        return;
      }
      onSaved({ version: result.latest_version, message: `Saved as v${result.latest_version}. Results made with earlier versions keep their version.` });
    } catch (error) {
      const stale = error instanceof ApiError && error.code === "stale_checklist";
      toast.error(stale ? "Someone saved a newer version" : "Could not save", {
        description: stale ? "Discard your changes to load the latest version, then edit again." : errorMessage(error),
      });
    }
  }

  async function submitEditing() {
    if (!editing) return;
    const value = normalizeCriterion(editing.value);
    if (editing.mode === "replace") {
      const old = latest.config.criteria[editing.index];
      try {
        const result = await replace.mutateAsync({ criterionId: old.id, base_version: latest.version, criterion: value, note: editing.note.trim() });
        setEditing(null);
        onSaved({
          version: result.latest_version,
          message: `Replaced “${old.name}” with “${value.name}” in v${result.latest_version}. Re-evaluate to score conversations with it.`,
        });
      } catch (error) {
        toast.error("Could not replace the criterion", { description: errorMessage(error) });
      }
      return;
    }
    if (editing.mode === "add") edit((c) => ({ ...c, criteria: [...c.criteria, value] }));
    else edit((c) => ({ ...c, criteria: c.criteria.map((x, i) => (i === editing.index ? value : x)) }));
    setEditing(null);
  }

  async function exportJson() {
    try {
      const blob = await apiBlob(checklistExportPath(checklist.id, shown.version));
      downloadBlob(blob, `${slug(checklist.name, "checklist")}-v${shown.version}.json`);
    } catch (error) {
      toast.error("Export failed", { description: errorMessage(error) });
    }
  }

  const takenForEditing = editing
    ? editing.mode === "edit"
      ? criteria.filter((_, i) => i !== editing.index).map((c) => c.id)
      : (editing.mode === "replace" ? latest.config.criteria : criteria).map((c) => c.id)
    : [];
  const editingIssues = editing ? criterionIssues(editing.value, takenForEditing) : [];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={checklist.name}
        description={checklist.description || undefined}
        meta={
          <div className="flex flex-wrap items-center gap-2 text-dense text-ink-2">
            <OriginBadge origin={checklist.origin ?? "custom"} />
            {checklist.archived ? <Badge tone="neutral">Archived</Badge> : null}
            <span className="tabular-nums">
              v{latest.version} · {plural(latest.config.criteria.length, "criterion", "criteria")} · updated {fmtDate(checklist.updated_at, true)}
            </span>
          </div>
        }
        actions={
          <>
            <Button variant="ghost" asChild>
              <Link href="/cqa/checklists">
                <ArrowLeft aria-hidden />
                Checklists
              </Link>
            </Button>
            <Button onClick={() => setDetails(true)}>
              <Settings2 aria-hidden />
              Details
            </Button>
            <Button
              loading={duplicate.isPending}
              onClick={() =>
                duplicate.mutate(
                  { version: shown.version },
                  {
                    onSuccess: (copy) => {
                      toast.success(`Duplicated v${shown.version}`, { description: copy.name });
                      router.push(`/cqa/checklists/${copy.id}`);
                    },
                    onError: (error) => toast.error("Could not duplicate", { description: errorMessage(error) }),
                  },
                )
              }
            >
              <Copy aria-hidden />
              Duplicate
            </Button>
            <Button onClick={exportJson}>
              <Download aria-hidden />
              Export
            </Button>
            <EvaluateDialog
              checklistId={checklist.id}
              checklistVersion={shown.version}
              trigger={
                <Button variant="primary">
                  <ClipboardCheck aria-hidden />
                  Evaluate with v{shown.version}
                </Button>
              }
            />
          </>
        }
      />

      {saved ? (
        <Notice
          tone="good"
          title={`Version ${saved.version} saved`}
          action={<EvaluateDialog checklistId={checklist.id} checklistVersion={saved.version} trigger={<Button size="sm">Evaluate with v{saved.version}</Button>} />}
        >
          {saved.message}
        </Notice>
      ) : null}

      {readOnly ? (
        <Notice
          tone="info"
          title={`Viewing v${shown.version}: read-only`}
          action={
            <Button size="sm" onClick={() => setViewing(latest.version)}>
              Back to v{latest.version}
            </Button>
          }
        >
          Evaluations made with v{shown.version} keep exactly this definition. To change it, edit the latest version or duplicate this one.
        </Notice>
      ) : null}

      {dirty && !readOnly ? (
        <Panel className="flex flex-wrap items-end gap-3 px-4 py-3" aria-label="Unsaved changes">
          <div className="min-w-0 flex-1">
            <p className="text-dense font-medium text-ink">Unsaved changes</p>
            <p className="text-2xs text-ink-3">Saving creates v{latest.version + 1}; v{latest.version} and the results made with it stay unchanged.</p>
          </div>
          <Field label="Change note" htmlFor={noteId} className="w-full sm:w-72">
            <Input id={noteId} value={note} maxLength={500} placeholder="What changed and why" onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button variant="ghost" onClick={() => setDraft(null)}>
            Discard
          </Button>
          <Button variant="primary" onClick={save} loading={update.isPending}>
            Save as v{latest.version + 1}
          </Button>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader
          title="Criteria"
          description={`Weights are relative: each criterion’s share is its weight over the total (${fmtPoints(totalWeight)}). N/A weight is redistributed when scoring.`}
          actions={
            readOnly ? null : (
              <Button
                size="sm"
                onClick={() => setEditing({ mode: "add", index: criteria.length, value: blankCriterion(criteria.map((c) => c.id)), note: "" })}
                disabled={criteria.length >= 60}
              >
                <Plus aria-hidden />
                Add criterion
              </Button>
            )
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-dense">
            <thead className="bg-sunken text-left text-2xs text-ink-3">
              <tr>
                <th className="w-10 px-4 py-2 font-medium">#</th>
                <th className="px-3 py-2 font-medium">Criterion</th>
                <th className="px-3 py-2 font-medium">Section</th>
                <th className="px-3 py-2 font-medium">Answer</th>
                <th className="px-3 py-2 text-right font-medium">Weight</th>
                <th className="px-3 py-2 font-medium">Rules</th>
                <th className="px-4 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {criteria.map((c, i) => (
                <tr key={c.id} className="border-t border-line align-top" data-criterion-id={c.id}>
                  <td className="px-4 py-2.5 text-ink-3 tabular-nums">{i + 1}</td>
                  <td className="max-w-[26rem] px-3 py-2.5">
                    <p className="font-medium text-ink">{c.name}</p>
                    <p className="font-mono text-2xs text-ink-3">{c.id}</p>
                    {c.description ? <p className="mt-0.5 line-clamp-2 text-xs text-ink-2">{c.description}</p> : null}
                    {!savedIds.has(c.id) && !readOnly ? (
                      <Badge tone="info" className="mt-1">
                        New
                      </Badge>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-ink-2">{sections.find((s) => s.id === c.section_id)?.name ?? <span className="text-ink-3">—</span>}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-ink-2">{answerTypeSummary(c)}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">
                    <span className="text-ink">{fmtPoints(c.weight)}</span>
                    <span className="block text-2xs text-ink-3">{fmtShare(shares[c.id])}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="flex flex-wrap gap-1">
                      {c.na_allowed ? (
                        <Tip content={c.na_rule || "N/A allowed"}>
                          <Badge tone="neutral">
                            <Ban aria-hidden />
                            N/A
                          </Badge>
                        </Tip>
                      ) : null}
                      {c.severe_error_enabled ? (
                        <Tip content={c.severe_error_rule || "Can be a severe error"}>
                          <Badge tone="critical">
                            <AlertOctagon aria-hidden />
                            Severe
                          </Badge>
                        </Tip>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {readOnly ? null : (
                      <span className="flex items-center justify-end gap-0.5">
                        <Button variant="ghost" size="icon-sm" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => edit((x) => ({ ...x, criteria: moveItem(x.criteria, i, -1) }))}>
                          <ArrowUp aria-hidden />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move ${c.name} down`}
                          disabled={i === criteria.length - 1}
                          onClick={() => edit((x) => ({ ...x, criteria: moveItem(x.criteria, i, 1) }))}
                        >
                          <ArrowDown aria-hidden />
                        </Button>
                        <Tip content="Edit">
                          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.name}`} onClick={() => setEditing({ mode: "edit", index: i, value: structuredClone(c), note: "" })}>
                            <Pencil aria-hidden />
                          </Button>
                        </Tip>
                        {savedIds.has(c.id) ? (
                          <Tip content={dirty ? "Save or discard your changes first" : "Replace with a new criterion (new version)"}>
                            <span>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Replace ${c.name}`}
                                disabled={dirty}
                                onClick={() =>
                                  setEditing({
                                    mode: "replace",
                                    index: latest.config.criteria.findIndex((x) => x.id === c.id),
                                    value: { ...blankCriterion(latest.config.criteria.map((x) => x.id), c.section_id ?? null), weight: c.weight },
                                    note: "",
                                  })
                                }
                              >
                                <Replace aria-hidden />
                              </Button>
                            </span>
                          </Tip>
                        ) : null}
                        <Tip content="Remove">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove ${c.name}`}
                            disabled={criteria.length <= 1}
                            onClick={() => edit((x) => ({ ...x, criteria: x.criteria.filter((_, j) => j !== i) }))}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        </Tip>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <SectionsPanel config={config} readOnly={readOnly} edit={edit} />
        <ScoringPanel scoring={scoring} readOnly={readOnly} edit={edit} />
      </div>

      <Panel>
        <PanelHeader title="Version history" description="Versions are immutable. Each evaluation records the version it used." />
        <ol>
          {checklist.versions
            .slice()
            .reverse()
            .map((v) => (
              <li key={v.version} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 last:border-b-0">
                <div className="min-w-0">
                  <p className="text-dense">
                    <span className="font-medium text-ink">v{v.version}</span>
                    {v.version === latest.version ? (
                      <Badge tone="accent" className="ml-2">
                        Latest
                      </Badge>
                    ) : null}
                    <span className="ml-2 text-ink-2">{v.note || "—"}</span>
                  </p>
                  {v.replacements?.map((r) => (
                    <p key={`${r.old_id}-${r.new_id}`} className="mt-0.5 text-xs text-ink-3">
                      Replaced <span className="text-ink-2">{r.old_name}</span> (<span className="font-mono">{r.old_id}</span>) with{" "}
                      <span className="text-ink-2">{r.new_name}</span> (<span className="font-mono">{r.new_id}</span>)
                    </p>
                  ))}
                  <p className="mt-0.5 text-2xs text-ink-3 tabular-nums">
                    {fmtDate(v.created_at, true)} · {plural(v.config.criteria.length, "criterion", "criteria")} ·{" "}
                    <span className="font-mono">{v.config_hash.slice(0, 12)}</span>
                  </p>
                </div>
                <Button size="sm" variant={v.version === shown.version ? "secondary" : "ghost"} disabled={v.version === shown.version} onClick={() => setViewing(v.version)}>
                  {v.version === shown.version ? "Showing" : "View"}
                </Button>
              </li>
            ))}
        </ol>
      </Panel>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing ? (
          <DialogContent
            className="max-w-2xl"
            title={editing.mode === "add" ? "Add criterion" : editing.mode === "edit" ? "Edit criterion" : `Replace “${latest.config.criteria[editing.index]?.name}”`}
            description={
              editing.mode === "replace"
                ? `Creates v${latest.version + 1} with the new criterion in the same position. v${latest.version} and its results are kept.`
                : "Changes go into your draft; save the checklist to create a new version."
            }
            footer={
              <>
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button variant="primary" disabled={editingIssues.length > 0} loading={replace.isPending} onClick={submitEditing}>
                  {editing.mode === "replace" ? `Replace and save v${latest.version + 1}` : editing.mode === "add" ? "Add to draft" : "Apply to draft"}
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-4">
              <CriterionForm
                value={editing.value}
                onChange={(value) => setEditing({ ...editing, value })}
                sections={editing.mode === "replace" ? (latest.config.sections ?? []) : sections}
                idEditable={editing.mode !== "edit" || !savedIds.has(criteria[editing.index]?.id ?? "")}
                takenIds={takenForEditing}
              />
              {editing.mode === "replace" ? (
                <Field label="Change note" hint="Recorded in the version history." htmlFor={replaceNoteId}>
                  <Input id={replaceNoteId} value={editing.note} maxLength={500} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
                </Field>
              ) : null}
              {editingIssues.length && editing.value.name ? (
                <Notice tone="warning" title="Fix before saving">
                  <ul className="list-disc pl-4 text-xs">
                    {editingIssues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
            </div>
          </DialogContent>
        ) : null}
      </Dialog>

      {details ? <DetailsDialog onClose={() => setDetails(false)} checklist={checklist} onDelete={() => setConfirmDelete(true)} /> : null}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent
          title="Delete this checklist?"
          description="Only possible while no evaluation uses it. Archive it instead to keep past results reproducible."
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={() =>
                  remove.mutate(checklist.id, {
                    onSuccess: () => {
                      toast.success("Checklist deleted");
                      router.push("/cqa/checklists");
                    },
                    onError: (error) => {
                      setConfirmDelete(false);
                      toast.error("Could not delete", { description: errorMessage(error) });
                    },
                  })
                }
              >
                <Trash2 aria-hidden />
                Delete
              </Button>
            </>
          }
        >
          <p className="text-dense text-ink-2">“{checklist.name}” and all its versions will be removed.</p>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SectionsPanel({ config, readOnly, edit }: { config: ChecklistConfig; readOnly: boolean; edit: (change: (c: ChecklistConfig) => ChecklistConfig) => void }) {
  const [name, setName] = useState("");
  const sections = config.sections ?? [];
  const addId = useFieldId("section");
  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    edit((c) => ({
      ...c,
      sections: [...(c.sections ?? []), { id: uniqueId(criterionIdFrom(trimmed), (c.sections ?? []).map((s) => s.id)), name: trimmed, description: "" }],
    }));
    setName("");
  };
  return (
    <Panel>
      <PanelHeader title="Sections" description="Optional groups of criteria; each gets a subtotal in the results." />
      {sections.length ? (
        <ul>
          {sections.map((s, i) => {
            const used = config.criteria.filter((c) => c.section_id === s.id).length;
            return (
              <li key={s.id} className="flex items-center gap-2 border-b border-line px-4 py-2 last:border-b-0">
                {readOnly ? (
                  <span className="flex-1 text-dense text-ink">{s.name}</span>
                ) : (
                  <Input
                    aria-label={`Section ${i + 1} name`}
                    value={s.name}
                    maxLength={200}
                    className="flex-1"
                    onChange={(e) => edit((c) => ({ ...c, sections: (c.sections ?? []).map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)) }))}
                  />
                )}
                <span className="w-24 shrink-0 truncate font-mono text-2xs text-ink-3" title={s.id}>
                  {s.id}
                </span>
                <span className="w-20 shrink-0 text-right text-2xs text-ink-3 tabular-nums">{plural(used, "criterion", "criteria")}</span>
                {readOnly ? null : (
                  <Tip content={used ? "Move its criteria to another section first" : "Remove section"}>
                    <span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove section ${s.name}`}
                        disabled={used > 0}
                        onClick={() => edit((c) => ({ ...c, sections: (c.sections ?? []).filter((x) => x.id !== s.id) }))}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </span>
                  </Tip>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-4 py-3 text-dense text-ink-3">No sections: the checklist is scored as one list.</p>
      )}
      {readOnly ? null : (
        <form
          className="flex items-end gap-2 border-t border-line px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Field label="New section" htmlFor={addId} className="flex-1">
            <Input id={addId} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder="e.g. Opening" />
          </Field>
          <Button type="submit" disabled={!name.trim()}>
            <Plus aria-hidden />
            Add
          </Button>
        </form>
      )}
    </Panel>
  );
}

function ScoringPanel({
  scoring,
  readOnly,
  edit,
}: {
  scoring: Partial<NonNullable<ChecklistConfig["scoring"]>>;
  readOnly: boolean;
  edit: (change: (c: ChecklistConfig) => ChecklistConfig) => void;
}) {
  const ids = { max: useFieldId("max"), mode: useFieldId("mode"), digits: useFieldId("digits"), severe: useFieldId("severe") };
  const rounding = { mode: scoring.rounding?.mode ?? "half_up", digits: scoring.rounding?.digits ?? 1 };
  const current = {
    max_score: scoring.max_score ?? 100,
    rounding,
    severe_error_policy: scoring.severe_error_policy ?? "flag_only",
    na_policy: "redistribute" as const,
  };
  const set = (patch: Partial<typeof current>) => edit((c) => ({ ...c, scoring: { ...current, ...patch } }));
  return (
    <Panel>
      <PanelHeader title="Scoring rules" description="Applied by the ATLAS scoring engine. Enter the official rounding rule here once it is provided." />
      <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
        <Field label="Maximum score" htmlFor={ids.max}>
          <NumberInput id={ids.max} value={current.max_score} min={1} max={10000} fallback={100} disabled={readOnly} onValueChange={(v) => set({ max_score: v ?? 100 })} />
        </Field>
        <Field label="Severe error policy" htmlFor={ids.severe}>
          <Select
            id={ids.severe}
            value={current.severe_error_policy}
            disabled={readOnly}
            onChange={(e) => set({ severe_error_policy: e.target.value as "flag_only" | "zero_total" })}
          >
            <option value="flag_only">Flag only (total unchanged)</option>
            <option value="zero_total">Total becomes 0</option>
          </Select>
        </Field>
        <Field label="Rounding" htmlFor={ids.mode}>
          <Select id={ids.mode} value={rounding.mode} disabled={readOnly} onChange={(e) => set({ rounding: { ...rounding, mode: e.target.value as RoundingMode } })}>
            <option value="half_up">Half up</option>
            <option value="half_even">Half even (banker’s)</option>
            <option value="floor">Down</option>
            <option value="ceil">Up</option>
            <option value="none">No rounding</option>
          </Select>
        </Field>
        <Field label="Decimal places" htmlFor={ids.digits}>
          <NumberInput
            id={ids.digits}
            value={rounding.digits}
            min={0}
            max={4}
            integer
            fallback={1}
            disabled={readOnly || rounding.mode === "none"}
            onValueChange={(v) => set({ rounding: { ...rounding, digits: v ?? 1 } })}
          />
        </Field>
      </div>
      <p className="border-t border-line px-4 py-2.5 text-2xs text-ink-3">
        N/A policy: the weight of a criterion answered N/A is redistributed proportionally over the applicable criteria. A missing or invalid answer
        never counts as zero; the evaluation is marked incomplete instead.
      </p>
    </Panel>
  );
}

function DetailsDialog({ onClose, checklist, onDelete }: { onClose: () => void; checklist: Checklist; onDelete: () => void }) {
  const update = useUpdateChecklist(checklist.id);
  const [name, setName] = useState(checklist.name);
  const [description, setDescription] = useState(checklist.description ?? "");
  const [origin, setOrigin] = useState<ChecklistOrigin>(checklist.origin ?? "custom");
  const [archived, setArchived] = useState(checklist.archived ?? false);
  const ids = { name: useFieldId("name"), description: useFieldId("desc"), origin: useFieldId("origin"), archived: useFieldId("arch") };

  async function save() {
    try {
      await update.mutateAsync({ base_version: checklist.latest_version, name: name.trim(), description: description.trim(), origin, archived });
      toast.success("Details saved");
      onClose();
    } catch (error) {
      toast.error("Could not save", { description: errorMessage(error) });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Checklist details"
        description="Name, description and origin do not change the criteria, so they do not create a version."
        footer={
          <>
            <Button
              variant="danger"
              className="mr-auto"
              onClick={() => {
                onClose();
                onDelete();
              }}
            >
              <Trash2 aria-hidden />
              Delete…
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!name.trim()} loading={update.isPending} onClick={save}>
              Save details
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Name" htmlFor={ids.name}>
            <Input id={ids.name} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor={ids.description}>
            <Textarea id={ids.description} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Origin" htmlFor={ids.origin} hint={origin === "official" ? "Only for criteria entered from the organizers’ official checklist." : undefined}>
            <Select id={ids.origin} value={origin} onChange={(e) => setOrigin(e.target.value as ChecklistOrigin)}>
              <option value="custom">Custom</option>
              <option value="official">Official (from the organizers’ document)</option>
              <option value="dev_sample">Development sample (unofficial)</option>
            </Select>
          </Field>
          <label htmlFor={ids.archived} className="flex items-center gap-2 text-dense text-ink-2">
            <Switch id={ids.archived} checked={archived} onCheckedChange={setArchived} />
            <Archive className="size-4 text-ink-3" aria-hidden />
            Archived (hidden from lists; results are kept)
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
}
