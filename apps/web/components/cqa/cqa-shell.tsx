"use client";

import { ClipboardCheck, FlaskConical, Gavel, Headphones, LayoutDashboard, ListChecks, MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";
import { ApiStatus, AppShell, type NavGroup } from "@/components/shell/app-shell";
import { Tip } from "@/components/ui/overlays";
import { useAppeals, useCqaInfo } from "@/lib/cqa/api";
import { useDemoIdentity } from "@/lib/cqa/role";
import { cn } from "@/lib/utils";

/** CQA navigation only: the ATLAS studio pages are deliberately not listed here. */
const NAV: NavGroup[] = [
  {
    label: "Quality",
    items: [
      { href: "/cqa", label: "Overview", icon: LayoutDashboard, exact: true },
      { href: "/cqa/conversations", label: "Conversations", icon: MessagesSquare },
      { href: "/cqa/evaluations", label: "Evaluations", icon: ClipboardCheck },
    ],
  },
  {
    label: "Configure & review",
    items: [
      { href: "/cqa/checklists", label: "Checklists", icon: ListChecks },
      { href: "/cqa/appeals", label: "Appeals", icon: Gavel },
    ],
  },
];

/** Operator / Reviewer demo switch. There is no sign-in; it only changes which actions are offered. */
export function RoleSwitch() {
  const [identity, setIdentity] = useDemoIdentity();
  const pending = useAppeals({ status: "pending" });
  const count = pending.data?.length ?? 0;
  return (
    <Tip content="Demo roles without sign-in: operators submit appeals, reviewers decide them.">
      <div role="group" aria-label="Demo role" className="flex h-8 items-center rounded-md border border-line-strong bg-raised p-0.5 text-dense">
        {(["operator", "reviewer"] as const).map((role) => (
          <button
            key={role}
            type="button"
            aria-pressed={identity.role === role}
            onClick={() => setIdentity({ role })}
            className={cn(
              "inline-flex h-full items-center gap-1.5 rounded-[5px] px-2.5 font-medium text-ink-3 transition-colors hover:text-ink",
              identity.role === role && "bg-hover text-ink",
            )}
          >
            {role === "operator" ? "Operator" : "Reviewer"}
            {role === "reviewer" && count > 0 ? (
              <span className="rounded-sm bg-warning-soft px-1 text-2xs text-warning tabular-nums" aria-label={`${count} pending appeals`}>
                {count}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </Tip>
  );
}

function EvaluatorStatus() {
  const info = useCqaInfo();
  const evaluator = info.data?.evaluators.find((e) => e.name === info.data?.default_evaluator);
  if (!evaluator) return null;
  return (
    <div className="border-t border-line px-4 py-3 text-xs text-ink-3">
      <p className="flex items-center gap-2">
        {evaluator.is_mock ? <FlaskConical className="size-3.5 text-warning" aria-hidden /> : <span aria-hidden className="size-1.5 rounded-full bg-good" />}
        <span className={cn(evaluator.is_mock && "text-warning")}>{evaluator.is_mock ? "Evaluator: dev mock (not AI)" : `Evaluator: ${evaluator.label}`}</span>
      </p>
      <p className="mt-0.5 pl-5">Contract {info.data?.contract_version}</p>
    </div>
  );
}

export function CqaShell({ children }: { children: ReactNode }) {
  return (
    <AppShell
      nav={NAV}
      brand={{ name: "ATLAS", sub: "Quality", href: "/cqa", icon: Headphones }}
      headerRight={<RoleSwitch />}
      datasetCommands={false}
      footer={
        <>
          <EvaluatorStatus />
          <ApiStatus />
        </>
      }
    >
      {children}
    </AppShell>
  );
}
