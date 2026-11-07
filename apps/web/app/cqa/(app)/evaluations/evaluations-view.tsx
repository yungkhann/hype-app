"use client";

import { AlertOctagon, ChevronLeft, ChevronRight, ClipboardCheck, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { EvalStatusBadge, LanguageTag, MockBadge, ScoreChange, ShareBar } from "@/components/cqa/bits";
import { EvaluateDialog } from "@/components/cqa/evaluate-dialog";
import { PageHeader } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Tip } from "@/components/ui/overlays";
import { Badge, EmptyState, Notice, Panel, PanelHeader, Skeleton } from "@/components/ui/surface";
import { errorMessage } from "@/lib/api/client";
import { useBatch, useChecklists, useEvaluations, type EvaluationQuery } from "@/lib/cqa/api";
import type { EvaluationStatus } from "@/lib/cqa/types";
import { fmtDate, fmtNumber, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

function BatchProgress({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const batch = useBatch(batchId);
  const b = batch.data;
  const finished = b ? b.completed + b.failed : 0;
  return (
    <Panel>
      <PanelHeader
        title={b?.done ? "Batch finished" : "Evaluating…"}
        description={b ? `${finished} of ${plural(b.total, "evaluation")} · ${b.completed} completed · ${b.failed} failed · ${b.running} running · ${b.pending} queued` : "Loading the batch…"}
        actions={
          <Button variant="ghost" size="icon-sm" aria-label="Hide batch progress" onClick={onClose}>
            <X aria-hidden />
          </Button>
        }
      />
      <div className="flex flex-col gap-2 px-4 py-3">
        <ShareBar value={b && b.total ? finished / b.total : 0} label={b ? `${finished} of ${b.total} finished` : undefined} />
        {b?.done && b.failed ? (
          <p className="text-2xs text-critical">
            {plural(b.failed, "evaluation")} failed. Filter by “Failed” to see why; nothing from a failed run is scored.
          </p>
        ) : null}
        {batch.isError ? <p className="text-2xs text-critical">{errorMessage(batch.error)}</p> : null}
      </div>
    </Panel>
  );
}

export function EvaluationsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const checklists = useChecklists(true);
  const query: EvaluationQuery = {
    status: (params.get("status") as EvaluationStatus | null) ?? undefined,
    checklist_id: params.get("checklist_id") ?? undefined,
    mock: params.get("mock") === null ? undefined : params.get("mock") === "true",
    batch_id: params.get("only_batch") ?? undefined,
    page: Number(params.get("page") ?? 1) || 1,
    page_size: PAGE_SIZE,
  };
  const batchId = params.get("batch");
  const evaluations = useEvaluations(query);

  const update = (patch: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    if (resetPage && !("page" in patch)) next.delete("page");
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  const data = evaluations.data;
  const page = data?.page ?? 1;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Evaluations"
        description="Every evaluation run, newest first. Each records the checklist version and evaluator it used, so past results stay reproducible."
        actions={<EvaluateDialog onQueued={(id) => update({ batch: id })} />}
      />
      {batchId ? <BatchProgress batchId={batchId} onClose={() => update({ batch: null }, false)} /> : null}
      <Panel>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <Select aria-label="Status" value={query.status ?? ""} onChange={(e) => update({ status: e.target.value })} className="w-36">
            <option value="">Any status</option>
            <option value="pending">Queued</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </Select>
          <Select aria-label="Checklist" value={query.checklist_id ?? ""} onChange={(e) => update({ checklist_id: e.target.value })} className="w-56">
            <option value="">Any checklist</option>
            {(checklists.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Evaluator"
            value={query.mock === undefined ? "" : String(query.mock)}
            onChange={(e) => update({ mock: e.target.value })}
            className="w-48"
          >
            <option value="">Any evaluator</option>
            <option value="true">Development mock only</option>
            <option value="false">Model evaluators only</option>
          </Select>
          {query.batch_id ? (
            <Badge tone="neutral">
              One batch
              <button type="button" aria-label="Show all batches" onClick={() => update({ only_batch: null })} className="-mr-0.5 rounded-sm hover:text-ink">
                <X aria-hidden />
              </button>
            </Badge>
          ) : null}
        </div>
        {evaluations.isError ? (
          <div className="p-4">
            <Notice tone="critical" title="Could not load evaluations">
              {errorMessage(evaluations.error)}
            </Notice>
          </div>
        ) : !data ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : data.total === 0 ? (
          <EmptyState icon={ClipboardCheck} title="No evaluations yet" action={<EvaluateDialog onQueued={(id) => update({ batch: id })} />}>
            Import conversations and choose a checklist, then queue an evaluation.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-dense">
              <thead className="bg-sunken text-left text-2xs font-medium text-ink-3">
                <tr>
                  <th className="px-4 py-2 font-medium">Conversation</th>
                  <th className="px-3 py-2 font-medium">Checklist</th>
                  <th className="px-3 py-2 font-medium">Evaluator</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Score</th>
                  <th className="px-3 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody className={cn(evaluations.isFetching && evaluations.isPlaceholderData && "opacity-60")}>
                {data.items.map((e) => (
                  <tr key={e.id} className="border-t border-line hover:bg-hover">
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-2">
                        <Link
                          href={`/cqa/conversations/${encodeURIComponent(e.conversation_id)}?evaluation=${e.id}`}
                          className="font-mono text-xs text-accent-ink hover:underline"
                        >
                          {e.conversation_id}
                        </Link>
                        {e.conversation_language ? <LanguageTag code={e.conversation_language} /> : null}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-ink-2">
                      {e.checklist_name} <span className="text-ink-3">v{e.checklist_version}</span>
                    </td>
                    <td className="px-3 py-2">{e.is_mock ? <MockBadge /> : <span className="text-ink-2">{e.evaluator}</span>}</td>
                    <td className="px-3 py-2">
                      <EvalStatusBadge status={e.status} />
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {e.status === "completed" ? <ScoreChange original={e.original_total} final={e.final_total} max={e.max_score} /> : <span className="text-ink-3">—</span>}
                    </td>
                    <td className="px-3 py-2 text-xs whitespace-nowrap text-ink-3 tabular-nums">{fmtDate(e.created_at, true)}</td>
                    <td className="max-w-[20rem] px-4 py-2 text-xs">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {e.severe_errors ? (
                          <Badge tone="critical">
                            <AlertOctagon aria-hidden />
                            {plural(e.severe_errors, "severe error")}
                          </Badge>
                        ) : null}
                        {e.overridden ? <Badge tone="info">Overridden</Badge> : null}
                        {e.stale ? <Badge tone="warning">Transcript changed</Badge> : null}
                        {e.error ? (
                          <Tip content={e.error.issues?.slice(0, 4).join(" · ") || e.error.message}>
                            <span className="truncate text-critical">{e.error.message}</span>
                          </Tip>
                        ) : null}
                        {e.batch_id && !query.batch_id ? (
                          <button type="button" className="text-ink-3 hover:text-ink-2 hover:underline" onClick={() => update({ only_batch: e.batch_id ?? null })}>
                            batch
                          </button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-2xs text-ink-3">
            <span className="tabular-nums">{fmtNumber(data.total)} evaluations · scores from the ATLAS scoring engine; struck-through = before reviewer overrides</span>
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) }, false)}>
                <ChevronLeft aria-hidden />
                Previous
              </Button>
              <span className="px-1 tabular-nums">
                {page} / {pages}
              </span>
              <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => update({ page: String(page + 1) }, false)}>
                Next
                <ChevronRight aria-hidden />
              </Button>
            </span>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
