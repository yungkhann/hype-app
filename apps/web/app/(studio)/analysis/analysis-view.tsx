"use client";

import { FlaskConical } from "lucide-react";
import { useState } from "react";
import { useAnalyses } from "@/lib/api/hooks";
import type { DatasetDetail, Filter } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { AnalysisRunner } from "@/components/analysis/analysis-runner";
import { FilterBar } from "@/components/data/filter-bar";
import { PageHeader, WithDataset } from "@/components/shell/page";
import { EmptyState, Notice, Panel, Skeleton } from "@/components/ui/surface";

const CATEGORY_LABEL: Record<string, string> = { builtin: "Built-in", challenge: "Challenge", custom: "Custom" };

export function AnalysisView() {
  return (
    <WithDataset purpose="Analyses run on the active dataset.">
      {(dataset) => <AnalysisLab key={dataset.id} dataset={dataset} />}
    </WithDataset>
  );
}

function AnalysisLab({ dataset }: { dataset: DatasetDetail }) {
  const analyses = useAnalyses();
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const list = analyses.data ?? [];
  const current = list.find((a) => a.id === selected) ?? list[0];
  const categories = [...new Set(list.map((a) => a.category))];

  return (
    <div className="mx-auto max-w-[1500px]">
      <PageHeader
        title="Analysis Lab"
        description="Registered, parameterised analyses. Each returns its numbers, a chart, and the rows it used — add new ones in the backend registry without touching the UI."
      />
      <Panel className="mb-4 px-3 py-2">
        <FilterBar columns={dataset.columns} filters={filters} onChange={setFilters} />
      </Panel>
      {analyses.isError ? (
        <Notice tone="critical">The analysis registry could not be loaded.</Notice>
      ) : analyses.isPending ? (
        <Skeleton className="h-96" />
      ) : !current ? (
        <Panel>
          <EmptyState icon={FlaskConical} title="No analyses registered" />
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <nav aria-label="Analyses" className="flex flex-col gap-4">
            {categories.map((category) => (
              <div key={category}>
                <p className="mb-1 px-2 text-2xs font-medium text-ink-3">{CATEGORY_LABEL[category] ?? category}</p>
                <ul className="flex flex-col">
                  {list
                    .filter((a) => a.category === category)
                    .map((analysis) => (
                      <li key={analysis.id}>
                        <button
                          type="button"
                          onClick={() => setSelected(analysis.id)}
                          aria-current={analysis.id === current.id ? "true" : undefined}
                          className={cn(
                            "w-full rounded-md px-2 py-1.5 text-left text-dense transition-colors",
                            analysis.id === current.id ? "bg-accent-soft font-medium text-accent-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
                          )}
                        >
                          {analysis.title}
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </nav>
          <AnalysisRunner key={current.id} dataset={dataset} analysis={current} filters={filters} />
        </div>
      )}
    </div>
  );
}
