"use client";

import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type SortingState } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from "lucide-react";
import { useMemo } from "react";
import type { ColumnInfo, SortKey } from "@/lib/api/types";
import { fmtCell, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { KindIcon } from "@/components/ui/surface";

type Row = unknown[];

/**
 * Server-driven table: sorting and paging are executed by the API; this component renders one page.
 */
export function DataTable({
  columns,
  rows,
  sort,
  onSortChange,
  offset,
  limit,
  total,
  onPageChange,
  loading,
  maxHeight = "min(64vh, 720px)",
}: {
  columns: ColumnInfo[];
  rows: Row[];
  sort?: SortKey[];
  onSortChange?: (sort: SortKey[]) => void;
  offset?: number;
  limit?: number;
  total?: number;
  onPageChange?: (offset: number) => void;
  loading?: boolean;
  maxHeight?: string;
}) {
  const sorting: SortingState = useMemo(() => (sort ?? []).map((s) => ({ id: s.column, desc: s.desc })), [sort]);
  const columnDefs = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((column, index) => ({
        id: column.name,
        accessorFn: (row) => row[index],
        header: column.name,
        meta: column,
        enableSorting: Boolean(onSortChange),
      })),
    [columns, onSortChange],
  );
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8 returns unstable functions by design
  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    state: { sorting },
    manualSorting: true,
    manualPagination: true,
    enableMultiSort: true,
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      onSortChange?.(next.map((s) => ({ column: s.id, desc: s.desc })));
    },
    getCoreRowModel: getCoreRowModel(),
  });

  const start = (offset ?? 0) + 1;
  const end = (offset ?? 0) + rows.length;
  const hasPaging = total !== undefined && limit !== undefined && onPageChange;

  return (
    <div className="flex min-w-0 flex-col">
      <div className={cn("relative overflow-auto rounded-md border border-line", loading && "opacity-70")} style={{ maxHeight }} aria-busy={loading}>
        <table className="w-max min-w-full border-separate border-spacing-0 text-dense">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                <th scope="col" className="sticky top-0 left-0 z-20 w-12 border-b border-line bg-sunken px-2 py-1.5 text-right text-2xs font-normal text-ink-3">
                  #
                </th>
                {group.headers.map((header) => {
                  const meta = header.column.columnDef.meta as ColumnInfo;
                  const sorted = header.column.getIsSorted();
                  const sortable = header.column.getCanSort();
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                      className={cn(
                        "sticky top-0 z-10 border-b border-line bg-sunken px-3 py-1.5 text-left font-normal whitespace-nowrap",
                        meta.kind === "numeric" && "text-right",
                      )}
                    >
                      <button
                        type="button"
                        disabled={!sortable}
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          "inline-flex max-w-64 items-center gap-1.5 text-ink disabled:cursor-default",
                          meta.kind === "numeric" && "flex-row-reverse",
                        )}
                        title={sortable ? "Sort (shift-click to add a secondary sort)" : undefined}
                      >
                        <KindIcon kind={meta.kind} />
                        <span className="truncate font-mono text-2xs">{meta.name}</span>
                        {sortable &&
                          (sorted === "asc" ? (
                            <ArrowUp className="size-3 text-accent" aria-hidden />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="size-3 text-accent" aria-hidden />
                          ) : (
                            <ChevronsUpDown className="size-3 text-ink-3/60" aria-hidden />
                          ))}
                      </button>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, r) => (
              <tr key={row.id} className="hover:bg-canvas">
                <td className="sticky left-0 border-b border-line bg-panel px-2 py-1 text-right text-2xs text-ink-3 tabular-nums">
                  {fmtNumber((offset ?? 0) + r + 1)}
                </td>
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as ColumnInfo;
                  const value = cell.getValue();
                  const missing = value === null || value === undefined;
                  return (
                    <td
                      key={cell.id}
                      className={cn(
                        "max-w-80 truncate border-b border-line px-3 py-1 whitespace-nowrap",
                        meta.kind === "numeric" && "text-right tabular-nums",
                        missing && "text-ink-3/70",
                      )}
                      title={missing ? "missing" : String(value)}
                    >
                      {missing ? "—" : flexRender(() => fmtCell(value), cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-3 py-10 text-center text-ink-2">
                  No rows match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {hasPaging && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-2xs text-ink-2">
          <span className="tabular-nums">
            {rows.length ? `${fmtNumber(start)}–${fmtNumber(end)}` : "0"} of {fmtNumber(total)} rows
          </span>
          <div className="flex items-center gap-1">
            <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={(offset ?? 0) === 0} onClick={() => onPageChange(Math.max(0, (offset ?? 0) - limit))}>
              <ChevronLeft />
            </Button>
            <span className="tabular-nums">
              page {fmtNumber(Math.floor((offset ?? 0) / limit) + 1)} / {fmtNumber(Math.max(1, Math.ceil(total / limit)))}
            </span>
            <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={end >= total} onClick={() => onPageChange((offset ?? 0) + limit)}>
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
