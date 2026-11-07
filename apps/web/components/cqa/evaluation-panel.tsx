"use client";

import { ChevronRight, ClipboardCheck, Gavel, History, Quote, RotateCcw, ScanSearch } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, useFieldId } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/overlays";
import { Badge, EmptyState, Notice, Panel, PanelHeader, Skeleton, Spinner } from "@/components/ui/surface";
import { errorMessage } from "@/lib/api/client";
import { useCreateAppeal, useEvaluation, useRerun } from "@/lib/cqa/api";
import { answerLabel, fmtPoints, fmtScore, fmtShare } from "@/lib/cqa/format";
import { useDemoIdentity } from "@/lib/cqa/role";
import type {
  Appeal,
  AuditEvent,
  Criterion,
  CriterionView,
  EvaluationBrief,
  EvaluationDetail,
  EvidenceRef,
  InspectedSpan,
  ScoreBreakdown,
} from "@/lib/cqa/types";
import { fmtDate, fmtRelative, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  AppealBadge,
  EvalStatusBadge,
  MockBadge,
  OutcomeBadge,
  OverriddenBadge,
  Score,
  SevereBadge,
  SpeakerLabel,
} from "./bits";
import { EvaluateDialog } from "./evaluate-dialog";
import type { Highlight } from "./transcript";

export type CiteHandler = (highlight: Highlight) => void;

/**
 * One evaluation of one conversation: totals, sections, and every criterion with its answer, explanation and
 * evidence. Evidence and inspected spans are buttons that take the transcript to the cited lines.
 */
