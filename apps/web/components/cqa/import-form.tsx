"use client";

import { CloudDownload, FlaskConical } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input, useFieldId } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/overlays";
import { Notice } from "@/components/ui/surface";
import { errorMessage } from "@/lib/api/client";
import { useCqaInfo, useImportGroup } from "@/lib/cqa/api";
import type { ImportRun } from "@/lib/cqa/types";
import { plural } from "@/lib/format";

const GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function importSummary(run: ImportRun): string {
  const parts = [`${run.created} new`, `${run.updated} updated`, `${run.unchanged} unchanged`];
  if (run.rejected) parts.push(`${run.rejected} rejected`);
  return parts.join(" · ");
}

/**
 * Import by group_id. The backend calls the organizers' API (no browser CORS, the signed URL never reaches the
 * page). Fixtures are a separate, labelled action: they are synthetic and never stand in for real data.
 */
export function ImportForm({ onImported }: { onImported?: (run: ImportRun) => void }) {
  const info = useCqaInfo();
  const importGroup = useImportGroup();
  const [groupId, setGroupId] = useState("DEV");
  const [running, setRunning] = useState<string | null>(null);
  const fieldId = useFieldId("group");
  const valid = GROUP_ID.test(groupId.trim());
  const configured = info.data?.source_configured ?? false;

  async function run(group: string, source: "organizer_api" | "fixture") {
    setRunning(`${source}:${group}`);
    try {
      const result = await importGroup.mutateAsync({ group_id: group, source });
      const issues = result.issues?.filter((i) => i.severity === "error").length ?? 0;
      const message = `${source === "fixture" ? "Fixtures" : "Group"} ${group}: ${plural(result.received ?? 0, "conversation")} received`;
      if (result.status === "completed") toast.success(message, { description: importSummary(result) });
      else toast.warning(message, { description: `${importSummary(result)}${issues ? ` · ${plural(issues, "record")} with errors` : ""}` });
      onImported?.(result);
    } catch (error) {
      toast.error(`Import of ${group} failed`, { description: errorMessage(error) });
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && configured) void run(groupId.trim(), "organizer_api");
        }}
      >
        <Field
          label="Dataset group_id"
          htmlFor={fieldId}
          className="w-44"
          error={groupId && !valid ? "Letters, digits, . _ - only" : undefined}
        >
          <Input
            id={fieldId}
            value={groupId}
            onChange={(event) => setGroupId(event.target.value)}
            placeholder="DEV"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={groupId !== "" && !valid}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={!valid || !configured} loading={running === `organizer_api:${groupId.trim()}`}>
          <CloudDownload aria-hidden />
          Import from organizers’ API
        </Button>
      </form>
      {info.isSuccess && !configured ? (
        <Notice tone="warning" title="Organizers’ API is not configured">
          Set <span className="font-mono text-xs">ATLAS_CQA_SOURCE_URL</span> in the repo’s <span className="font-mono text-xs">.env</span> (the signed
          endpoint, without <span className="font-mono text-xs">group_id</span>) and restart the API. ATLAS does not invent conversations when the API is
          unavailable.
        </Notice>
      ) : (
        <p className="text-2xs text-ink-3">
          Re-importing a group is safe: unchanged conversations are kept, changed transcripts get a new revision, and earlier evaluations stay as they
          were.
        </p>
      )}
      {info.data?.fixtures_enabled && info.data.fixture_groups.length ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <span className="inline-flex items-center gap-1.5 text-2xs text-ink-3">
            <FlaskConical className="size-3.5" aria-hidden />
            Development fixtures (synthetic, labelled):
          </span>
          {info.data.fixture_groups.map((group) => (
            <Button key={group} size="sm" variant="ghost" onClick={() => run(group, "fixture")} loading={running === `fixture:${group}`}>
              Load {group}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ImportDialog() {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <CloudDownload aria-hidden />
          Import…
        </Button>
      </DialogTrigger>
      <DialogContent title="Import conversations" description="Fetch a dataset group from the organizers’ API through the ATLAS backend.">
        <ImportForm onImported={(run) => run.status !== "failed" && setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
