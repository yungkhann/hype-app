"use client";

import { DatabaseZap, FileWarning } from "lucide-react";
import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { setActiveDataset, useActiveDatasetId } from "@/lib/active-dataset";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useDataset } from "@/lib/api/hooks";
import type { DatasetDetail } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { EmptyState, Notice, Panel, Skeleton } from "@/components/ui/surface";

export function PageHeader({
  title,
  description,
  actions,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-3xl">
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {description && <p className="mt-1 text-dense text-ink-2">{description}</p>}
        {meta && <div className="mt-2">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-4">
      <Skeleton className="h-7 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

/** Gate for pages that operate on the active dataset. */
export function WithDataset({ children, purpose }: { children: (dataset: DatasetDetail) => ReactNode; purpose: string }) {
  const id = useActiveDatasetId();
  const dataset = useDataset(id);
  const notFound = dataset.error instanceof ApiError && dataset.error.status === 404;

  useEffect(() => {
    if (notFound) setActiveDataset(null);
  }, [notFound]);

  if (id === undefined || (id && dataset.isPending)) return <PageSkeleton />;
  if (!id || notFound) {
    return (
      <Panel>
        <EmptyState
          icon={DatabaseZap}
          title="Choose a dataset first"
          action={
            <Button variant="primary" asChild>
              <Link href="/">Open datasets</Link>
            </Button>
          }
        >
          {purpose} Upload a file or load a synthetic sample on the Datasets page, then come back here.
        </EmptyState>
      </Panel>
    );
  }
  if (dataset.isError) {
    return (
      <Notice tone="critical" title="Could not load the dataset">
        {errorMessage(dataset.error)}
      </Notice>
    );
  }
  const detail = dataset.data!;
  if (detail.status !== "ready") {
    return (
      <Panel>
        <EmptyState
          icon={FileWarning}
          title={detail.status === "staged" ? "This upload is not imported yet" : "This dataset failed to import"}
          action={
            <Button variant="primary" asChild>
              <Link href="/">Go to datasets</Link>
            </Button>
          }
        >
          {detail.status === "staged"
            ? "Review the parsing preview and confirm the import on the Datasets page."
            : (detail.error ?? "Re-upload the file or check its format.")}
        </EmptyState>
      </Panel>
    );
  }
  return <>{children(detail)}</>;
}
