"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Boxes,
  BrainCircuit,
  ChevronRight,
  FlaskConical,
  Headphones,
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
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { useHealth } from "@/lib/api/hooks";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/surface";
import { CommandMenu, type CommandPage } from "./command-menu";
import { DatasetSwitcher } from "./dataset-switcher";

export type NavItem = { href: string; label: string; icon: LucideIcon; exact?: boolean };
export type NavGroup = { label: string; items: NavItem[] };
export type Brand = { name: string; sub: string; href: string; icon?: LucideIcon };

const NAV: NavGroup[] = [
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
  {
    label: "Case",
    items: [
      { href: "/challenge", label: "Challenge", icon: Puzzle },
      { href: "/cqa", label: "Quality analytics", icon: Headphones },
    ],
  },
];

const ATLAS_BRAND: Brand = { name: "ATLAS", sub: "Studio", href: "/", icon: Boxes };

const toPages = (nav: NavGroup[]): CommandPage[] =>
  nav.flatMap((group) => group.items.map((item) => ({ ...item, group: group.label })));

function isActive(pathname: string, item: Pick<NavItem, "href" | "exact">) {
  const { href } = item;
  return href === "/" || item.exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ nav, pathname, onNavigate }: { nav: NavGroup[]; pathname: string | null; onNavigate?: () => void }) {
  return (
    <>
      {nav.map((group) => (
        <div key={group.label} className="mt-4 first:mt-1">
          <p className="px-2 pb-1 text-xs font-medium text-ink-3">{group.label}</p>
          <ul className="flex flex-col gap-px">
            {group.items.map((item) => {
              const active = pathname !== null && isActive(pathname, item);
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
    </>
  );
}

function ActiveNavLinks({ nav, onNavigate }: { nav: NavGroup[]; onNavigate?: () => void }) {
  return <NavLinks nav={nav} pathname={usePathname()} onNavigate={onNavigate} />;
}

function SidebarContent({
  nav,
  brand,
  footer,
  onNavigate,
  onSearch,
}: {
  nav: NavGroup[];
  brand: Brand;
  footer: ReactNode;
  onNavigate?: () => void;
  onSearch: () => void;
}) {
  const BrandIcon = brand.icon ?? Boxes;
  return (
    <div className="flex h-full flex-col">
      <Link href={brand.href} onClick={onNavigate} className="flex h-12 shrink-0 items-center gap-2 px-4 text-ink">
        <BrandIcon className="size-[18px] text-accent" aria-hidden />
        <span className="text-dense font-semibold tracking-[0.04em]">{brand.name}</span>
        <span className="text-dense text-ink-3">{brand.sub}</span>
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
        {/* The active link needs the pathname, which routes with runtime params (/cqa/conversations/[id]) only
            know at request time; the fallback is the same list without a highlight, so the shell still prerenders. */}
        <Suspense fallback={<NavLinks nav={nav} pathname={null} onNavigate={onNavigate} />}>
          <ActiveNavLinks nav={nav} onNavigate={onNavigate} />
        </Suspense>
      </nav>
      {footer}
    </div>
  );
}

export function ApiStatus() {
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

function Breadcrumb({ pages }: { pages: CommandPage[] }) {
  const pathname = usePathname();
  const page = pages.find((p) => isActive(pathname, p));
  if (!page) return null;
  return (
    <p className="hidden min-w-0 items-center gap-1.5 text-dense lg:flex">
      <span className="text-ink-3">{page.group}</span>
      <ChevronRight className="size-3.5 text-ink-3" aria-hidden />
      <span className="truncate font-medium text-ink">{page.label}</span>
    </p>
  );
}

/**
 * The application frame. Defaults are the ATLAS studio; other areas (CQA) pass their own navigation, brand,
 * header controls and sidebar footer, and can leave dataset switching out of the command menu.
 */
export function AppShell({
  children,
  nav = NAV,
  brand = ATLAS_BRAND,
  headerRight,
  footer,
  datasetCommands = true,
}: {
  children: ReactNode;
  nav?: NavGroup[];
  brand?: Brand;
  headerRight?: ReactNode;
  footer?: ReactNode;
  datasetCommands?: boolean;
}) {
  const pages = toPages(nav);
  const sidebarFooter = footer ?? <ApiStatus />;
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
        <SidebarContent nav={nav} brand={brand} footer={sidebarFooter} onSearch={() => setCommandOpen(true)} />
      </aside>
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60 lg:hidden" />
          <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 w-[272px] border-r border-line bg-canvas shadow-overlay focus:outline-none data-[state=open]:animate-[atlas-rise_160ms_var(--ease-out-quart)] lg:hidden">
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">{brand.name} sections</DialogPrimitive.Description>
            <DialogPrimitive.Close className="absolute top-3 right-3 rounded-md p-1 text-ink-3 hover:bg-hover hover:text-ink" aria-label="Close navigation">
              <X className="size-4" />
            </DialogPrimitive.Close>
            <SidebarContent
              nav={nav}
              brand={brand}
              footer={sidebarFooter}
              onNavigate={() => setOpen(false)}
              onSearch={() => setCommandOpen(true)}
            />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <CommandMenu pages={pages} datasets={datasetCommands} open={commandOpen} onOpenChange={setCommandOpen} />
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
          <span className="text-dense font-semibold tracking-[0.04em] text-ink lg:hidden">{brand.name}</span>
          <Suspense fallback={null}>
            <Breadcrumb pages={pages} />
          </Suspense>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="rounded-md p-1.5 text-ink-2 hover:bg-hover hover:text-ink lg:hidden"
              aria-label={datasetCommands ? "Jump to a page or dataset" : "Jump to a page"}
            >
              <Search className="size-4" />
            </button>
            {headerRight ?? <DatasetSwitcher />}
          </div>
        </header>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pt-6 pb-16 focus:outline-none md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
