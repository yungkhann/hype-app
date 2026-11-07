"use client";

import { FileUp, UploadCloud } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { setActiveDataset } from "@/lib/active-dataset";
import { api, errorMessage, uploadFile } from "@/lib/api/client";
import { useDeleteDataset, useHealth, useInvalidateDatasets } from "@/lib/api/hooks";
import { useHydrated } from "@/lib/hooks";
import type { DatasetDetail, IngestOptions, StagedPreview } from "@/lib/api/types";
import { fmtBytes, fmtCell, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Field, Input, NumberInput, Select } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/overlays";
import { Badge, Notice, Spinner } from "@/components/ui/surface";

const DEFAULT_FORMATS = [".csv", ".tsv", ".txt", ".xlsx", ".xlsm", ".parquet"];

/** Client-side checks mirror the server's; the server stays the authority. */
export function precheckFile(file: { name: string; size: number }, accepted: string[], maxMb: number): string | null {
  const dot = file.name.lastIndexOf(".");
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!accepted.includes(extension)) return `“${file.name}” is not a supported file. Use ${accepted.join(", ")}.`;
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (file.size > maxMb * 1024 * 1024) return `“${file.name}” is ${fmtBytes(file.size)}; the limit is ${maxMb} MB.`;
  return null;
}

/** Drag-and-drop upload. Hands the staged preview to the import dialog. */
export function UploadDropzone({ onStaged, replaceId, compact }: { onStaged: (staged: StagedPreview) => void; replaceId?: string; compact?: boolean }) {
  const health = useHealth();
  const hydrated = useHydrated();
  // Server and hydration render the defaults; the API's list (shared cache, maybe already loaded) applies after.
  const accepted = (hydrated && health.data?.accepted_formats) || DEFAULT_FORMATS;
  const maxMb = (hydrated && health.data?.limits.max_upload_mb) || 500;
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ name: string; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const send = useCallback(
    async (file: File) => {
      setError(null);
      const problem = precheckFile(file, accepted, maxMb);
      if (problem) {
        setError(problem);
        return;
      }
      abort.current = new AbortController();
      setProgress({ name: file.name, fraction: 0 });
      try {
        const staged = await uploadFile<StagedPreview>(
          replaceId ? `/datasets/${replaceId}/replace` : "/datasets",
          file,
          {},
          (fraction) => setProgress({ name: file.name, fraction }),
          abort.current.signal,
        );
        onStaged(staged);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setProgress(null);
        abort.current = null;
      }
    },
    [accepted, maxMb, onStaged, replaceId],
  );

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload a CSV, Excel, or Parquet file"
        aria-describedby="upload-help"
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            input.current?.click();
          }
        }}
        onClick={() => !progress && input.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void send(file);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-control/70 bg-panel text-center transition-colors hover:border-accent hover:bg-accent-soft/40",
          compact ? "px-4 py-5" : "px-6 py-10",
          dragging && "border-accent bg-accent-soft/60",
          progress && "cursor-progress",
        )}
        data-testid="upload-dropzone"
      >
        {progress ? (
          <div className="w-full max-w-sm" aria-live="polite">
            <p className="truncate text-dense font-medium text-ink">Uploading {progress.name}</p>
            <div
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-line-strong"
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress.fraction * 100)}
            >
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(4, progress.fraction * 100)}%` }} />
            </div>
            <div className="mt-2 flex items-center justify-between text-2xs text-ink-3">
              <span className="tabular-nums">{progress.fraction >= 1 ? "Detecting format…" : `${Math.round(progress.fraction * 100)}%`}</span>
              <button
                type="button"
                className="text-ink-2 underline"
                onClick={(event) => {
                  event.stopPropagation();
                  abort.current?.abort();
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <UploadCloud className="mb-2 size-6 text-ink-3" aria-hidden strokeWidth={1.75} />
            <p className="text-sm font-medium text-ink">{replaceId ? "Drop the replacement file" : "Drop a file or click to browse"}</p>
            <p id="upload-help" className="mt-1 text-2xs text-ink-3">
              CSV, Excel, or Parquet · up to {maxMb} MB · stays on this machine
            </p>
          </>
        )}
        <input
          ref={input}
          type="file"
          hidden
          accept={accepted.join(",")}
          data-testid="upload-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void send(file);
          }}
        />
      </div>
      {error && (
        <Notice tone="critical" className="mt-2">
          {error}
        </Notice>
      )}
    </div>
  );
}

const DELIMITERS: [string, string][] = [
  [",", "Comma ,"],
  [";", "Semicolon ;"],
  ["\t", "Tab"],
  ["|", "Pipe |"],
];
const ENCODINGS = ["utf-8", "utf-8-sig", "cp1251", "koi8-r", "utf-16", "latin-1", "cp1252"];

/** Review how the file was read before anything is imported. */
export function ImportDialog({ staged, onClose }: { staged: StagedPreview | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(staged)} onOpenChange={(open) => !open && onClose()}>
      {staged && <ImportDialogBody key={staged.dataset.id + staged.dataset.updated_at} initial={staged} onClose={onClose} />}
    </Dialog>
  );
}

function ImportDialogBody({ initial, onClose }: { initial: StagedPreview; onClose: () => void }) {
  const router = useRouter();
  const invalidate = useInvalidateDatasets();
  const discard = useDeleteDataset();
  const detected = initial.dataset.detected;
  const [preview, setPreview] = useState(initial);
  const [options, setOptions] = useState<IngestOptions>({
    sheet: detected?.sheets?.[0] ?? null,
    delimiter: detected?.delimiter ?? null,
    encoding: detected?.encoding ?? null,
    header_row: 0,
    decimal: ".",
  });
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(initial.dataset.name);
  const isReplace = Boolean(initial.dataset.replacing);
  const format = detected?.format ?? initial.dataset.format;
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        setPreview(await api<StagedPreview>(`/datasets/${initial.dataset.id}/stage-preview`, { body: options, signal: controller.signal }));
      } catch (cause) {
        if ((cause as Error).name !== "AbortError") setError(errorMessage(cause));
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [options, initial.dataset.id]);

  async function runImport() {
    setImporting(true);
    setError(null);
    try {
      if (name.trim() && name.trim() !== initial.dataset.name) {
        await api(`/datasets/${initial.dataset.id}`, { method: "PATCH", body: { name: name.trim() } });
      }
      const detail = await api<DatasetDetail>(`/datasets/${initial.dataset.id}/import`, { body: options });
      invalidate(detail.id);
      setActiveDataset(detail.id);
      toast.success(`Imported ${detail.name}`, { description: `${fmtNumber(detail.n_rows)} rows × ${fmtNumber(detail.n_cols)} columns` });
      for (const note of detail.notes ?? []) toast.info(note);
      onClose();
      router.push("/overview");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setImporting(false);
    }
  }

  async function discardUpload() {
    try {
      if (isReplace) {
        // Restore the previous version exactly; the replacement file is dropped.
        await api(`/datasets/${initial.dataset.id}/replace/cancel`, { method: "POST" });
        invalidate(initial.dataset.id);
        toast("Replacement cancelled", { description: "The previous version is unchanged." });
      } else {
        await discard.mutateAsync(initial.dataset.id);
      }
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
    onClose();
  }

  const set = <K extends keyof IngestOptions>(key: K, value: IngestOptions[K]) => setOptions((o) => ({ ...o, [key]: value }));
  const original = initial.dataset.original;

  return (
    <DialogContent
      title={isReplace ? "Review the replacement file" : "Review import"}
      description={
        isReplace
          ? "The current version stays intact until you confirm; cancelling restores it exactly."
          : "Nothing is imported until you confirm. The original file is stored unchanged."
      }
      className="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" onClick={discardUpload} disabled={importing}>
            {isReplace ? "Keep previous version" : "Discard upload"}
          </Button>
          <Button variant="primary" onClick={runImport} loading={importing} disabled={loading || preview.columns.length === 0} data-testid="confirm-import">
            <FileUp /> Import dataset
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-dense text-ink-2">
          <span className="font-mono text-2xs text-ink">{original?.filename}</span>
          <Badge>{format.toUpperCase()}</Badge>
          {original && <span className="tabular-nums">{fmtBytes(original.size_bytes)}</span>}
          {detected?.encoding && (
            <span>
              encoding <span className="font-medium text-ink">{detected.encoding}</span>
              {detected.encoding_confidence !== null && detected.encoding_confidence !== undefined && detected.encoding_confidence < 0.6 && (
                <Badge tone="warning" className="ml-1">
                  low confidence
                </Badge>
              )}
            </span>
          )}
          {detected?.delimiter && (
            <span>
              delimiter <span className="font-mono font-medium text-ink">{detected.delimiter === "\t" ? "tab" : detected.delimiter}</span>
            </span>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Dataset name" htmlFor="import-name" className="sm:col-span-2 lg:col-span-1">
            <Input id="import-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} />
          </Field>
          {format === "xlsx" && (detected?.sheets?.length ?? 0) > 0 && (
            <Field label="Sheet" htmlFor="import-sheet">
              <Select id="import-sheet" value={options.sheet ?? ""} onChange={(event) => set("sheet", event.target.value)}>
                {detected!.sheets!.map((sheet) => (
                  <option key={sheet} value={sheet}>
                    {sheet}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {format === "csv" && (
            <>
              <Field label="Delimiter" htmlFor="import-delim">
                <Select id="import-delim" value={options.delimiter ?? ","} onChange={(event) => set("delimiter", event.target.value)}>
                  {DELIMITERS.map(([value, label]) => (
                    <option key={label} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Encoding" htmlFor="import-enc">
                <Select id="import-enc" value={options.encoding ?? "utf-8"} onChange={(event) => set("encoding", event.target.value)}>
                  {[...new Set([options.encoding ?? "utf-8", ...ENCODINGS])].map((encoding) => (
                    <option key={encoding} value={encoding}>
                      {encoding}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Decimal separator" htmlFor="import-dec">
                <Select id="import-dec" value={options.decimal ?? "."} onChange={(event) => set("decimal", event.target.value as "." | ",")}>
                  <option value=".">Point 1.5</option>
                  <option value=",">Comma 1,5</option>
                </Select>
              </Field>
            </>
          )}
          {format !== "parquet" && (
            <Field label="Header row" hint="0 = first row" htmlFor="import-header">
              <NumberInput
                id="import-header"
                integer
                min={0}
                max={100}
                fallback={0}
                value={options.header_row ?? 0}
                onValueChange={(row) => set("header_row", row ?? 0)}
              />
            </Field>
          )}
        </div>

        {preview.warnings.map((warning) => (
          <Notice key={warning} tone="warning">
            {warning}
          </Notice>
        ))}
        {error && <Notice tone="critical">{error}</Notice>}

        <div>
          <div className="mb-1.5 flex items-center justify-between text-2xs text-ink-2">
            <span>
              Preview · first {preview.rows.length} rows · {preview.columns.length} columns
            </span>
            {loading && <Spinner label="Re-reading…" />}
          </div>
          <div className={cn("max-h-80 overflow-auto rounded-md border border-line", loading && "opacity-60")}>
            <table className="w-max min-w-full text-dense">
              <thead className="sticky top-0 bg-sunken">
                <tr>
                  {preview.columns.map((column, index) => (
                    <th key={`${column}-${index}`} scope="col" className="px-3 py-1.5 text-left font-mono text-2xs font-normal whitespace-nowrap text-ink">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, r) => (
                  <tr key={r} className="border-t border-line">
                    {row.map((value, c) => (
                      <td key={c} className="max-w-56 truncate px-3 py-1 whitespace-nowrap">
                        {value === null ? <span className="text-ink-3/70">—</span> : fmtCell(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </DialogContent>
  );
}
