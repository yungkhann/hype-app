"use client";

import {
  ArrowRight,
  Download,
  FileSpreadsheet,
  FlaskConical,
  GitBranch,
  MoreHorizontal,
  Pencil,
  RefreshCcw,
  Table2,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { setActiveDataset, useActiveDatasetId } from "@/lib/active-dataset";
import { API_BASE, api, errorMessage } from "@/lib/api/client";
import { useHydrated } from "@/lib/hooks";
import { useDatasets, useDeleteDataset, useLoadSample, useRenameDataset, useSamples } from "@/lib/api/hooks";
import type { DatasetSummary, StagedPreview } from "@/lib/api/types";
import { fmtBytes, fmtNumber, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ImportDialog, UploadDropzone } from "@/components/datasets/upload";
import { PageHeader } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { Badge, EmptyState, Notice, Panel, PanelHeader, Skeleton } from "@/components/ui/surface";

export function HomeView() {
  const datasets = useDatasets();
  const hydrated = useHydrated();
  const [staged, setStaged] = useState<StagedPreview | null>(null);
  const [replacing, setReplacing] = useState<DatasetSummary | null>(null);
  const list = (hydrated && datasets.data) || [];
  const pending = !hydrated || datasets.isPending;

  async function review(dataset: DatasetSummary) {
    try {
      setStaged(await api<StagedPreview>(`/datasets/${dataset.id}/stage-preview`, { body: {} }));
    } catch (error) {
      toast.error("Could not reopen the import", { description: errorMessage(error) });
    }
  }

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Datasets"
        description="Upload a file or load a synthetic sample. Everything stays on this machine: originals are kept byte-for-byte, and every preparation step creates a new derived dataset."
      />
      {hydrated && datasets.isError && (
        <Notice tone="critical" title="The API is not reachable" className="mb-4">
          {errorMessage(datasets.error)}
        </Notice>
      )}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel>
          <PanelHeader
            title="Workspace"
            description={hydrated && datasets.isSuccess ? `${list.length} ${list.length === 1 ? "dataset" : "datasets"}` : undefined}
          />
          {pending ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : list.length === 0 ? (
            <EmptyState icon={FileSpreadsheet} title="No datasets yet">
              Drop the case file on the right, or load a synthetic sample to rehearse the workflow.
            </EmptyState>
          ) : (
            <DatasetList datasets={list} onReview={review} onReplace={setReplacing} />
          )}
        </Panel>
        <div className="flex flex-col gap-4">
          <Panel>
            <PanelHeader title="Upload" />
            <div className="p-4">
              <UploadDropzone onStaged={setStaged} />
            </div>
          </Panel>
          <SamplesPanel />
        </div>
      </div>
      <ImportDialog staged={staged} onClose={() => setStaged(null)} />
      <Dialog open={Boolean(replacing)} onOpenChange={(open) => !open && setReplacing(null)}>
        {replacing && (
          <DialogContent title={`Replace “${replacing.name}”`} description="Swap in a corrected file under the same dataset id. The current version stays until you confirm the new import.">
            <UploadDropzone
              replaceId={replacing.id}
              compact
              onStaged={(preview) => {
                setReplacing(null);
                setStaged(preview);
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function StatusBadge({ dataset }: { dataset: DatasetSummary }) {
  if (dataset.replacing) return <Badge tone="warning">replacement pending</Badge>;
  if (dataset.status === "staged") return <Badge tone="warning">not imported</Badge>;
  if (dataset.status === "failed") return <Badge tone="critical">import failed</Badge>;
  return null;
}

function DatasetList({
  datasets,
  onReview,
  onReplace,
}: {
  datasets: DatasetSummary[];
  onReview: (dataset: DatasetSummary) => void;
  onReplace: (dataset: DatasetSummary) => void;
}) {
  const router = useRouter();
  const activeId = useActiveDatasetId();
  const [renaming, setRenaming] = useState<DatasetSummary | null>(null);
  const [deleting, setDeleting] = useState<DatasetSummary | null>(null);

  function open(dataset: DatasetSummary, path = "/overview") {
    if (dataset.status !== "ready") {
      onReview(dataset);
      return;
    }
    setActiveDataset(dataset.id);
    router.push(path);
  }

  return (
    <>
      <ul className="divide-y divide-line" data-testid="dataset-list">
        {datasets.map((dataset) => {
          const active = dataset.id === activeId;
          return (
            <li key={dataset.id} className={cn("flex items-center gap-3 px-4 py-3", active && "bg-accent-soft/50")}>
              <button type="button" onClick={() => open(dataset)} className="group flex min-w-0 flex-1 flex-col items-start text-left">
                <span className="flex max-w-full flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-ink group-hover:underline">{dataset.name}</span>
                  {active && <Badge tone="accent">active</Badge>}
                  {dataset.is_synthetic && <Badge>synthetic</Badge>}
                  {dataset.source === "transform" && (
                    <Badge>
                      <GitBranch aria-hidden /> derived
                    </Badge>
                  )}
                  <StatusBadge dataset={dataset} />
                </span>
                <span className="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-ink-3 tabular-nums">
                  {dataset.status === "ready" ? (
                    <span>
                      {fmtNumber(dataset.n_rows)} rows × {fmtNumber(dataset.n_cols)} columns
                    </span>
                  ) : (
                    <span>{dataset.error ?? "Review the parsing preview to import"}</span>
                  )}
                  <span>· {dataset.format.toUpperCase()}</span>
                  {dataset.original && <span>· {fmtBytes(dataset.original.size_bytes)}</span>}
                  {dataset.lineage && <span>· from {dataset.lineage.parent_name}</span>}
                  <span>· updated {fmtRelative(dataset.updated_at)}</span>
                </span>
              </button>
              {dataset.status === "ready" ? (
                <Button size="sm" variant="ghost" onClick={() => open(dataset)} className="hidden sm:inline-flex">
                  Open <ArrowRight />
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => onReview(dataset)}>
                  Review import
                </Button>
              )}
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${dataset.name}`}>
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent className="w-56">
                  {dataset.status === "ready" && (
                    <>
                      <MenuItem onSelect={() => open(dataset, "/explorer")}>
                        <Table2 aria-hidden /> Explore rows
                      </MenuItem>
                      <MenuItem onSelect={() => open(dataset, "/analysis")}>
                        <FlaskConical aria-hidden /> Analyze
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem asChild>
                        <a href={`${API_BASE}/datasets/${dataset.id}/download?format=csv`}>
                          <Download aria-hidden /> Download CSV
                        </a>
                      </MenuItem>
                      <MenuItem asChild>
                        <a href={`${API_BASE}/datasets/${dataset.id}/download?format=parquet`}>
                          <Download aria-hidden /> Download Parquet
                        </a>
                      </MenuItem>
                    </>
                  )}
                  {dataset.original && (
                    <MenuItem asChild>
                      <a href={`${API_BASE}/datasets/${dataset.id}/download?format=original`}>
                        <Download aria-hidden /> Download original file
                      </a>
                    </MenuItem>
                  )}
                  <MenuSeparator />
                  <MenuItem onSelect={() => setRenaming(dataset)}>
                    <Pencil aria-hidden /> Rename
                  </MenuItem>
                  {dataset.source !== "transform" && (
                    <MenuItem onSelect={() => onReplace(dataset)}>
                      <RefreshCcw aria-hidden /> Replace file…
                    </MenuItem>
                  )}
                  <MenuItem danger onSelect={() => setDeleting(dataset)}>
                    <Trash2 aria-hidden /> Delete…
                  </MenuItem>
                </MenuContent>
              </Menu>
            </li>
          );
        })}
      </ul>
      <RenameDialog dataset={renaming} onClose={() => setRenaming(null)} />
      <DeleteDialog dataset={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}

function RenameDialog({ dataset, onClose }: { dataset: DatasetSummary | null; onClose: () => void }) {
  const rename = useRenameDataset();
  const [name, setName] = useState("");
  return (
    <Dialog
      open={Boolean(dataset)}
      onOpenChange={(open) => {
        if (open && dataset) setName(dataset.name);
        if (!open) onClose();
      }}
    >
      {dataset && (
        <DialogContent
          title="Rename dataset"
          onOpenAutoFocus={() => setName(dataset.name)}
          footer={
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={rename.isPending}
                disabled={!name.trim()}
                onClick={async () => {
                  try {
                    await rename.mutateAsync({ id: dataset.id, name: name.trim() });
                    onClose();
                  } catch (error) {
                    toast.error(errorMessage(error));
                  }
                }}
              >
                Save
              </Button>
            </>
          }
        >
          <Field label="Name" htmlFor="rename-input">
            <Input id="rename-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoFocus />
          </Field>
        </DialogContent>
      )}
    </Dialog>
  );
}

function DeleteDialog({ dataset, onClose }: { dataset: DatasetSummary | null; onClose: () => void }) {
  const remove = useDeleteDataset();
  const activeId = useActiveDatasetId();
  return (
    <Dialog open={Boolean(dataset)} onOpenChange={(open) => !open && onClose()}>
      {dataset && (
        <DialogContent
          title={`Delete “${dataset.name}”?`}
          description="This removes the stored original, the processed data, and its profile from this workspace. Findings keep their chart snapshots. This cannot be undone."
          footer={
            <>
              <Button variant="ghost" onClick={onClose}>
                Keep dataset
              </Button>
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={async () => {
                  try {
                    await remove.mutateAsync(dataset.id);
                    if (dataset.id === activeId) setActiveDataset(null);
                    toast(`Deleted ${dataset.name}`);
                    onClose();
                  } catch (error) {
                    toast.error(errorMessage(error));
                  }
                }}
              >
                <Trash2 /> Delete dataset
              </Button>
            </>
          }
        >
          <p className="text-dense text-ink-2">
            {dataset.status === "ready" ? `${fmtNumber(dataset.n_rows)} rows × ${fmtNumber(dataset.n_cols)} columns` : "Not imported"}
            {dataset.original ? ` · original ${dataset.original.filename}` : ""}
          </p>
        </DialogContent>
      )}
    </Dialog>
  );
}

function SamplesPanel() {
  const samples = useSamples();
  const load = useLoadSample();
  const router = useRouter();
  const [loadingName, setLoadingName] = useState<string | null>(null);
  return (
    <Panel>
      <PanelHeader title="Synthetic samples" description="Generated locally for rehearsal. Not real customer data." />
      {samples.isPending ? (
        <div className="p-4">
          <Skeleton className="h-24" />
        </div>
      ) : samples.isError ? (
        <p className="p-4 text-dense text-ink-2">Samples are unavailable. Run “pnpm samples”.</p>
      ) : (samples.data ?? []).length === 0 ? (
        <p className="p-4 text-dense text-ink-2">No samples found. Run “pnpm samples” to generate them.</p>
      ) : (
        <ul className="divide-y divide-line">
          {samples.data!.map((sample) => (
            <li key={sample.filename} className="flex items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-dense font-medium text-ink">{sample.name}</p>
                <p className="mt-0.5 text-2xs text-ink-2">{sample.description}</p>
                <p className="mt-0.5 font-mono text-2xs text-ink-3">
                  {sample.filename} · {fmtBytes(sample.size_bytes)}
                </p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                loading={loadingName === sample.filename}
                disabled={Boolean(loadingName)}
                onClick={async () => {
                  setLoadingName(sample.filename);
                  try {
                    const detail = await load.mutateAsync(sample.filename);
                    setActiveDataset(detail.id);
                    toast.success(`Loaded ${detail.name}`, { description: `${fmtNumber(detail.n_rows)} rows × ${fmtNumber(detail.n_cols)} columns` });
                    router.push("/overview");
                  } catch (error) {
                    toast.error("Could not load the sample", { description: errorMessage(error) });
                  } finally {
                    setLoadingName(null);
                  }
                }}
              >
                Load
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line px-4 py-2.5 text-2xs text-ink-3">
        Need the workflow? See the{" "}
        <Link href="/challenge" className="text-accent-ink underline">
          case-reveal checklist
        </Link>
        .
      </p>
    </Panel>
  );
}