export function EvaluationPanel({
  conversationId,
  evaluations,
  evaluationId,
  onSelectEvaluation,
  focusedCriterion,
  onFocusCriterion,
  onCite,
}: {
  conversationId: string;
  evaluations: EvaluationBrief[];
  evaluationId: string | null;
  onSelectEvaluation: (id: string) => void;
  focusedCriterion: string | null;
  onFocusCriterion: (criterionId: string | null) => void;
  onCite: CiteHandler;
}) {
  const detail = useEvaluation(evaluationId);
  const historyId = useFieldId("eval");

  if (!evaluations.length) {
    return (
      <Panel>
        <PanelHeader title="Evaluation" />
        <EmptyState
          icon={ClipboardCheck}
          title="Not evaluated yet"
          action={<EvaluateDialog conversationIds={[conversationId]} onQueued={() => undefined} />}
        >
          Evaluate this conversation against a checklist version. Results cite the transcript lines they rely on.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <Panel aria-label="Evaluation">
      <PanelHeader
        title="Evaluation"
        description={detail.data ? `${detail.data.evaluation.checklist_name} · v${detail.data.evaluation.checklist_version}` : undefined}
        actions={
          <EvaluateDialog
            conversationIds={[conversationId]}
            trigger={
              <Button size="sm">
                <ClipboardCheck aria-hidden />
                Evaluate again
              </Button>
            }
          />
        }
      />
      {evaluations.length > 1 ? (
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <label htmlFor={historyId} className="flex shrink-0 items-center gap-1.5 text-2xs font-medium text-ink-3">
            <History className="size-3.5" aria-hidden />
            Result
          </label>
          <Select id={historyId} className="min-w-0 flex-1" value={evaluationId ?? ""} onChange={(event) => onSelectEvaluation(event.target.value)}>
            {evaluations.map((e, i) => (
              <option key={e.id} value={e.id}>
                {i === 0 ? "Latest · " : ""}
                {e.checklist_name} v{e.checklist_version} · {e.status === "completed" ? fmtScore(e.final_total) : e.status} · {fmtDate(e.created_at, true)}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {detail.isPending ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-24" />
          <Skeleton className="h-48" />
        </div>
      ) : detail.isError ? (
        <div className="p-4">
          <Notice tone="critical" title="Could not load the evaluation">
            {errorMessage(detail.error)}
          </Notice>
        </div>
      ) : (
        <EvaluationBody detail={detail.data} focusedCriterion={focusedCriterion} onFocusCriterion={onFocusCriterion} onCite={onCite} />
      )}
    </Panel>
  );
}

function EvaluationBody({
  detail,
  focusedCriterion,
  onFocusCriterion,
  onCite,
}: {
  detail: EvaluationDetail;
  focusedCriterion: string | null;
  onFocusCriterion: (criterionId: string | null) => void;
  onCite: CiteHandler;
}) {
  const record = detail.evaluation;
  const rerun = useRerun();
  const final = record.final_score;
  const original = record.original_score;
  const overrides = record.overrides ?? [];

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-2xs text-ink-3">
        <EvalStatusBadge status={record.status} />
        {record.evaluator.is_mock ? <MockBadge /> : <Badge tone="neutral">{record.evaluator.label}</Badge>}
        {detail.stale ? (
          <Badge tone="warning">Transcript changed since this evaluation</Badge>
        ) : null}
        <span className="ml-auto tabular-nums">{record.completed_at ? `Completed ${fmtRelative(record.completed_at)}` : `Queued ${fmtRelative(record.created_at)}`}</span>
      </div>

      {record.status === "pending" || record.status === "running" ? (
        <div className="px-4 py-8">
          <Spinner label={record.status === "pending" ? "Waiting for the evaluator…" : "The evaluator is working…"} />
        </div>
      ) : null}

      {record.status === "failed" ? (
        <div className="flex flex-col gap-3 p-4">
          <Notice
            tone="critical"
            title={record.error?.code === "invalid_output" ? "The evaluator’s answer was rejected" : "Evaluation failed"}
            action={
              <Button
                size="sm"
                loading={rerun.isPending}
                onClick={() =>
                  rerun.mutate(record.id, {
                    onSuccess: () => toast.success("Evaluation queued again"),
                    onError: (error) => toast.error("Could not re-run", { description: errorMessage(error) }),
                  })
                }
              >
                <RotateCcw aria-hidden />
                Re-run
              </Button>
            }
          >
            <p>{record.error?.message}</p>
            {record.error?.issues?.length ? (
              <ul className="mt-1.5 list-disc pl-4 text-xs">
                {record.error.issues.slice(0, 8).map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
                {record.error.issues.length > 8 ? <li>…and {record.error.issues.length - 8} more</li> : null}
              </ul>
            ) : null}
          </Notice>
          <p className="text-2xs text-ink-3">Nothing from a rejected answer is scored or shown as a result.</p>
        </div>
      ) : null}

      {record.status === "completed" && final ? (
        <>
          <ScoreSummary final={final} original={original ?? null} overrides={overrides.length} />
          <Sections score={final} />
          <ul className="flex flex-col" aria-label="Criteria">
            {detail.criteria.map((view) => (
              <CriterionRow
                key={view.criterion.id}
                view={view}
                evaluationId={record.id}
                detail={detail}
                expanded={focusedCriterion === view.criterion.id}
                onToggle={() => onFocusCriterion(focusedCriterion === view.criterion.id ? null : view.criterion.id)}
                onCite={onCite}
              />
            ))}
          </ul>
          {record.warnings?.length ? (
            <div className="border-t border-line px-4 py-3">
              <p className="text-2xs font-medium text-ink-3">Validation warnings</p>
              <ul className="mt-1 list-disc pl-4 text-xs text-ink-2">
                {record.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
      <AuditTrail events={detail.audit} />
    </div>
  );
}

function ScoreSummary({ final, original, overrides }: { final: ScoreBreakdown; original: ScoreBreakdown | null; overrides: number }) {
  const changed = original && original.total !== final.total;
  const rounding = final.rounding;
  return (
    <div className="flex flex-col gap-3 border-b border-line px-4 py-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <p className="text-xs text-ink-3">{overrides ? "Final score" : "Score"}</p>
          <p className="mt-0.5" data-testid="final-score">
            {final.status === "scored" ? (
              <Score value={final.total} max={final.max_score} size="lg" />
            ) : (
              <span className="text-lg font-medium text-ink-2">{final.status === "not_applicable" ? "Not applicable" : "Incomplete"}</span>
            )}
          </p>
        </div>
        {overrides ? (
          <div>
            <p className="text-xs text-ink-3">Original score</p>
            <p className="mt-0.5 text-lg" data-testid="original-score">
              <Score value={original?.total} max={original?.max_score} />
            </p>
          </div>
        ) : null}
        {overrides ? (
          <p className="pb-1 text-dense text-ink-2">
            {plural(overrides, "reviewer override")}
            {changed ? ` · ${(final.total ?? 0) - (original?.total ?? 0) > 0 ? "+" : ""}${fmtScore((final.total ?? 0) - (original?.total ?? 0))}` : " · total unchanged"}
          </p>
        ) : null}
      </div>
      {final.severe_errors.length ? (
        <Notice tone="critical" title={`Severe error: ${final.severe_errors.length === 1 ? "1 criterion" : `${final.severe_errors.length} criteria`}`}>
          {final.severe_error_applied
            ? `Policy “zero total”: the total is 0 (it would be ${fmtScore(final.total_before_severe_policy)}).`
            : "Policy “flag only”: tracked separately, the total is not changed."}
        </Notice>
      ) : null}
      {final.status === "incomplete" && final.issues.length ? (
        <Notice tone="warning" title="No total: some criteria have no valid answer">
          <ul className="list-disc pl-4 text-xs">
            {final.issues.slice(0, 5).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <p className="text-2xs text-ink-3">
        ATLAS scoring engine · weights over applicable criteria ({fmtPoints(final.applicable_weight)} of {fmtPoints(final.total_weight)}; N/A weight
        redistributed) · rounding {rounding.mode === "none" ? "off" : `${(rounding.mode ?? "half_up").replace("_", " ")} to ${rounding.digits ?? 1} dp`}
      </p>
    </div>
  );
}

function Sections({ score }: { score: ScoreBreakdown }) {
  if (!score.sections.length) return null;
  return (
    <div className="border-b border-line px-4 py-3">
      <p className="text-2xs font-medium text-ink-3">Sections</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {score.sections.map((section) => (
          <li key={section.section_id} className="flex items-baseline justify-between gap-3 text-dense">
            <span className="min-w-0 truncate text-ink-2">{section.name}</span>
            <span className="shrink-0 text-ink-3 tabular-nums">
              {section.status === "na" ? (
                "N/A"
              ) : (
                <>
                  <span className="font-medium text-ink">{fmtScore(section.score)}</span>
                  <span className="text-xs"> · {fmtPoints(section.points)} of {fmtPoints(section.max_points)} pts</span>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CriterionRow({
  view,
  evaluationId,
  detail,
  expanded,
  onToggle,
  onCite,
}: {
  view: CriterionView;
  evaluationId: string;
  detail: EvaluationDetail;
  expanded: boolean;
  onToggle: () => void;
  onCite: CiteHandler;
}) {
  const [identity] = useDemoIdentity();
  const { criterion, final, original, final_score: score, overridden } = view;
  const appeals = detail.appeals.filter((a) => a.criterion_id === criterion.id);
  const pendingAppeal = appeals.find((a) => a.status === "pending");
  const latestAppeal = appeals[appeals.length - 1];
  const overrides = (detail.evaluation.overrides ?? []).filter((o) => o.criterion_id === criterion.id);
  const panelId = `criterion-${criterion.id}`;

  return (
    <li className={cn("border-b border-line last:border-b-0", expanded && "bg-raised")} data-criterion-id={criterion.id}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-hover"
      >
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-ink-3 transition-transform duration-100", expanded && "rotate-90")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-dense font-medium text-ink">{criterion.name}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <OutcomeBadge score={score} />
            {score?.severe_error ? <SevereBadge reason={final?.severe_error_reason} /> : null}
            {overridden ? <OverriddenBadge /> : null}
            {latestAppeal ? <AppealBadge status={latestAppeal.status} /> : null}
          </span>
        </span>
        <span className="shrink-0 text-right text-dense tabular-nums">
          <span className="font-medium text-ink">{score?.status === "na" ? "N/A" : fmtPoints(score?.points)}</span>
          {score?.status !== "na" ? <span className="text-xs text-ink-3"> / {fmtPoints(score?.max_points)}</span> : null}
          <span className="block text-2xs text-ink-3">weight {fmtPoints(criterion.weight)} · {fmtShare(score?.effective_weight)}</span>
        </span>
      </button>
      {expanded ? (
        <div id={panelId} className="flex flex-col gap-3 px-4 pt-1 pb-4 pl-[2.625rem] text-dense">
          <div>
            <p className="text-2xs font-medium text-ink-3">Answer</p>
            <p className="mt-0.5 text-ink">
              {answerLabel(criterion, final?.value, final?.is_na)}
              {overridden && original ? (
                <span className="text-ink-3"> · originally {answerLabel(criterion, original.value, original.is_na)}</span>
              ) : null}
            </p>
            {final?.is_na && final.na_reason ? <p className="mt-0.5 text-ink-2">N/A because: {final.na_reason}</p> : null}
          </div>
          {final?.explanation ? (
            <div>
              <p className="text-2xs font-medium text-ink-3">{final.source === "reviewer" ? "Evaluator explanation (kept from the original)" : "Explanation"}</p>
              <p className="mt-0.5 leading-relaxed whitespace-pre-wrap text-ink-2">{final.explanation}</p>
            </div>
          ) : null}
          {final?.severe_error && final.severe_error_reason ? (
            <Notice tone="critical" title="Severe error">
              {final.severe_error_reason}
            </Notice>
          ) : null}
          <Evidence evidence={final?.evidence ?? []} spans={final?.inspected_spans ?? []} onCite={onCite} />
          {overrides.map((o) => (
            <div key={o.appeal_id} className="rounded-md bg-info-soft px-3 py-2">
              <p className="text-2xs font-medium text-info">Reviewer decision · {o.reviewer} · {fmtDate(o.decided_at, true)}</p>
              <p className="mt-0.5 text-ink-2">{o.explanation}</p>
            </div>
          ))}
          <p className="text-2xs text-ink-3 tabular-nums">
            {score?.raw_score !== null && score?.raw_score !== undefined ? `Raw ${fmtPoints(score.raw_score)} of ${fmtPoints(score.raw_max)} · ` : ""}
            weight {fmtPoints(criterion.weight)} → {fmtShare(score?.effective_weight)} of the total
            {criterion.na_allowed ? " · N/A allowed" : ""}
          </p>
          <AppealAction
            evaluationId={evaluationId}
            criterion={criterion}
            pending={pendingAppeal}
            canAppeal={identity.role === "operator" && detail.evaluation.status === "completed" && !detail.stale}
            role={identity.role}
          />
        </div>
      ) : null}
    </li>
  );
}

function Evidence({ evidence, spans, onCite }: { evidence: EvidenceRef[]; spans: InspectedSpan[]; onCite: CiteHandler }) {
  if (!evidence.length && !spans.length) return null;
  return (
    <div>
      <p className="text-2xs font-medium text-ink-3">Evidence from the transcript</p>
      <ul className="mt-1 flex flex-col gap-1">
        {evidence.map((ref, i) => (
          <li key={`${ref.message_id}-${i}`}>
            <button
              type="button"
              onClick={() => onCite({ messageId: ref.message_id, start: ref.char_start, end: ref.char_end })}
              className="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
              aria-label={`Show ${ref.message_id} in the transcript`}
            >
              <Quote className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 text-2xs text-ink-3">
                  <span className="font-mono text-accent-ink group-hover:underline">{ref.message_id}</span>
                  <SpeakerLabel speaker={ref.speaker} className="text-2xs" />
                  <span className="tabular-nums">{ref.timestamp}</span>
                </span>
                <span className="mt-0.5 block text-ink-2">“{ref.excerpt}”</span>
              </span>
            </button>
          </li>
        ))}
        {spans.map((span, i) => (
          <li key={`span-${i}`}>
            <button
              type="button"
              onClick={() => onCite({ messageId: span.start_message_id })}
              className="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
            >
              <ScanSearch className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
              <span className="min-w-0 flex-1 text-ink-2">
                Inspected{" "}
                <span className="font-mono text-accent-ink group-hover:underline">
                  {span.start_message_id}–{span.end_message_id}
                </span>{" "}
                ({plural(span.message_count, "line")}){span.note ? `: ${span.note}` : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AppealAction({
  evaluationId,
  criterion,
  pending,
  canAppeal,
  role,
}: {
  evaluationId: string;
  criterion: Criterion;
  pending: Appeal | undefined;
  canAppeal: boolean;
  role: "operator" | "reviewer";
}) {
  if (pending) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <AppealBadge status="pending" />
        <Button size="sm" variant={role === "reviewer" ? "primary" : "ghost"} asChild>
          <Link href={`/cqa/appeals?appeal=${pending.id}`}>{role === "reviewer" ? "Review appeal" : "View appeal"}</Link>
        </Button>
      </div>
    );
  }
  if (!canAppeal) {
    return role === "reviewer" ? <p className="text-2xs text-ink-3">Operators appeal a score; switch the demo role to Operator to file one.</p> : null;
  }
  return <AppealDialog evaluationId={evaluationId} criterion={criterion} />;
}

function AppealDialog({ evaluationId, criterion }: { evaluationId: string; criterion: Criterion }) {
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useDemoIdentity();
  const [comment, setComment] = useState("");
  const [name, setName] = useState(identity.operatorName);
  const create = useCreateAppeal();
  const ids = { comment: useFieldId("comment"), name: useFieldId("name") };
  const valid = comment.trim().length >= 3 && name.trim().length > 0;

  async function submit() {
    const submittedBy = name.trim();
    setIdentity({ operatorName: submittedBy });
    try {
      await create.mutateAsync({ evaluation_id: evaluationId, criterion_id: criterion.id, comment: comment.trim(), submitted_by: submittedBy });
      toast.success("Appeal submitted", { description: "A reviewer will confirm or override this score." });
      setOpen(false);
      setComment("");
    } catch (error) {
      toast.error("Could not submit the appeal", { description: errorMessage(error) });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="self-start">
          <Gavel aria-hidden />
          Appeal this score
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Appeal a criterion score"
        description={criterion.name}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} disabled={!valid} loading={create.isPending}>
              Submit appeal
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Why is this score wrong?" htmlFor={ids.comment} hint="Point to the lines that support your case, e.g. “m5 greets the client”.">
            <Textarea id={ids.comment} value={comment} maxLength={2000} onChange={(event) => setComment(event.target.value)} autoFocus />
          </Field>
          <Field label="Submitted by" htmlFor={ids.name} hint="Demo name, no sign-in.">
            <Input id={ids.name} value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AuditTrail({ events }: { events: AuditEvent[] }) {
  const [open, setOpen] = useState(false);
  if (!events.length) return null;
  return (
    <div className="border-t border-line">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-2xs font-medium text-ink-3 hover:bg-hover hover:text-ink-2"
      >
        <ChevronRight className={cn("size-3.5 transition-transform duration-100", open && "rotate-90")} aria-hidden />
        Audit trail ({events.length})
      </button>
      {open ? (
        <ol className="flex flex-col gap-1.5 px-4 pb-3">
          {events.map((event) => (
            <li key={event.id} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 text-xs">
              <span className="text-ink-3 tabular-nums">{fmtDate(event.at, true)}</span>
              <span className="text-ink-2">
                <span className="text-ink">{event.actor}</span> · {event.summary}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
