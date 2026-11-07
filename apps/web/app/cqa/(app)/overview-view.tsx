"use client";

import { Activity, ClipboardCheck, Database, FlaskConical, ListChecks } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ShareBar } from "@/components/cqa/bits";
import { EvaluateDialog } from "@/components/cqa/evaluate-dialog";
import { ImportForm, importSummary } from "@/components/cqa/import-form";
import { PageHeader, PageSkeleton } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge, EmptyState, Notice, Panel, PanelHeader, Stat } from "@/components/ui/surface";
import { errorMessage } from "@/lib/api/client";
import { useChecklists, useCreateDevChecklist, useOverview } from "@/lib/cqa/api";
import { fmtScore, fmtShare, languageName } from "@/lib/cqa/format";
import type { AuditEvent, Facet, Overview, ScoreBin } from "@/lib/cqa/types";
import { fmtDate, fmtNumber, fmtRelative, plural } from "@/lib/format";

function facetLine(facets: Facet[], label: (v: string) => string = (v) => v) {
  return facets.map((f) => `${label(f.value)} ${fmtNumber(f.count)}`).join(" · ");
}

function SourceNote({ overview }: { overview: Overview }) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-line px-4 py-2.5 text-2xs text-ink-3">
      <Database className="size-3 shrink-0" aria-hidden />
      <span className="font-medium text-ink-2">{overview.checklist_name ? `${overview.checklist_name} · v${overview.checklist_version}` : "No checklist yet"}</span>
      <span aria-hidden className="text-line-strong">
        ·
      </span>
      <span className="tabular-nums">
        n = {fmtNumber(overview.evaluated_conversations)} of {fmtNumber(overview.conversations)} conversations
      </span>
      <span aria-hidden className="text-line-strong">
        ·
      </span>
      <span>latest completed result per conversation, after reviewer overrides</span>
      {overview.mock_results ? (
        <>
          <span aria-hidden className="text-line-strong">
            ·
          </span>
          <span className="font-medium text-warning">{fmtNumber(overview.mock_results)} from the dev mock</span>
        </>
      ) : null}
    </p>
  );
}

