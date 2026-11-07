"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowDown, ArrowRight, ArrowUp, CornerDownLeft, Database, Search, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { setActiveDataset, useActiveDatasetId } from "@/lib/active-dataset";
import { useDatasets } from "@/lib/api/hooks";
import { fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/surface";

export type CommandPage = { href: string; label: string; group: string; icon: LucideIcon };

type Command = {
  id: string;
  label: string;
  hint: string;
  group: "Go to" | "Switch dataset";
  icon: LucideIcon;
  keywords: string;
  run: () => void;
};

/** Every word typed must appear somewhere in the label or keywords, in any order. */
function matches(command: Command, query: string) {
  const haystack = `${command.label} ${command.keywords}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * ⌘K / Ctrl+K: jump to any page or switch the active dataset without leaving the keyboard.
 * A dialog because it is a global, transient, focus-owning action; it never holds state.
 */
export function CommandMenu({ pages, open, onOpenChange }: { pages: CommandPage[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const datasets = useDatasets();
  const activeId = useActiveDatasetId();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // The one path for opening and closing: every close (Esc, overlay, ⌘K, running a command) starts the next
  // opening from an empty query with the first row highlighted.
  const setOpen = useCallback(
    (next: boolean) => {
      if (next) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      else {
        setQuery("");
        setIndex(0);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!event.repeat) setOpen(!open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  const commands = useMemo<Command[]>(() => {
    const close = () => setOpen(false);
    const go: Command[] = pages.map((page) => ({
      id: `page:${page.href}`,
      label: page.label,
      hint: page.group,
      group: "Go to",
      icon: page.icon,
      keywords: `${page.group} ${page.href}`,
      run: () => {
        close();
        router.push(page.href);
      },
    }));
    const switchTo: Command[] = (datasets.data ?? [])
      .filter((d) => d.status === "ready")
      .map((d) => ({
        id: `dataset:${d.id}`,
        label: d.name,
        hint: d.id === activeId ? "active" : `${fmtNumber(d.n_rows)} × ${fmtNumber(d.n_cols)}`,
        group: "Switch dataset",
        icon: Database,
        keywords: `dataset ${d.format} ${d.is_synthetic ? "synthetic sample" : ""}`,
        run: () => {
          close();
          setActiveDataset(d.id);
          router.push("/overview");
        },
      }));
    return [...go, ...switchTo];
  }, [pages, datasets.data, activeId, router, setOpen]);

  const visible = commands.filter((command) => matches(command, query));
  const current = Math.min(index, Math.max(0, visible.length - 1));

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  function onInputKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setIndex((visible.length + current + step) % Math.max(1, visible.length));
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      visible[current]?.run();
    }
  }

  const groups: { name: string; slug: string; items: { command: Command; i: number }[] }[] = [];
  visible.forEach((command, i) => {
    const last = groups[groups.length - 1];
    if (last?.name === command.group) last.items.push({ command, i });
    else groups.push({ name: command.group, slug: command.group.toLowerCase().replace(/\s+/g, "-"), items: [{ command, i }] });
  });

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-[atlas-rise_140ms_var(--ease-out-quart)]" />
        <DialogPrimitive.Content
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[min(70vh,560px)] w-[calc(100vw-2rem)] max-w-[620px] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-line-strong bg-raised shadow-overlay focus:outline-none data-[state=open]:animate-[atlas-pop_160ms_var(--ease-out-quart)]"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).querySelector("input")?.focus();
          }}
          onCloseAutoFocus={(event) => {
            // Opened from the mobile drawer, the original button is gone by now; land on the content instead of <body>.
            event.preventDefault();
            const target = returnFocus.current?.isConnected ? returnFocus.current : document.getElementById("main");
            target?.focus({ preventScroll: true });
          }}
        >
          <DialogPrimitive.Title className="sr-only">Command menu</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Type to jump to a page or switch the active dataset.</DialogPrimitive.Description>
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search className="size-4 shrink-0 text-ink-3" aria-hidden />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(0);
              }}
              onKeyDown={onInputKey}
              placeholder="Jump to a page or dataset…"
              aria-label="Search commands"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={visible[current] ? `${listId}-${current}` : undefined}
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
            />
            <Kbd>esc</Kbd>
          </div>
          <div ref={listRef} id={listId} role="listbox" aria-label="Commands" className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {visible.length === 0 && <p className="px-3 py-6 text-center text-dense text-ink-3">Nothing matches “{query}”.</p>}
            {groups.map((group) => (
              <div key={group.name} role="group" aria-labelledby={`${listId}-${group.slug}`}>
                <p id={`${listId}-${group.slug}`} role="presentation" className="px-2.5 pt-2.5 pb-1 text-xs font-medium text-ink-3">
                  {group.name}
                </p>
                {group.items.map(({ command, i }) => (
                  <div
                    key={command.id}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === current}
                    data-index={i}
                    onMouseMove={() => setIndex(i)}
                    onClick={command.run}
                    className={cn(
                      "flex h-9 cursor-pointer items-center gap-3 rounded-md px-2.5 text-dense text-ink-2",
                      i === current && "bg-hover text-ink",
                    )}
                  >
                    <command.icon className={cn("size-4 shrink-0", i === current ? "text-accent" : "text-ink-3")} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    <span className="shrink-0 text-xs text-ink-3 tabular-nums">{command.hint}</span>
                    <ArrowRight className={cn("size-3.5 shrink-0 text-ink-3", i === current ? "opacity-100" : "opacity-0")} aria-hidden />
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-ink-3">
            <span className="flex items-center gap-1.5">
              <Kbd>
                <ArrowUp aria-label="Up" />
              </Kbd>
              <Kbd>
                <ArrowDown aria-label="Down" />
              </Kbd>
              move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>
                <CornerDownLeft aria-label="Enter" />
              </Kbd>
              open
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
