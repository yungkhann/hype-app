"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Boxes,
  BrainCircuit,
  ChevronRight,
  FlaskConical,
  Home,
  LayoutDashboard,
  Lightbulb,
  Menu as MenuIcon,
  MonitorPlay,
  Printer,
  Puzzle,
  Search,
  Table2,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useHealth } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/surface";
import { CommandMenu, type CommandPage } from "./command-menu";
import { DatasetSwitcher } from "./dataset-switcher";

type NavItem = { href: string; label: string; icon: LucideIcon };

const NAV: { label: string; items: NavItem[] }[] = [
  { label: "Workspace", items: [{ href: "/", label: "Datasets", icon: Home }] },
  {
    label: "Understand",
    items: [
      { href: "/overview", label: "Overview", icon: LayoutDashboard },
      { href: "/explorer", label: "Explorer", icon: Table2 },
    ],
  },
  {
    label: "Build",
    items: [
      { href: "/prepare", label: "Prepare", icon: Wand2 },
      { href: "/analysis", label: "Analysis Lab", icon: FlaskConical },
      { href: "/models", label: "Model Lab", icon: BrainCircuit },
    ],
  },
  {
    label: "Communicate",
    items: [
      { href: "/findings", label: "Findings", icon: Lightbulb },
      { href: "/present", label: "Presentation", icon: MonitorPlay },
      { href: "/report", label: "Report", icon: Printer },
    ],
  },
  { label: "Case", items: [{ href: "/challenge", label: "Challenge", icon: Puzzle }] },
];

const PAGES: CommandPage[] = NAV.flatMap((group) => group.items.map((item) => ({ ...item, group: group.label })));

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarContent({ onNavigate, onSearch }: { onNavigate?: () => void; onSearch: () => void }) {
  const pathname = usePathname();
  return (
    <div className="flex h-full flex-col">
      <Link href="/" onClick={onNavigate} className="flex h-12 shrink-0 items-center gap-2 px-4 text-ink">
        <Boxes className="size-[18px] text-accent" aria-hidden />
        <span className="text-dense font-semibold tracking-[0.04em]">ATLAS</span>
        <span className="text-dense text-ink-3">Studio</span>
      </Link>
      <div className="px-3 pb-1">
        <button
          type="button"
          onClick={() => {
            onNavigate?.();
            onSearch();
          }}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-line-strong bg-sunken px-2.5 text-dense text-ink-3 transition-colors hover:border-control hover:text-ink-2"
        >
          <Search className="size-3.5" aria-hidden />
          <span className="flex-1 text-left">Jump to…</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pt-2 pb-4">
        {NAV.map((group) => (
          <div key={group.label} className="mt-4 first:mt-1">
            <p className="px-2 pb-1 text-xs font-medium text-ink-3">{group.label}</p>
            <ul className="flex flex-col gap-px">
              {group.items.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-[30px] items-center gap-2.5 rounded-md px-2 text-dense text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink",
                        active && "bg-raised font-medium text-ink hover:bg-raised",
                      )}
                    >
                      <item.icon className={cn("size-4 shrink-0", active ? "text-accent" : "text-ink-3")} aria-hidden />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <ApiStatus />
    </div>
  );
}

function ApiStatus() {
  const health = useHealth();
  const ok = health.isSuccess;
  const label = health.isPending ? "Connecting to API…" : ok ? "API connected · local only" : "API offline";
  return (
    <div className="border-t border-line px-4 py-3 text-xs text-ink-3" role="status" aria-live="polite">
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn("size-1.5 rounded-full", health.isPending ? "bg-ink-3" : ok ? "bg-good" : "bg-critical")} />
        <span className={cn(!ok && !health.isPending && "text-critical")}>{label}</span>
      </div>
      {ok && (
        <p className="mt-0.5 pl-3.5 tabular-nums">
          v{health.data.version} · upload ≤ {health.data.limits.max_upload_mb} MB
        </p>
      )}
      {!ok && !health.isPending && <p className="mt-0.5 pl-3.5">Run “pnpm dev” in the repo.</p>}
    </div>
  );
}

function Breadcrumb() {
  const pathname = usePathname();
  const page = PAGES.find((p) => isActive(pathname, p.href));
  if (!page) return null;
  return (
    <p className="hidden min-w-0 items-center gap-1.5 text-dense lg:flex">
      <span className="text-ink-3">{page.group}</span>
      <ChevronRight className="size-3.5 text-ink-3" aria-hidden />
      <span className="truncate font-medium text-ink">{page.label}</span>
    </p>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  // The drawer is a modal below lg only; if the window grows past lg while it is open, close it, or its
  // invisible modal layer would keep the page inert.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1024px)");
    const onChange = () => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  return (
    <div className="flex min-h-dvh bg-canvas">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-raised px-3 py-2 text-dense focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <aside className="no-print sticky top-0 hidden h-dvh w-[220px] shrink-0 border-r border-line bg-canvas lg:block">
        <SidebarContent onSearch={() => setCommandOpen(true)} />
      </aside>
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-[272px] border-r border-line bg-canvas shadow-overlay focus:outline-none data-[state=open]:animate-[atlas-rise_160ms_var(--ease-out-quart)] lg:hidden">
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">ATLAS sections</DialogPrimitive.Description>
            <DialogPrimitive.Close className="absolute top-3 right-3 rounded-md p-1 text-ink-3 hover:bg-hover hover:text-ink" aria-label="Close navigation">
              <X className="size-4" />
            </DialogPrimitive.Close>
            <SidebarContent onNavigate={() => setOpen(false)} onSearch={() => setCommandOpen(true)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <CommandMenu pages={PAGES} open={commandOpen} onOpenChange={setCommandOpen} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-12 shrink-0 items-center gap-3 border-b border-line bg-canvas px-4 md:px-6">
          <button
            type="button"
            className="-ml-1.5 rounded-md p-1.5 text-ink-2 hover:bg-hover hover:text-ink lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
          >
            <MenuIcon className="size-[18px]" />
          </button>
          <span className="text-dense font-semibold tracking-[0.04em] text-ink lg:hidden">ATLAS</span>
          <Breadcrumb />
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="rounded-md p-1.5 text-ink-2 hover:bg-hover hover:text-ink lg:hidden"
              aria-label="Jump to a page or dataset"
            >
              <Search className="size-4" />
            </button>
            <DatasetSwitcher />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pt-6 pb-16 focus:outline-none md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