function Histogram({ bins, max }: { bins: ScoreBin[]; max: number | null }) {
  const top = Math.max(1, ...bins.map((b) => b.count));
  const total = bins.reduce((s, b) => s + b.count, 0);
  if (!total) return <p className="px-4 py-8 text-center text-dense text-ink-3">No completed scores yet.</p>;
  return (
    <figure className="px-4 pt-4 pb-3">
      <div
        className="flex h-40 items-end gap-1"
        role="img"
        aria-label={`Score distribution: ${bins.map((b) => `${fmtScore(b.start)}–${fmtScore(b.end)}: ${b.count}`).join(", ")}`}
      >
        {bins.map((bin) => (
          <div key={bin.start} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span className="text-2xs text-ink-3 tabular-nums">{bin.count || ""}</span>
            <div className="w-full rounded-t-[3px] bg-series-1" style={{ height: `${(bin.count / top) * 100}%`, minHeight: bin.count ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1 border-t border-line pt-1">
        {bins.map((bin) => (
          <span key={bin.start} className="min-w-0 flex-1 text-center text-2xs text-ink-3 tabular-nums">
            {fmtScore(bin.start)}
          </span>
        ))}
      </div>
      <figcaption className="mt-2 text-2xs text-ink-3">
        Final score{max ? ` out of ${fmtScore(max)}` : ""}, bins of equal width · {plural(total, "conversation")}
      </figcaption>
    </figure>
  );
}

function eventHref(event: AuditEvent): string | null {
  if (event.appeal_id) return `/cqa/appeals?appeal=${event.appeal_id}`;
  if (event.conversation_id) return `/cqa/conversations/${encodeURIComponent(event.conversation_id)}${event.evaluation_id ? `?evaluation=${event.evaluation_id}` : ""}`;
  if (event.checklist_id) return `/cqa/checklists/${event.checklist_id}`;
  return null;
}

function GettingStarted({ overview, hasChecklist }: { overview: Overview; hasChecklist: boolean }) {
  const createSample = useCreateDevChecklist();
  const steps = [
    { done: overview.conversations > 0, title: "Import conversations", body: "Fetch a dataset group (e.g. DEV) from the organizers’ API below.", action: null },
    {
      done: hasChecklist,
      title: "Set up a checklist",
      body: "Enter the official criteria, or start from the unofficial development sample to try the workflow.",
      action: (
        <span className="flex flex-wrap gap-2">
          <Button size="sm" asChild>
            <Link href="/cqa/checklists">Open checklists</Link>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={createSample.isPending}
            onClick={() =>
              createSample.mutate(undefined, {
                onSuccess: () => toast.success("Development sample checklist created", { description: "Unofficial placeholder criteria." }),
                onError: (error) => toast.error("Could not create it", { description: errorMessage(error) }),
              })
            }
          >
            Use dev sample
          </Button>
        </span>
      ),
    },
    {
      done: overview.evaluated_conversations > 0,
      title: "Evaluate",
      body: "Queue evaluations; results appear here and on each conversation.",
      action: overview.conversations > 0 && hasChecklist ? <EvaluateDialog trigger={<Button size="sm">Evaluate…</Button>} /> : null,
    },
  ];
  if (steps.every((s) => s.done)) return null;
  return (
    <Panel>
      <PanelHeader title="Get started" description="Three steps to the first scores." />
      <ol className="grid md:grid-cols-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex flex-col gap-1.5 border-line px-4 py-3 max-md:border-b max-md:last:border-b-0 md:border-r md:last:border-r-0">
            <p className="flex items-center gap-2 text-dense font-medium text-ink">
              <span className="grid size-5 place-items-center rounded-full bg-hover text-2xs text-ink-2 tabular-nums">{i + 1}</span>
              {step.title}
              {step.done ? <Badge tone="good">Done</Badge> : null}
            </p>
            <p className="text-dense text-ink-2">{step.body}</p>
            {!step.done && step.action ? <div className="mt-1">{step.action}</div> : null}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export function OverviewView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const checklistId = params.get("checklist") ?? undefined;
  const overview = useOverview(checklistId);
  const checklists = useChecklists();

  if (overview.isPending) return <PageSkeleton />;
  if (overview.isError) {
    return (
      <Notice tone="critical" title="Could not load the overview">
        {errorMessage(overview.error)}
      </Notice>
    );
  }
  const data = overview.data;
  const hasChecklist = (checklists.data?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Conversation quality"
        description="Operator chats and calls scored against a versioned checklist. Every score is computed by the ATLAS scoring engine and links to the transcript lines behind it."
        actions={
          <>
            {checklists.data?.length ? (
              <Select
                aria-label="Show scores for checklist"
                value={checklistId ?? data.checklist_id ?? ""}
                onChange={(event) => router.replace(`${pathname}?checklist=${event.target.value}`, { scroll: false })}
                className="w-56"
              >
                {checklists.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            ) : null}
            {data.conversations > 0 && hasChecklist ? <EvaluateDialog /> : null}
          </>
        }
      />

      {data.mock_results > 0 ? (
        <Notice tone="warning" title="Scores below come from the development mock">
          <span className="inline-flex items-start gap-1.5">
            <FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            The mock gives deterministic placeholder answers so the import → evaluate → appeal workflow can be shown end to end. It is not an AI
            assessment. Connect the model service to replace it; nothing else changes.
          </span>
        </Notice>
      ) : null}

      <GettingStarted overview={data} hasChecklist={hasChecklist} />

      <Panel>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4 md:grid-cols-5">
          <Stat label="Conversations" value={fmtNumber(data.conversations)} detail={facetLine(data.by_language) || "none imported"} />
          <Stat
            label="Evaluated"
            value={`${fmtNumber(data.evaluated_conversations)} / ${fmtNumber(data.conversations)}`}
            detail={facetLine(data.by_channel, (v) => (v === "voice" ? "calls" : "chats")) || "—"}
          />
          <Stat
            label="Mean final score"
            value={data.mean_final_score === null ? "—" : fmtScore(data.mean_final_score)}
            detail={data.max_score ? `out of ${fmtScore(data.max_score)}` : "no scores yet"}
          />
          <Stat label="Severe errors" value={fmtNumber(data.severe_error_conversations)} detail="conversations flagged" />
          <Stat
            label="Appeals"
            value={`${fmtNumber(data.appeals_pending)} pending`}
            detail={`${fmtNumber(data.appeals_decided)} decided · ${plural(data.overridden_criteria, "override")}`}
          />
        </dl>
        <SourceNote overview={data} />
      </Panel>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Panel>
          <PanelHeader title="Score distribution" description="How final scores spread across evaluated conversations." />
          <Histogram bins={data.score_bins} max={data.max_score} />
        </Panel>
        <Panel>
          <PanelHeader
            title="Criteria"
            description="Average fulfilment per criterion (normalized 0–100%), with N/A and severe counts."
            actions={
              data.checklist_id ? (
                <Button size="sm" variant="ghost" asChild>
                  <Link href={`/cqa/checklists/${data.checklist_id}`}>
                    <ListChecks aria-hidden />
                    Checklist
                  </Link>
                </Button>
              ) : null
            }
          />
          {data.criterion_stats.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-dense">
                <thead className="bg-sunken text-left text-2xs text-ink-3">
                  <tr>
                    <th className="px-4 py-2 font-medium">Criterion</th>
                    <th className="w-[38%] px-3 py-2 font-medium">Average</th>
                    <th className="px-3 py-2 text-right font-medium">Scored</th>
                    <th className="px-3 py-2 text-right font-medium">N/A</th>
                    <th className="px-4 py-2 text-right font-medium">Severe</th>
                  </tr>
                </thead>
                <tbody>
                  {data.criterion_stats.map((c) => (
                    <tr key={c.criterion_id} className="border-t border-line">
                      <td className="px-4 py-2 text-ink">{c.name}</td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <ShareBar value={c.mean_normalized} className="flex-1" />
                          <span className="w-10 text-right text-ink-2 tabular-nums">{fmtShare(c.mean_normalized)}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{c.scored}</td>
                      <td className="px-3 py-2 text-right text-ink-2 tabular-nums">{c.na}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{c.severe ? <span className="text-critical">{c.severe}</span> : <span className="text-ink-3">0</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={ClipboardCheck} title="No criterion results yet">
              Evaluate conversations to see how each criterion is met.
            </EmptyState>
          )}
        </Panel>
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <Panel>
          <PanelHeader title="Import" description="Load a dataset group by its group_id. Import another group at any time; new conversations can be evaluated right away." />
          <div className="px-4 py-4">
            <ImportForm />
          </div>
          {data.recent_imports.length ? (
            <ul className="border-t border-line">
              {data.recent_imports.slice(0, 5).map((run) => (
                <li key={run.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line px-4 py-2 text-dense last:border-b-0">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs text-ink">{run.group_id}</span>
                    <Badge tone={run.status === "completed" ? "good" : run.status === "partial" ? "warning" : "critical"}>
                      {run.status === "completed" ? "Imported" : run.status === "partial" ? "Partly imported" : "Failed"}
                    </Badge>
                    {run.source === "fixture" ? <Badge tone="neutral">Fixture</Badge> : null}
                  </span>
                  <span className="text-xs text-ink-3 tabular-nums">
                    {run.status === "failed" ? run.error : importSummary(run)} · {fmtRelative(run.finished_at)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
        <Panel>
          <PanelHeader title="Recent activity" description="The audit trail: imports, checklist versions, evaluations, appeals and decisions." />
          {data.recent_activity.length ? (
            <ol>
              {data.recent_activity.slice(0, 12).map((event) => {
                const href = eventHref(event);
                const body = (
                  <>
                    <span className="text-ink">{event.actor}</span> · {event.summary}
                  </>
                );
                return (
                  <li key={event.id} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 border-b border-line px-4 py-2 text-dense last:border-b-0">
                    <span className="text-xs text-ink-3 tabular-nums" title={fmtDate(event.at, true)}>
                      {fmtRelative(event.at)}
                    </span>
                    {href ? (
                      <Link href={href} className="min-w-0 text-ink-2 hover:text-ink hover:underline">
                        {body}
                      </Link>
                    ) : (
                      <span className="min-w-0 text-ink-2">{body}</span>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <EmptyState icon={Activity} title="Nothing yet">
              Actions are recorded here as they happen.
            </EmptyState>
          )}
        </Panel>
      </div>
      <p className="text-2xs text-ink-3">
        Languages: {data.by_language.map((f) => languageName(f.value)).join(", ") || "—"} · Groups: {data.by_group.map((g) => g.value).join(", ") || "—"}
      </p>
    </div>
  );
}
