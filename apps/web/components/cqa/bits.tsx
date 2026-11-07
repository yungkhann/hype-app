"use client";

/**
 * Small CQA display pieces. Status is always icon + word + colour (DESIGN.md); scores are tabular numbers
 * formatted from what the backend scoring engine returned, never recomputed here.
 */
import {
  AlertOctagon,
  Ban,
  Bot,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  Clock3,
  Cog,
  FlaskConical,
  Gavel,
  Headset,
  Loader2,
  MessageSquareText,
  MinusCircle,
  PhoneCall,
  Pencil,
  UserRound,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Tip } from "@/components/ui/overlays";
import { Badge } from "@/components/ui/surface";
import {
  OUTCOME_LABEL,
  ORIGIN_LABEL,
  SPEAKER_LABEL,
  STATUS_LABEL,
  fmtScore,
  languageName,
  outcomeOf,
  type Outcome,
} from "@/lib/cqa/format";
import type { AppealStatus, Channel, ChecklistOrigin, CriterionScore, EvaluationStatus, Speaker } from "@/lib/cqa/types";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "info" | "warning" | "critical" | "good" | "accent";

export const SPEAKER_ICON: Record<Speaker, LucideIcon> = {
  client: UserRound,
  operator: Headset,
  bot: Bot,
  system: Cog,
  unknown: CircleHelp,
};

export function SpeakerLabel({ speaker, raw, className }: { speaker: Speaker; raw?: string; className?: string }) {
  const Icon = SPEAKER_ICON[speaker];
  const label = SPEAKER_LABEL[speaker];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-dense font-medium", speaker === "operator" ? "text-ink" : "text-ink-2", className)}>
      <Icon className={cn("size-3.5 shrink-0", speaker === "operator" ? "text-accent-ink" : "text-ink-3")} aria-hidden />
      {label}
      {speaker === "unknown" && raw ? <span className="font-normal text-ink-3">({raw})</span> : null}
    </span>
  );
}

export function ChannelLabel({ channel, className }: { channel: Channel | string; className?: string }) {
  const voice = channel === "voice";
  const Icon = voice ? PhoneCall : MessageSquareText;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-ink-2", className)}>
      <Icon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      {voice ? "Call" : "Chat"}
    </span>
  );
}

export function LanguageTag({ code }: { code: string }) {
  return (
    <Tip content={languageName(code)}>
      <Badge tone="neutral" className="font-mono tracking-wide" aria-label={languageName(code)}>
        {code}
      </Badge>
    </Tip>
  );
}

const STATUS: Record<EvaluationStatus, { icon: LucideIcon; tone: Tone; spin?: boolean }> = {
  pending: { icon: Clock3, tone: "neutral" },
  running: { icon: Loader2, tone: "info", spin: true },
  completed: { icon: CheckCircle2, tone: "good" },
  failed: { icon: AlertOctagon, tone: "critical" },
};

export function EvalStatusBadge({ status }: { status: EvaluationStatus }) {
  const meta = STATUS[status];
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone}>
      <Icon className={cn(meta.spin && "animate-spin")} aria-hidden />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export function NotEvaluatedBadge() {
  return (
    <Badge tone="neutral">
      <CircleDashed aria-hidden />
      Not evaluated
    </Badge>
  );
}

/** The development mock evaluator is never presented as AI: every place it appears says so. */
export function MockBadge({ className }: { className?: string }) {
  return (
    <Tip content="Produced by the deterministic development mock. It demonstrates the workflow; it is not an AI assessment.">
      <Badge tone="warning" className={className}>
        <FlaskConical aria-hidden />
        Dev mock · not AI
      </Badge>
    </Tip>
  );
}

export function FixtureBadge() {
  return (
    <Tip content="Synthetic development fixture written for testing. Not organizer data.">
      <Badge tone="neutral">
        <FlaskConical aria-hidden />
        Fixture
      </Badge>
    </Tip>
  );
}

