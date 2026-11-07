"use client";

import { FileJson, FlaskConical, ListChecks, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { OriginBadge } from "@/components/cqa/bits";
import { PageHeader } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea, useFieldId } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTrigger, Switch } from "@/components/ui/overlays";
import { Badge, EmptyState, Notice, Panel, Skeleton } from "@/components/ui/surface";
import { errorMessage } from "@/lib/api/client";
import { useChecklists, useCreateChecklist, useCreateDevChecklist, useImportChecklist } from "@/lib/cqa/api";
import { blankCriterion, fmtPoints, parseChecklistFile } from "@/lib/cqa/format";
import { fmtDate, plural } from "@/lib/format";

function NewChecklistDialog() {
  const router = useRouter();
  const create = useCreateChecklist();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const ids = { name: useFieldId("name"), description: useFieldId("desc") };

  async function submit() {
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        config: {
          sections: [],
          criteria: [{ ...blankCriterion([]), id: "criterion_1", name: "First criterion" }],
        },
        note: "Created",
      });
      setOpen(false);
      router.push(`/cqa/checklists/${created.id}`);
    } catch (error) {
      toast.error("Could not create the checklist", { description: errorMessage(error) });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary">
          <Plus aria-hidden />
          New checklist
        </Button>
      </DialogTrigger>
      <DialogContent
        title="New checklist"
        description="Starts with one placeholder criterion; add, edit and reorder criteria in the editor."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={submit}>
              Create
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Name" htmlFor={ids.name}>
            <Input id={ids.name} value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description" htmlFor={ids.description}>
            <Textarea id={ids.description} value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ChecklistsView() {
  const router = useRouter();
  const [archived, setArchived] = useState(false);
  const checklists = useChecklists(archived);
  const createSample = useCreateDevChecklist();
  const importChecklist = useImportChecklist();
  const fileRef = useRef<HTMLInputElement>(null);
  const archivedId = useFieldId("archived");

  async function importFile(file: File) {
    try {
      const parsed = parseChecklistFile(await file.text(), file.name.replace(/\.json$/i, ""));
      const created = await importChecklist.mutateAsync(parsed);
      toast.success(`Imported “${created.name}”`, { description: plural(created.versions[0].config.criteria.length, "criterion", "criteria") });
      router.push(`/cqa/checklists/${created.id}`);
    } catch (error) {
      toast.error("Could not import the checklist", { description: errorMessage(error) });
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Checklists"
        description="Criteria, weights, answer types, N/A and severe-error rules. Every saved change is a new version; past evaluations keep the version they used."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              aria-label="Checklist JSON file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importFile(file);
                event.target.value = "";
              }}
            />
            <Button onClick={() => fileRef.current?.click()} loading={importChecklist.isPending}>
              <FileJson aria-hidden />
              Import JSON
            </Button>
            <NewChecklistDialog />
          </>
        }
      />
      <Notice tone="info" title="The official checklist is entered here, not invented">
        The organizers’ eight-criterion checklist is supplied separately. Enter its criteria in a new checklist (or import them as JSON) and set its
        origin to Official. The development sample uses placeholder criteria for testing only.
      </Notice>
      <Panel>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <label htmlFor={archivedId} className="flex items-center gap-2 text-dense text-ink-2">
            <Switch id={archivedId} checked={archived} onCheckedChange={setArchived} />
            Show archived
          </label>
          <Button
            size="sm"
            variant="ghost"
            loading={createSample.isPending}
            onClick={() =>
              createSample.mutate(undefined, {
                onSuccess: (created) => router.push(`/cqa/checklists/${created.id}`),
                onError: (error) => toast.error("Could not create the sample", { description: errorMessage(error) }),
              })
            }
          >
            <FlaskConical aria-hidden />
            Add development sample
          </Button>
        </div>
        {checklists.isError ? (
          <div className="p-4">
            <Notice tone="critical" title="Could not load checklists">
              {errorMessage(checklists.error)}
            </Notice>
          </div>
        ) : !checklists.data ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : checklists.data.length === 0 ? (
          <EmptyState icon={ListChecks} title="No checklists yet" action={<NewChecklistDialog />}>
            Create the official checklist from the organizers’ document, or add the development sample to try the workflow.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-dense">
              <thead className="bg-sunken text-left text-2xs text-ink-3">
                <tr>
                  <th className="px-4 py-2 font-medium">Checklist</th>
                  <th className="px-3 py-2 font-medium">Origin</th>
                  <th className="px-3 py-2 text-right font-medium">Criteria</th>
                  <th className="px-3 py-2 text-right font-medium">Total weight</th>
                  <th className="px-3 py-2 text-right font-medium">Version</th>
                  <th className="px-3 py-2 text-right font-medium">Evaluations</th>
                  <th className="px-4 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {checklists.data.map((c) => (
                  <tr key={c.id} className="border-t border-line hover:bg-hover">
                    <td className="max-w-[24rem] px-4 py-2">
                      <Link href={`/cqa/checklists/${c.id}`} className="font-medium text-accent-ink hover:underline">
                        {c.name}
                      </Link>
                      {c.archived ? (
                        <Badge tone="neutral" className="ml-2">
                          Archived
                        </Badge>
                      ) : null}
                      {c.description ? <p className="truncate text-xs text-ink-3">{c.description}</p> : null}
                    </td>
                    <td className="px-3 py-2">
                      <OriginBadge origin={c.origin} />
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2 tabular-nums">
                      {c.criteria}
                      {c.sections ? <span className="text-ink-3"> · {plural(c.sections, "section")}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{fmtPoints(c.total_weight)}</td>
                    <td className="px-3 py-2 text-right text-ink-2 tabular-nums">v{c.latest_version}</td>
                    <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{c.evaluations ?? 0}</td>
                    <td className="px-4 py-2 text-xs text-ink-3 tabular-nums">{fmtDate(c.updated_at, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
