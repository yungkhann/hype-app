import {
  AlertOctagon,
  AlertTriangle,
  Binary,
  Calendar,
  CheckCircle2,
  Hash,
  Info,
  Loader2,
  Tags,
  Type,
  type LucideIcon,
} from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import type { ColumnKind } from "@/lib/api/types";
import { cn } from "@/lib/utils";

/* ---------- Panel: the one container. Never nest a Panel inside a Panel. ---------- */

export function Panel({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn("min-w-0 rounded-lg border border-line bg-panel", className)} {...props} />;
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="text-dense font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-dense text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/* ---------- Notices: tone + icon + text; color never carries meaning alone ---------- */

type Tone = "info" | "warning" | "critical" | "good" | "neutral";

const TONE: Record<Tone, { icon: LucideIcon; box: string; icon_class: string }> = {
  info: { icon: Info, box: "bg-info-soft text-ink", icon_class: "text-info" },
  warning: { icon: AlertTriangle, box: "bg-warning-soft text-ink", icon_class: "text-warning" },
  critical: { icon: AlertOctagon, box: "bg-critical-soft text-ink", icon_class: "text-critical" },
  good: { icon: CheckCircle2, box: "bg-good-soft text-ink", icon_class: "text-good" },
  neutral: { icon: Info, box: "bg-raised text-ink", icon_class: "text-ink-3" },
};

export function Notice({
  tone = "info",
  title,
  children,
  className,
  action,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const { icon: Icon, box, icon_class } = TONE[tone];
  return (
    <div role={tone === "critical" ? "alert" : "status"} className={cn("flex gap-2.5 rounded-md px-3 py-2.5 text-dense", box, className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", icon_class)} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn("text-ink-2", title && "mt-0.5")}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function SeverityIcon({ severity, className }: { severity: "info" | "warning" | "critical"; className?: string }) {
  const tone = TONE[severity];
  const Icon = tone.icon;
  return <Icon className={cn("size-4 shrink-0", tone.icon_class, className)} aria-label={severity} />;
}

/* ---------- Badge ---------- */

export function Badge({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone | "accent" }) {
  const tones: Record<Tone | "accent", string> = {
    neutral: "bg-hover text-ink-2",
    info: "bg-info-soft text-info",
    warning: "bg-warning-soft text-warning",
    critical: "bg-critical-soft text-critical",
    good: "bg-good-soft text-good",
    accent: "bg-accent-soft text-accent-ink",
  };
  return (
    <span
      className={cn("inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-2xs font-medium whitespace-nowrap [&_svg]:size-3", tones[tone], className)}
      {...props}
    />
  );
}

/* ---------- Column kind ---------- */

const KIND_ICON: Record<ColumnKind, LucideIcon> = {
  numeric: Hash,
  categorical: Tags,
  boolean: Binary,
  datetime: Calendar,
  text: Type,
};

export function KindIcon({ kind, className }: { kind: ColumnKind; className?: string }) {
  const Icon = KIND_ICON[kind] ?? Type;
  return <Icon className={cn("size-3.5 shrink-0 text-ink-3", className)} aria-label={kind} />;
}

export function ColumnName({ name, kind, className }: { name: string; kind?: ColumnKind; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {kind && <KindIcon kind={kind} />}
      <span className="truncate font-mono text-[0.8em] text-ink">{name}</span>
    </span>
  );
}

/* ---------- Loading & empty ---------- */

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "rounded-md bg-[linear-gradient(90deg,var(--color-raised)_0%,var(--color-hover)_50%,var(--color-raised)_100%)] bg-[length:200%_100%] motion-safe:animate-[atlas-shimmer_1.6s_linear_infinite]",
        className,
      )}
    />
  );
}

export function Spinner({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 text-dense text-ink-2", className)}>
      <Loader2 className="size-4 animate-spin text-ink-3" aria-hidden />
      {label}
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {Icon && <Icon className="mb-3 size-6 text-ink-3" aria-hidden strokeWidth={1.75} />}
      <p className="text-sm font-medium text-ink">{title}</p>
      {children && <div className="mt-1 max-w-md text-dense text-ink-2">{children}</div>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

/* ---------- Stat: label + value + source; not a hero metric ---------- */

export function Stat({ label, value, detail }: { label: ReactNode; value: ReactNode; detail?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="mt-1 truncate text-lg font-medium tracking-[-0.01em] tabular-nums text-ink">{value}</dd>
      {detail && <dd className="truncate text-2xs text-ink-3">{detail}</dd>}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line-strong bg-raised px-1 font-sans text-2xs font-medium text-ink-3 [&_svg]:size-3">
      {children}
    </kbd>
  );
}
