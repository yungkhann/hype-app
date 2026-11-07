"use client";

import { ArrowRight, Gavel, MessagesSquare, Quote } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AppealBadge, MockBadge, OutcomeBadge, Score, SevereBadge, SpeakerLabel } from "@/components/cqa/bits";
import { Transcript } from "@/components/cqa/transcript";
import { PageHeader } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea, useFieldId } from "@/components/ui/input";
import { Switch, Tabs, TabsList, TabsTrigger } from "@/components/ui/overlays";
import { Badge, EmptyState, Notice, Panel, PanelHeader, Skeleton } from "@/components/ui/surface";
import { errorMessage } from "@/lib/api/client";
import { useAppeal, useAppeals, useDecideAppeal } from "@/lib/cqa/api";
import { answerChoices, answerLabel, answerTypeSummary, fmtPoints, fmtScore, languageTag, spanMessageIds } from "@/lib/cqa/format";
import { useDemoIdentity } from "@/lib/cqa/role";
import type { Appeal, AppealDetail } from "@/lib/cqa/types";
import { fmtDate, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

type Tab = "pending" | "decided" | "all";

/** Deep link into the conversation workspace with the appealed evaluation and criterion focused. */
function conversationLink(appeal: Appeal, messageId?: string) {
  const params = new URLSearchParams({ evaluation: appeal.evaluation_id, criterion: appeal.criterion_id });
  if (messageId) params.set("msg", messageId);
  return `/cqa/conversations/${encodeURIComponent(appeal.conversation_id)}?${params.toString()}`;
}

export function AppealsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [identity] = useDemoIdentity();
  const [tab, setTab] = useState<Tab>("pending");
  const appeals = useAppeals();
  const all = appeals.data ?? [];
  const pending = all.filter((a) => a.status === "pending");
  const decided = all.filter((a) => a.status !== "pending");
  const list = tab === "pending" ? pending : tab === "decided" ? decided : all;
  const selected = params.get("appeal") ?? list[0]?.id ?? null;

  const select = (id: string) => router.replace(`${pathname}?appeal=${id}`, { scroll: false });

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Appeals"
        description={
          identity.role === "reviewer"
            ? "Review disputed criterion scores: read the operator’s comment, check the evidence, then confirm or override with an explanation."
            : "Appeals and their outcome. Appeal a score from the conversation page; a reviewer confirms or overrides it."
        }
        meta={
          <Badge tone={identity.role === "reviewer" ? "accent" : "neutral"}>
            Acting as {identity.role === "reviewer" ? `reviewer · ${identity.reviewerName}` : `operator · ${identity.operatorName}`}
          </Badge>
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <Panel>
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
            <TabsList className="px-3">
              <TabsTrigger value="pending">
                Pending <span className="text-ink-3 tabular-nums">{pending.length}</span>
              </TabsTrigger>
              <TabsTrigger value="decided">
                Decided <span className="text-ink-3 tabular-nums">{decided.length}</span>
              </TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>
          {appeals.isPending ? (
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : appeals.isError ? (
            <div className="p-3">
              <Notice tone="critical" title="Could not load appeals">
                {errorMessage(appeals.error)}
              </Notice>
            </div>
          ) : list.length === 0 ? (
            <EmptyState icon={Gavel} title={tab === "pending" ? "No pending appeals" : "Nothing here yet"}>
              {tab === "pending" ? "Operators appeal a criterion score from the conversation page." : "Decided appeals appear here."}
            </EmptyState>
          ) : (
            <ul aria-label="Appeals">
              {list.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => select(a.id)}
                    aria-current={a.id === selected ? "true" : undefined}
                    className={cn(
                      "flex w-full flex-col gap-1 border-b border-line px-4 py-2.5 text-left hover:bg-hover",
                      a.id === selected && "bg-accent-soft hover:bg-accent-soft",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-dense font-medium text-ink">{a.criterion_name}</span>
                      <AppealBadge status={a.status} short />
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-2xs text-ink-3">
                      <span className="font-mono">{a.conversation_id}</span>
                      <span aria-hidden>·</span>
                      <span>{a.submitted_by}</span>
                      <span aria-hidden>·</span>
                      <span className="tabular-nums">{fmtRelative(a.created_at)}</span>
                    </span>
                    <span className="line-clamp-1 text-xs text-ink-2">“{a.comment}”</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {selected ? (
          <AppealReview key={selected} id={selected} />
        ) : (
          <Panel className="hidden lg:block">
            <EmptyState icon={Gavel} title="Select an appeal">
              Its comment, the disputed score with evidence and the transcript context appear here.
            </EmptyState>
          </Panel>
        )}
      </div>
    </div>
  );
}

function AppealReview({ id }: { id: string }) {
  const appeal = useAppeal(id);
  const [identity] = useDemoIdentity();

  if (appeal.isPending) {
    return (
      <Panel className="flex flex-col gap-3 p-4">
        <Skeleton className="h-6 w-60" />
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </Panel>
    );
  }
  if (appeal.isError) {
    return (
      <Notice tone="critical" title="Could not load the appeal">
        {errorMessage(appeal.error)}
      </Notice>
    );
  }
  const data = appeal.data;
  const a = data.appeal;
  const disputed = a.disputed_result;
  const evidence = disputed?.evidence ?? [];
  const cited = new Set(evidence.map((e) => e.message_id));
  const spans = spanMessageIds(disputed?.inspected_spans, data.context);

  return (
    <Panel aria-label="Appeal review">
      <PanelHeader
        title={a.criterion_name}
        description={`Appeal by ${a.submitted_by} · ${fmtDate(a.created_at, true)} · ${data.evaluation.checklist_name} v${a.checklist_version}`}
        actions={
          <>
            <AppealBadge status={a.status} />
            <Button size="sm" asChild>
              <Link href={conversationLink(a, evidence[0]?.message_id)}>
                <MessagesSquare aria-hidden />
                Open conversation
              </Link>
            </Button>
          </>
        }
      />
      <section className="border-b border-line px-4 py-3" aria-labelledby={`comment-${a.id}`}>
        <h3 id={`comment-${a.id}`} className="text-2xs font-medium text-ink-3">
          Operator’s comment
        </h3>
        <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-ink">{a.comment}</p>
      </section>

      <section className="grid gap-4 border-b border-line px-4 py-3 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="text-2xs font-medium text-ink-3">Disputed result</h3>
          <div className="flex flex-wrap items-center gap-1.5">
            <OutcomeBadge score={data.original_score} />
            {disputed?.severe_error ? <SevereBadge reason={disputed.severe_error_reason} /> : null}
            {data.evaluation.is_mock ? <MockBadge /> : null}
          </div>
          <p className="text-dense text-ink">
            {answerLabel(data.criterion, disputed?.value, disputed?.is_na)}
            <span className="text-ink-3 tabular-nums">
              {" "}
              · {a.disputed_points === null ? "N/A" : `${fmtPoints(a.disputed_points)} of ${fmtPoints(a.disputed_max_points)} pts`}
            </span>
          </p>
          {disputed?.is_na && disputed.na_reason ? <p className="text-dense text-ink-2">N/A because: {disputed.na_reason}</p> : null}
          {disputed?.explanation ? <p className="text-dense leading-relaxed text-ink-2">{disputed.explanation}</p> : null}
          <p className="text-2xs text-ink-3 tabular-nums">
            Total when appealed: {fmtScore(a.total_at_submission)} · now <Score value={data.evaluation.final_total} max={data.evaluation.max_score} />
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="text-2xs font-medium text-ink-3">Criterion definition</h3>
          <p className="text-dense text-ink-2">{data.criterion.description || "No description."}</p>
          <p className="text-2xs text-ink-3">
            {answerTypeSummary(data.criterion)} · weight {fmtPoints(data.criterion.weight)}
            {data.criterion.na_allowed ? ` · N/A allowed${data.criterion.na_rule ? `: ${data.criterion.na_rule}` : ""}` : " · N/A not allowed"}
          </p>
          {data.criterion.severe_error_enabled ? (
            <p className="text-2xs text-ink-3">Severe error: {data.criterion.severe_error_rule || "enabled"}</p>
          ) : null}
        </div>
      </section>

      {evidence.length ? (
        <section className="border-b border-line px-4 py-3">
          <h3 className="text-2xs font-medium text-ink-3">Evidence the score relied on</h3>
          <ul className="mt-1 flex flex-col gap-1">
            {evidence.map((ref, i) => (
              <li key={`${ref.message_id}-${i}`}>
                <Link href={conversationLink(a, ref.message_id)} className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
                  <Quote className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 text-2xs text-ink-3">
                      <span className="font-mono text-accent-ink group-hover:underline">{ref.message_id}</span>
                      <SpeakerLabel speaker={ref.speaker} className="text-2xs" />
                      <span className="tabular-nums">{ref.timestamp}</span>
                    </span>
                    <span className="block text-dense text-ink-2">“{ref.excerpt}”</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.context.length ? (
        <section className="border-b border-line">
          <h3 className="px-4 pt-3 text-2xs font-medium text-ink-3">Transcript context: cited lines with two lines either side</h3>
          <Transcript messages={data.context} citedIds={cited} spanIds={spans} lang={languageTag(data.evaluation.conversation_language)} />
        </section>
      ) : null}

      {data.evaluation_stale ? (
        <div className="px-4 pt-3">
          <Notice tone="warning" title="The transcript changed after this evaluation">
            Decide on the evidence shown; the conversation was re-imported with different text since.
          </Notice>
        </div>
      ) : null}

      {a.status === "pending" ? (
        identity.role === "reviewer" ? (
          <DecisionForm detail={data} />
        ) : (
          <div className="p-4">
            <Notice tone="info" title="Waiting for a reviewer">
              Switch the demo role to Reviewer (top right) to confirm or override this score.
            </Notice>
          </div>
        )
      ) : (
        <Decision appeal={a} detail={data} />
      )}

      {data.audit.length ? (
        <section className="px-4 py-3">
          <h3 className="text-2xs font-medium text-ink-3">Audit trail</h3>
          <ol className="mt-1.5 flex flex-col gap-1">
            {data.audit.map((event) => (
              <li key={event.id} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-2 text-xs">
                <span className="text-ink-3 tabular-nums">{fmtDate(event.at, true)}</span>
                <span className="text-ink-2">
                  <span className="text-ink">{event.actor}</span> · {event.summary}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </Panel>
  );
}

function Decision({ appeal, detail }: { appeal: Appeal; detail: AppealDetail }) {
  const d = appeal.decision;
  if (!d) return null;
  return (
    <section className="border-b border-line px-4 py-3" aria-label="Reviewer decision">
      <h3 className="text-2xs font-medium text-ink-3">Reviewer decision</h3>
      <p className="mt-1.5 text-dense font-medium text-ink">
        {d.decision === "override" ? "Score overridden" : "Score confirmed"} · {d.reviewer} · {fmtDate(d.decided_at, true)}
      </p>
      <p className="mt-1 text-dense whitespace-pre-wrap text-ink-2">{d.explanation}</p>
      {d.decision === "override" ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-dense text-ink-2">
          <span className="text-ink-3 line-through">{answerLabel(detail.criterion, d.previous_result?.value, d.previous_result?.is_na)}</span>
          <ArrowRight className="size-3.5 text-ink-3" aria-label="changed to" />
          <span className="text-ink">{answerLabel(detail.criterion, d.new_result?.value, d.new_result?.is_na)}</span>
        </p>
      ) : null}
      <p className="mt-1 text-2xs text-ink-3 tabular-nums" data-testid="decision-totals">
        Total {fmtScore(d.total_before)} → {fmtScore(d.total_after)}. Recalculated by the scoring engine; the original evaluation is kept.
      </p>
    </section>
  );
}

function DecisionForm({ detail }: { detail: AppealDetail }) {
  const [identity, setIdentity] = useDemoIdentity();
  const decide = useDecideAppeal(detail.appeal.id);
  const criterion = detail.criterion;
  const current = detail.current_result;
  const choices = answerChoices(criterion);
  const [decision, setDecision] = useState<"confirm" | "override">("confirm");
  const [valueKey, setValueKey] = useState<string>(() => {
    const currentValue = current && !current.is_na ? current.value : null;
    const other = choices.find((c) => c.value !== currentValue);
    return String((other ?? choices[0])?.value ?? "");
  });
  const [isNa, setIsNa] = useState(false);
  const [naReason, setNaReason] = useState("");
  const [severe, setSevere] = useState(false);
  const [severeReason, setSevereReason] = useState("");
  const [explanation, setExplanation] = useState("");
  const [reviewer, setReviewer] = useState(identity.reviewerName);
  const ids = {
    value: useFieldId("value"),
    na: useFieldId("na"),
    naReason: useFieldId("nar"),
    severe: useFieldId("sev"),
    severeReason: useFieldId("sevr"),
    explanation: useFieldId("exp"),
    reviewer: useFieldId("rev"),
  };
  const value = choices.find((c) => String(c.value) === valueKey)?.value ?? null;
  const overrideValid = isNa ? naReason.trim().length > 0 : value !== null && (!severe || severeReason.trim().length > 0);
  const valid = explanation.trim().length >= 3 && reviewer.trim().length > 0 && (decision === "confirm" || overrideValid);

  async function submit() {
    const name = reviewer.trim();
    setIdentity({ reviewerName: name });
    try {
      await decide.mutateAsync(
        decision === "confirm"
          ? { decision, explanation: explanation.trim(), reviewer: name }
          : {
              decision,
              explanation: explanation.trim(),
              reviewer: name,
              override: {
                value: isNa ? null : value,
                is_na: isNa,
                na_reason: isNa ? naReason.trim() : null,
                severe_error: !isNa && severe,
                severe_error_reason: !isNa && severe ? severeReason.trim() : null,
              },
            },
      );
      toast.success(decision === "confirm" ? "Score confirmed" : "Score overridden", {
        description: decision === "override" ? "The final score was recalculated; the original result is kept." : undefined,
      });
    } catch (error) {
      toast.error("Could not save the decision", { description: errorMessage(error) });
    }
  }

  return (
    <section className="flex flex-col gap-4 border-b border-line px-4 py-4" aria-label="Decide the appeal">
      <div role="radiogroup" aria-label="Decision" className="grid gap-2 sm:grid-cols-2">
        {(["confirm", "override"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={decision === option}
            onClick={() => setDecision(option)}
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
              decision === option ? "border-accent bg-accent-soft" : "border-line-strong bg-raised hover:bg-hover",
            )}
          >
            <span className="text-dense font-medium text-ink">{option === "confirm" ? "Confirm the score" : "Override the score"}</span>
            <span className="text-2xs text-ink-3">{option === "confirm" ? "The evaluation stands as it is." : "Set the correct answer; the total is recalculated."}</span>
          </button>
        ))}
      </div>

      {decision === "override" ? (
        <div className="flex flex-col gap-3">
          {criterion.na_allowed ? (
            <label htmlFor={ids.na} className="flex items-center gap-2 text-dense text-ink-2">
              <Switch id={ids.na} checked={isNa} onCheckedChange={setIsNa} />
              Not applicable{criterion.na_rule ? ` (${criterion.na_rule})` : ""}
            </label>
          ) : null}
          {isNa ? (
            <Field label="Why N/A" htmlFor={ids.naReason}>
              <Input id={ids.naReason} value={naReason} maxLength={2000} onChange={(e) => setNaReason(e.target.value)} />
            </Field>
          ) : (
            <Field label="Correct answer" htmlFor={ids.value}>
              <Select id={ids.value} value={valueKey} onChange={(e) => setValueKey(e.target.value)}>
                {choices.map((c) => (
                  <option key={String(c.value)} value={String(c.value)}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {criterion.severe_error_enabled && !isNa ? (
            <>
              <label htmlFor={ids.severe} className="flex items-center gap-2 text-dense text-ink-2">
                <Switch id={ids.severe} checked={severe} onCheckedChange={setSevere} />
                Severe error
              </label>
              {severe ? (
                <Field label="Severe error reason" htmlFor={ids.severeReason}>
                  <Input id={ids.severeReason} value={severeReason} maxLength={2000} onChange={(e) => setSevereReason(e.target.value)} />
                </Field>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <Field label="Explanation (required)" htmlFor={ids.explanation} hint="At least 3 characters. Recorded with the decision and shown to the operator.">
        <Textarea id={ids.explanation} value={explanation} maxLength={4000} onChange={(e) => setExplanation(e.target.value)} aria-required />
      </Field>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Reviewer" htmlFor={ids.reviewer} hint="Demo name, no sign-in." className="w-56">
          <Input id={ids.reviewer} value={reviewer} maxLength={120} onChange={(e) => setReviewer(e.target.value)} />
        </Field>
        <Button variant="primary" disabled={!valid} loading={decide.isPending} onClick={submit}>
          <Gavel aria-hidden />
          {decision === "confirm" ? "Confirm score" : "Override and recalculate"}
        </Button>
      </div>
    </section>
  );
}
