"use client";

import { CheckSquare, FileCode2, Puzzle, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useChallenge } from "@/lib/api/hooks";
import type { AnalysisInfo, DatasetDetail, Filter } from "@/lib/api/types";
import { useStoredJson } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { AnalysisRunner } from "@/components/analysis/analysis-runner";
import { FilterBar } from "@/components/data/filter-bar";
import { PageHeader, WithDataset } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/overlays";
import { Badge, EmptyState, Notice, Panel, PanelHeader, Skeleton } from "@/components/ui/surface";

/** Mirrors the case-reveal checklist in docs/tomorrow-playbook.md. Ticks are stored per browser. */
const CHECKLIST: { id: string; text: string; detail?: string }[] = [
  { id: "question", text: "Write the exact question and how it is judged", detail: "Copy the evaluation criteria verbatim into a finding so the whole team sees it." },
  { id: "deliverable", text: "Name the deliverable", detail: "Score, ranking, segmentation, forecast, dashboard, recommendations — and its format." },
  { id: "load", text: "Load every provided file and read Overview", detail: "Note detected issues separately from heuristic flags." },
  { id: "grain", text: "Confirm the grain: what is one row?", detail: "Find the keys, the time column, and duplicates." },
  { id: "definitions", text: "Agree the metric / target definitions", detail: "Record them as a finding before anyone builds on them." },
  { id: "ml", text: "Decide whether ML is needed at all", detail: "If descriptive analysis answers the question, skip Model Lab." },
  { id: "roles", text: "Assign owners and internal deadlines", detail: "See docs/team-handoff.md." },
  { id: "title", text: "Set CASE_TITLE in apps/api/app/challenge/router.py" },
  { id: "freeze", text: "Freeze the pitch structure two hours before the deadline" },
];

const EXTENSION_POINTS = [
  { path: "apps/api/app/challenge/analyses.py", text: "Register case analyses with category “challenge”. They appear below with a generated form." },
  { path: "apps/api/app/challenge/router.py", text: "Bespoke endpoints under /api/v1/challenge when a summary + table + chart is not enough." },
  { path: "apps/web/app/(studio)/challenge/", text: "Case-specific UI, if the generic runner is not enough." },
  { path: "docs/tomorrow-playbook.md", text: "Scenarios A–F and how to extend each layer." },
];

const NO_TICKS: string[] = [];

export function ChallengeView() {
  const challenge = useChallenge();
  const info = challenge.data;
  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title={info?.case_title ?? "Challenge"}
        description="The case-specific workspace. Everything here is empty on purpose until the case is revealed."
        meta={info && <Badge tone={info.case_title ? "good" : "neutral"}>{info.status}</Badge>}
      />
      <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Checklist />
          <Panel>
            <PanelHeader title="Where to extend" />
            <ul className="flex flex-col divide-y divide-line">
              {EXTENSION_POINTS.map((point) => (
                <li key={point.path} className="flex gap-2 px-4 py-2.5">
                  <FileCode2 className="mt-0.5 size-4 shrink-0 text-ink-3" aria-hidden />
                  <div className="min-w-0">
                    <p className="font-mono text-2xs break-all text-ink">{point.path}</p>
                    <p className="text-2xs text-ink-2">{point.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {challenge.isError ? (
            <Notice tone="critical">The challenge module could not be loaded.</Notice>
          ) : challenge.isPending ? (
            <Skeleton className="h-72" />
          ) : info!.analyses.length === 0 ? (
            <Panel>
              <EmptyState icon={Puzzle} title="No challenge analyses registered">
                Add one in apps/api/app/challenge/analyses.py; it shows up here after the API reloads.
              </EmptyState>
            </Panel>
          ) : (
            <WithDataset purpose="Challenge analyses run on the active dataset.">
              {(dataset) => <ChallengeAnalyses key={dataset.id} dataset={dataset} analyses={info!.analyses} />}
            </WithDataset>
          )}
        </div>
      </div>
    </div>
  );
}

function Checklist() {
  const [done, setDone] = useStoredJson<string[]>("atlas.challengeChecklist", NO_TICKS);
  const toggle = (id: string, value: boolean) => setDone(value ? [...new Set([...done, id])] : done.filter((d) => d !== id));
  return (
    <Panel>
      <PanelHeader
        title="Case-reveal checklist"
        description={`${done.length} of ${CHECKLIST.length} done · saved in this browser only`}
        actions={
          done.length > 0 && (
            <Button size="icon-sm" variant="ghost" aria-label="Reset checklist" onClick={() => setDone([])}>
              <RotateCcw />
            </Button>
          )
        }
      />
      <ol className="flex flex-col p-2">
        {CHECKLIST.map((item) => {
          const checked = done.includes(item.id);
          return (
            <li key={item.id}>
              <label className="flex cursor-pointer gap-2.5 rounded-md px-2 py-2 hover:bg-hover">
                <Checkbox checked={checked} onCheckedChange={(value) => toggle(item.id, Boolean(value))} className="mt-0.5" />
                <span className="min-w-0">
                  <span className={cn("block text-dense", checked ? "text-ink-3 line-through" : "text-ink")}>{item.text}</span>
                  {item.detail && <span className="block text-2xs text-ink-3">{item.detail}</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ol>
      {done.length === CHECKLIST.length && (
        <p className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-2xs text-good">
          <CheckSquare className="size-4" aria-hidden /> All set.
        </p>
      )}
    </Panel>
  );
}

function ChallengeAnalyses({ dataset, analyses }: { dataset: DatasetDetail; analyses: AnalysisInfo[] }) {
  const [selected, setSelected] = useState(analyses[0].id);
  const [filters, setFilters] = useState<Filter[]>([]);
  const current = analyses.find((a) => a.id === selected) ?? analyses[0];
  return (
    <>
      <Panel className="px-3 py-2">
        <FilterBar columns={dataset.columns} filters={filters} onChange={setFilters} />
      </Panel>
      {analyses.length > 1 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Challenge analyses">
          {analyses.map((a) => (
            <Button key={a.id} size="sm" variant={a.id === current.id ? "primary" : "secondary"} aria-pressed={a.id === current.id} onClick={() => setSelected(a.id)}>
              {a.title}
            </Button>
          ))}
        </div>
      )}
      <AnalysisRunner key={current.id} dataset={dataset} analysis={current} filters={filters} />
    </>
  );
}
