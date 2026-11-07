"use client";

import { ClipboardCheck, FlaskConical } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Select, useFieldId } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/overlays";
import { Notice } from "@/components/ui/surface";
import { errorMessage } from "@/lib/api/client";
import { useChecklist, useChecklists, useCqaInfo, useCreateDevChecklist, useEvaluate, useOverview } from "@/lib/cqa/api";
import { plural } from "@/lib/format";

type Scope = "missing" | "all" | "group";

/**
 * Queue evaluations. Fixed to given conversations (a single conversation page) or chosen here:
 * not yet evaluated with this checklist version, every conversation, or one imported group.
 */
export function EvaluateDialog({
  conversationIds,
  checklistId: presetChecklist,
  checklistVersion: presetVersion,
  trigger,
  onQueued,
}: {
  conversationIds?: string[];
  checklistId?: string;
  checklistVersion?: number;
  trigger?: ReactNode;
  onQueued?: (batchId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="primary">
            <ClipboardCheck aria-hidden />
            Evaluate…
          </Button>
        )}
      </DialogTrigger>
      {open ? (
        <EvaluateForm
          conversationIds={conversationIds}
          presetChecklist={presetChecklist}
          presetVersion={presetVersion}
          onDone={(batchId) => {
            setOpen(false);
            if (batchId) onQueued?.(batchId);
          }}
        />
      ) : null}
    </Dialog>
  );
}

