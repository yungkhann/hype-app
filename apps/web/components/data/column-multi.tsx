"use client";

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { ColumnInfo } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";

/** Multi-column picker. Shows chosen columns inline; the popover filters by name. */
export function ColumnMultiSelect({
  columns,
  value,
  onChange,
  placeholder = "Choose columns",
  id,
  className,
}: {
  columns: ColumnInfo[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  id?: string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const shown = columns.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));
  const summary = value.length === 0 ? placeholder : value.length <= 3 ? value.join(", ") : `${value.slice(0, 2).join(", ")} +${value.length - 2}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          className={cn(
            "flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-control/70 bg-panel px-2.5 text-left text-dense hover:border-control",
            className,
          )}
          disabled={!columns.length}
        >
          <span className={cn("truncate", value.length ? "font-mono text-2xs text-ink" : "text-ink-3")}>{columns.length ? summary : "No suitable columns"}</span>
          <ChevronDown className="size-4 shrink-0 text-ink-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <div className="border-b border-line p-2">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find column" aria-label="Find column" className="h-7" />
          <div className="mt-2 flex gap-3">
            <Button size="sm" variant="link" onClick={() => onChange([...new Set([...value, ...shown.map((c) => c.name)])])}>
              Select {query ? "matching" : "all"}
            </Button>
            <Button size="sm" variant="link" onClick={() => onChange([])}>
              Clear
            </Button>
          </div>
        </div>
        <ul className="max-h-64 overflow-y-auto p-1">
          {shown.map((column) => {
            const checked = value.includes(column.name);
            return (
              <li key={column.name}>
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-dense hover:bg-hover">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) => onChange(next ? [...value, column.name] : value.filter((v) => v !== column.name))}
                  />
                  <span className="truncate font-mono text-2xs">{column.name}</span>
                  <span className="ml-auto text-2xs text-ink-3">{column.kind}</span>
                </label>
              </li>
            );
          })}
          {shown.length === 0 && <li className="px-2 py-3 text-center text-dense text-ink-3">No match</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
