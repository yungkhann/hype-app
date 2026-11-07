"use client";

import { Check, ChevronsUpDown, Database, FolderOpen } from "lucide-react";
import Link from "next/link";
import { setActiveDataset, useActiveDatasetId } from "@/lib/active-dataset";
import { useDatasets } from "@/lib/api/hooks";
import { fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { Badge } from "@/components/ui/surface";

export function DatasetSwitcher() {
  const activeId = useActiveDatasetId();
  const datasets = useDatasets();
  const ready = (datasets.data ?? []).filter((d) => d.status === "ready");
  const active = datasets.data?.find((d) => d.id === activeId);

  return (
    <Menu>
      <MenuTrigger
        className="flex h-8 max-w-[min(64vw,28rem)] min-w-0 items-center gap-2 rounded-md border border-line-strong bg-raised pr-2 pl-2.5 text-dense transition-colors duration-100 hover:border-control/70 hover:bg-hover"
        aria-label="Switch active dataset"
        data-testid="dataset-switcher"
      >
        <Database className="size-4 shrink-0 text-ink-3" aria-hidden />
        {active ? (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate font-medium text-ink">{active.name}</span>
            <span className="hidden shrink-0 text-2xs text-ink-3 tabular-nums sm:inline">
              {fmtNumber(active.n_rows)} × {fmtNumber(active.n_cols)}
            </span>
          </span>
        ) : (
          <span className="truncate text-ink-2">{activeId === undefined ? "Loading…" : "No dataset selected"}</span>
        )}
        <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      </MenuTrigger>
      <MenuContent align="start" className="w-80">
        <MenuLabel>Active dataset</MenuLabel>
        {ready.length === 0 && <p className="px-2 py-2 text-dense text-ink-2">No imported datasets yet.</p>}
        <div className="max-h-80 overflow-y-auto">
          {ready.map((dataset) => (
            <MenuItem key={dataset.id} onSelect={() => setActiveDataset(dataset.id)} className="items-start">
              <Check className={cn("mt-0.5", dataset.id === activeId ? "opacity-100 !text-accent" : "opacity-0")} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{dataset.name}</span>
                <span className="block text-2xs text-ink-3 tabular-nums">
                  {fmtNumber(dataset.n_rows)} rows · {fmtNumber(dataset.n_cols)} columns · {dataset.format}
                </span>
              </span>
              {dataset.source === "transform" && <Badge>derived</Badge>}
              {dataset.is_synthetic && <Badge>synthetic</Badge>}
            </MenuItem>
          ))}
        </div>
        <MenuSeparator />
        <MenuItem asChild>
          <Link href="/">
            <FolderOpen aria-hidden /> Manage datasets
          </Link>
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