function EvaluateForm({
  conversationIds,
  presetChecklist,
  presetVersion,
  onDone,
}: {
  conversationIds?: string[];
  presetChecklist?: string;
  presetVersion?: number;
  onDone: (batchId: string | null) => void;
}) {
  const router = useRouter();
  const info = useCqaInfo();
  const checklists = useChecklists();
  const overview = useOverview();
  const createSample = useCreateDevChecklist();
  const evaluate = useEvaluate();
  const [checklistId, setChecklistId] = useState<string | undefined>(presetChecklist);
  const chosen = checklistId ?? overview.data?.checklist_id ?? checklists.data?.[0]?.id;
  const checklist = useChecklist(chosen);
  const [version, setVersion] = useState<number | undefined>(presetVersion);
  const [scope, setScope] = useState<Scope>("missing");
  const [group, setGroup] = useState<string>("");
  const [adapter, setAdapter] = useState<string | undefined>(undefined);
  const ids = { checklist: useFieldId("cl"), version: useFieldId("ver"), scope: useFieldId("scope"), group: useFieldId("grp"), adapter: useFieldId("ad") };

  const evaluators = info.data?.evaluators ?? [];
  const selectedAdapter = evaluators.find((e) => e.name === (adapter ?? info.data?.default_evaluator));
  const groups = overview.data?.by_group ?? [];
  const fixed = conversationIds && conversationIds.length > 0;
  const latest = checklist.data?.latest_version;
  const effectiveVersion = version ?? latest;

  async function submit() {
    if (!chosen) return;
    try {
      const response = await evaluate.mutateAsync({
        checklist_id: chosen,
        checklist_version: effectiveVersion ?? null,
        conversation_ids: fixed ? conversationIds : null,
        group_id: !fixed && scope === "group" && group ? group : null,
        only_missing: !fixed && scope === "missing",
        adapter: selectedAdapter?.name ?? null,
      });
      if (response.queued === 0) {
        toast.info("Nothing to evaluate", {
          description: `All ${plural(response.skipped, "conversation")} already have a result for this checklist version.`,
        });
        onDone(null);
        return;
      }
      toast.success(`Queued ${plural(response.queued, "evaluation")}`, {
        description: response.skipped ? `${response.skipped} already evaluated with this version were skipped.` : undefined,
        action: { label: "Progress", onClick: () => router.push(`/cqa/evaluations?batch=${response.batch_id}`) },
      });
      onDone(response.batch_id);
    } catch (error) {
      toast.error("Could not queue evaluations", { description: errorMessage(error) });
    }
  }

  const noChecklists = checklists.isSuccess && checklists.data.length === 0;

  return (
    <DialogContent
      title={fixed && conversationIds.length === 1 ? "Evaluate this conversation" : "Evaluate conversations"}
      description="Each result is scored by the ATLAS scoring engine from the evaluator's validated answers."
      footer={
        <>
          <Button variant="ghost" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={evaluate.isPending} disabled={!chosen || !selectedAdapter?.available || (scope === "group" && !fixed && !group)}>
            Queue evaluation
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {noChecklists ? (
          <Notice
            tone="info"
            title="No checklist yet"
            action={
              <Button
                size="sm"
                loading={createSample.isPending}
                onClick={async () => {
                  try {
                    const created = await createSample.mutateAsync();
                    setChecklistId(created.id);
                  } catch (error) {
                    toast.error("Could not create the sample checklist", { description: errorMessage(error) });
                  }
                }}
              >
                Create dev sample
              </Button>
            }
          >
            Create one on the <Link className="text-accent-ink underline-offset-4 hover:underline" href="/cqa/checklists">Checklists</Link> page,
            or start from the unofficial development sample.
          </Notice>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
          <Field label="Checklist" htmlFor={ids.checklist}>
            <Select
              id={ids.checklist}
              value={chosen ?? ""}
              onChange={(event) => {
                setChecklistId(event.target.value);
                setVersion(undefined);
              }}
              disabled={!checklists.data?.length}
            >
              {(checklists.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Version" htmlFor={ids.version}>
            <Select
              id={ids.version}
              value={effectiveVersion ?? ""}
              onChange={(event) => setVersion(Number(event.target.value))}
              disabled={!checklist.data}
            >
              {(checklist.data?.versions ?? [])
                .slice()
                .reverse()
                .map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                    {v.version === latest ? " (latest)" : ""}
                  </option>
                ))}
            </Select>
          </Field>
        </div>

        {fixed ? (
          <p className="text-dense text-ink-2">
            {conversationIds.length === 1 ? (
              <>
                Conversation <span className="font-mono text-ink">{conversationIds[0]}</span> gets a new evaluation; earlier results are kept.
              </>
            ) : (
              `${plural(conversationIds.length, "conversation")} selected.`
            )}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Conversations" htmlFor={ids.scope}>
              <Select id={ids.scope} value={scope} onChange={(event) => setScope(event.target.value as Scope)}>
                <option value="missing">Not yet evaluated with this version</option>
                <option value="all">All conversations (re-evaluate)</option>
                <option value="group" disabled={!groups.length}>
                  One imported group
                </option>
              </Select>
            </Field>
            {scope === "group" ? (
              <Field label="Group" htmlFor={ids.group}>
                <Select id={ids.group} value={group} onChange={(event) => setGroup(event.target.value)}>
                  <option value="">Choose a group…</option>
                  {groups.map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.value} ({g.count})
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
        )}

        <Field
          label="Evaluator"
          htmlFor={ids.adapter}
          hint={selectedAdapter?.description}
          error={selectedAdapter && !selectedAdapter.available ? "Not available in this deployment." : undefined}
        >
          <Select id={ids.adapter} value={selectedAdapter?.name ?? ""} onChange={(event) => setAdapter(event.target.value)}>
            {evaluators.map((e) => (
              <option key={e.name} value={e.name} disabled={!e.available}>
                {e.label}
                {e.available ? "" : " (not configured)"}
              </option>
            ))}
          </Select>
        </Field>
        {selectedAdapter?.is_mock ? (
          <Notice tone="warning" title="Development mock, not AI">
            <span className="inline-flex items-start gap-1.5">
              <FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Answers are deterministic placeholders that cite real transcript lines. They exercise validation, scoring and appeals; they are not a
              quality judgement.
            </span>
          </Notice>
        ) : null}
      </div>
    </DialogContent>
  );
}
