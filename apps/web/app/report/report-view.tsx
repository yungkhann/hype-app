"use client";

import { ArrowLeft, Printer } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { errorMessage } from "@/lib/api/client";
import { useFindings, usePitch } from "@/lib/api/hooks";
import type { Finding } from "@/lib/api/types";
import { fmtDate } from "@/lib/format";
import { ChartView } from "@/components/charts/chart-view";
import { ChartThemeProvider } from "@/components/charts/chart-theme";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/overlays";
import { Notice, Skeleton } from "@/components/ui/surface";

const SECTIONS: {
  key:
    | "description"
    | "methodology"
    | "interpretation"
    | "implication"
    | "limitations";
  label: string;
}[] = [
  { key: "description", label: "Observation" },
  { key: "methodology", label: "Methodology" },
  { key: "interpretation", label: "Interpretation" },
  { key: "implication", label: "Business implication" },
  { key: "limitations", label: "Limitations" },
];

export function ReportView() {
  const findings = useFindings();
  const pitch = usePitch();
  const [pitchOnly, setPitchOnly] = useState(false);
  const list = (findings.data ?? []).filter(
    (f) => !pitchOnly || f.include_in_pitch,
  );
  const datasets = [
    ...new Set(list.map((f) => f.dataset_name).filter(Boolean)),
  ];
  const title =
    pitch.data?.title && pitch.data.title !== "Untitled solution"
      ? pitch.data.title
      : "Findings report";

  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <div className="sticky top-0 z-10 border-b border-line bg-canvas print:hidden">
        <div className="mx-auto flex max-w-[860px] flex-wrap items-center gap-3 px-4 py-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/findings">
              <ArrowLeft /> Findings
            </Link>
          </Button>
          <label className="ml-auto flex items-center gap-2 text-dense text-ink-2">
            <Switch checked={pitchOnly} onCheckedChange={setPitchOnly} />
            Only findings marked “In pitch”
          </label>
          <Button
            variant="primary"
            size="sm"
            onClick={() => window.print()}
            disabled={!list.length}
          >
            <Printer /> Print / save as PDF
          </Button>
        </div>
      </div>
      {/* A print preview: white paper with the light chart theme, inside the dark studio chrome. */}
      <ChartThemeProvider theme="light">
        <article
          className="theme-paper mx-auto my-6 max-w-[860px] rounded-lg bg-panel px-6 py-10 sm:px-12 print:my-0 print:max-w-none print:rounded-none print:p-0"
          data-testid="report"
        >
          <header className="mb-8 border-b border-line pb-6">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">
              {title}
            </h1>
            {pitch.data?.subtitle && (
              <p className="mt-1 text-ink-2">{pitch.data.subtitle}</p>
            )}
            <p className="mt-3 text-2xs text-ink-3">
              {pitch.data?.team ? `${pitch.data.team} · ` : ""}
              {findings.data
                ? `${list.length} finding${list.length === 1 ? "" : "s"}`
                : "loading findings…"}
              {datasets.length > 0 && ` · data: ${datasets.join(", ")}`}
              {/* Only after client data arrives: a render-time clock read would be frozen into the prerender. */}
              {findings.data &&
                ` · generated ${fmtDate(new Date().toISOString(), true)}`}{" "}
              · ATLAS (local)
            </p>
          </header>
          {findings.isError ? (
            <Notice tone="critical">{errorMessage(findings.error)}</Notice>
          ) : findings.isPending ? (
            <Skeleton className="h-96" />
          ) : list.length === 0 ? (
            <p className="text-ink-2">
              No findings to report
              {pitchOnly ? " that are marked “In pitch”" : ""}.
            </p>
          ) : (
            <ol className="flex flex-col gap-10">
              {list.map((finding, index) => (
                <ReportFinding
                  key={finding.id}
                  finding={finding}
                  index={index}
                />
              ))}
            </ol>
          )}
          <footer className="mt-12 border-t border-line pt-4 text-2xs text-ink-3">
            Every chart carries a source line: dataset, rows used of total,
            filters, sampling, and aggregation. Interpretations are written by
            the team.
          </footer>
        </article>
      </ChartThemeProvider>
    </div>
  );
}

function ReportFinding({
  finding,
  index,
}: {
  finding: Finding;
  index: number;
}) {
  return (
    <li className="break-inside-avoid-page">
      <h2 className="text-lg font-semibold text-ink">
        <span className="mr-2 text-ink-3 tabular-nums">{index + 1}.</span>
        {finding.title}
      </h2>
      <p className="mb-3 text-2xs text-ink-3">
        {finding.dataset_name ?? "No dataset"} · saved{" "}
        {fmtDate(finding.created_at, true)}
      </p>
      {finding.chart && (
        <div className="mb-4">
          <ChartView
            data={finding.chart}
            height={260}
            toolbar={false}
            showTitle={false}
          />
        </div>
      )}
      {finding.evidence.length > 0 && (
        <table className="mb-4 w-full text-dense">
          <tbody>
            {finding.evidence.map((e, i) => (
              <tr key={i} className="border-b border-line">
                <td className="py-1 pr-4 text-ink-2">{e.label}</td>
                <td className="py-1 text-right font-medium text-ink tabular-nums">
                  {e.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <dl className="flex flex-col gap-2">
        {SECTIONS.filter((s) => finding[s.key].trim()).map((s) => (
          <div key={s.key}>
            <dt className="text-2xs font-medium text-ink-2">{s.label}</dt>
            <dd className="text-dense whitespace-pre-line text-ink">
              {finding[s.key]}
            </dd>
          </div>
        ))}
      </dl>
      {!finding.interpretation.trim() && (
        <p className="mt-2 text-2xs text-ink-3 italic">
          No interpretation recorded.
        </p>
      )}
    </li>
  );
}