export function OriginBadge({ origin }: { origin: ChecklistOrigin }) {
  const tone: Tone = origin === "official" ? "accent" : origin === "dev_sample" ? "warning" : "neutral";
  return <Badge tone={tone}>{ORIGIN_LABEL[origin]}</Badge>;
}

const OUTCOME: Record<Outcome, { icon: LucideIcon; tone: Tone }> = {
  met: { icon: CheckCircle2, tone: "good" },
  partial: { icon: MinusCircle, tone: "warning" },
  missed: { icon: XCircle, tone: "critical" },
  na: { icon: Ban, tone: "neutral" },
  invalid: { icon: AlertOctagon, tone: "critical" },
  missing: { icon: CircleDashed, tone: "neutral" },
};

export function OutcomeBadge({ score }: { score: Pick<CriterionScore, "status" | "normalized"> | null | undefined }) {
  const outcome = outcomeOf(score);
  const meta = OUTCOME[outcome];
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone}>
      <Icon aria-hidden />
      {OUTCOME_LABEL[outcome]}
    </Badge>
  );
}

export function SevereBadge({ reason }: { reason?: string | null }) {
  const badge = (
    <Badge tone="critical">
      <AlertOctagon aria-hidden />
      Severe error
    </Badge>
  );
  return reason ? <Tip content={reason}>{badge}</Tip> : badge;
}

export function OverriddenBadge() {
  return (
    <Badge tone="info">
      <Pencil aria-hidden />
      Reviewer override
    </Badge>
  );
}

const APPEAL: Record<AppealStatus, { icon: LucideIcon; tone: Tone; label: string }> = {
  pending: { icon: Gavel, tone: "warning", label: "Appeal pending" },
  confirmed: { icon: CheckCircle2, tone: "neutral", label: "Appeal: score confirmed" },
  overridden: { icon: Pencil, tone: "info", label: "Appeal: score overridden" },
};

export function AppealBadge({ status, short }: { status: AppealStatus; short?: boolean }) {
  const meta = APPEAL[status];
  const Icon = meta.icon;
  const label = short ? { pending: "Pending", confirmed: "Confirmed", overridden: "Overridden" }[status] : meta.label;
  return (
    <Badge tone={meta.tone}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}

/** "84.5 / 100". The denominator is quieter: the score is the data. */
export function Score({
  value,
  max,
  className,
  size = "md",
}: {
  value: number | null | undefined;
  max?: number | null;
  className?: string;
  size?: "md" | "lg";
}) {
  return (
    <span className={cn("tabular-nums", className)}>
      <span className={cn("font-medium text-ink", size === "lg" && "text-2xl font-semibold tracking-[-0.02em]")}>{fmtScore(value)}</span>
      {max !== undefined && max !== null && value !== null && value !== undefined ? (
        <span className={cn("text-ink-3", size === "lg" ? "text-sm" : "text-xs")}> / {fmtScore(max)}</span>
      ) : null}
    </span>
  );
}

/** Original → final, shown only when a reviewer changed the score. */
export function ScoreChange({ original, final, max }: { original: number | null | undefined; final: number | null | undefined; max?: number | null }) {
  if (original === final || original === null || original === undefined) return <Score value={final} max={max} />;
  return (
    <span className="inline-flex items-baseline gap-1.5 tabular-nums">
      <Score value={final} max={max} />
      <Tip content="Original score before reviewer overrides">
        <span className="text-xs text-ink-3 line-through decoration-ink-3/60">{fmtScore(original)}</span>
      </Tip>
    </span>
  );
}

/** A thin bar for a 0–1 share: chart series colour, never the accent or a status colour. */
export function ShareBar({ value, className, label }: { value: number | null | undefined; className?: string; label?: string }) {
  const pct = value === null || value === undefined ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-hover", className)}
      role="img"
      aria-label={label ?? `${Math.round(pct)}%`}
    >
      <div className="h-full rounded-full bg-series-1" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Label/value rows for metadata: a definition list, not a card. */
export function Meta({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-dense", className)}>
      {items.map(([label, value], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{label}</dt>
          <dd className="min-w-0 text-ink-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[0.92em] text-ink-2", className)}>{children}</span>;
}
