"use client";

import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Expand, Minimize, NotebookText, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/api/client";
import { useFindings, usePitch, useSavePitch } from "@/lib/api/hooks";
import type { Finding, PitchDeck, PitchSlide } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { ChartView } from "@/components/charts/chart-view";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Badge, Kbd, Notice, Spinner } from "@/components/ui/surface";

/** Default texts from the API's starter deck. Shown as visible placeholders until someone edits them. */
const PLACEHOLDERS = new Set([
  "Untitled solution",
  "Team name · Data Challenge: Doomsday · 2026",
  "Write the business problem in one or two sentences.",
  "Attach the findings that describe the data.",
  "What the team built and the decision it supports.",
  "Data used, preparation, validation strategy, and baselines.",
  "Attach model or analysis findings with their evidence.",
  "Expected impact, assumptions, and what is not proven.",
]);
const isPlaceholder = (text: string) => !text.trim() || PLACEHOLDERS.has(text.trim());

const SECTIONS: PitchSlide["section"][] = ["title", "problem", "observations", "solution", "methodology", "results", "impact", "custom"];

export function PresentView() {
  const pitch = usePitch();
  const findings = useFindings();
  if (pitch.isError || findings.isError) {
    return (
      <div className="grid min-h-screen place-items-center bg-canvas p-6">
        <Notice tone="critical" title="The pitch could not be loaded" action={<Link href="/findings" className="text-accent-ink underline">Back to findings</Link>}>
          {errorMessage(pitch.error ?? findings.error)}
        </Notice>
      </div>
    );
  }
  if (!pitch.data || !findings.data) {
    return (
      <div className="grid min-h-screen place-items-center bg-black text-ink-2">
        <Spinner label="Loading pitch" className="text-ink-2" />
      </div>
    );
  }
  return <Deck initial={pitch.data} findings={findings.data} />;
}

function Deck({ initial, findings }: { initial: PitchDeck; findings: Finding[] }) {
  const save = useSavePitch();
  const [deck, setDeck] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageWidth, setStageWidth] = useState(960);

  const total = deck.slides.length;
  const current = Math.min(index, total - 1);
  const slide = deck.slides[current];
  const byId = new Map(findings.map((f) => [f.id, f]));

  // Counts local edits so a save that finishes after further typing does not mark those edits as saved.
  const revision = useRef(0);
  function change(next: (d: PitchDeck) => PitchDeck) {
    revision.current += 1;
    setDeck(next);
    setDirty(true);
  }
  const updateSlide = (id: string, patch: Partial<PitchSlide>) => change((d) => ({ ...d, slides: d.slides.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  function persist() {
    if (save.isPending) return;
    const sent = revision.current;
    save.mutate(deck, {
      onSuccess: () => {
        if (revision.current === sent) setDirty(false);
        toast.success(revision.current === sent ? "Pitch saved" : "Pitch saved; newer edits are not saved yet");
      },
      onError: (error) => toast.error("Could not save the pitch", { description: errorMessage(error) }),
    });
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => toast("Full screen is not available in this browser."));
  }

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty) persist();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Space and Enter belong to a focused control; inside the editor, arrows and Home/End stay with its controls.
      if (event.key === " " && target?.closest("button, a[href], [role='switch'], [role='tab'], [role='menuitem']")) return;
      if (target?.closest("[data-slide-editor]") && ["ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      const go = (to: number) => setIndex(Math.max(0, Math.min(total - 1, to)));
      switch (event.key) {
        case "ArrowRight":
        case "PageDown":
        case " ":
          event.preventDefault();
          go(current + 1);
          break;
        case "ArrowLeft":
        case "PageUp":
          event.preventDefault();
          go(current - 1);
          break;
        case "Home":
          event.preventDefault();
          go(0);
          break;
        case "End":
          event.preventDefault();
          go(total - 1);
          break;
        case "e":
          setEditing((v) => !v);
          break;
        case "n":
          setNotes((v) => !v);
          break;
        case "f":
          toggleFullscreen();
          break;
        case "Escape":
          if (editing) setEditing(false);
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-ink-2" data-testid="pitch">
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 items-center justify-center p-3 sm:p-6" aria-label="Slide">
          <div
            ref={stageRef}
            className="@container relative aspect-video w-full overflow-hidden rounded-lg border border-line bg-panel text-ink"
            style={{ maxWidth: `calc((100vh - ${notes ? 12 : 6}rem) * 16 / 9)` }}
            aria-live="polite"
            data-testid="slide"
          >
            <SlideView deck={deck} slide={slide} index={current} total={total} byId={byId} width={stageWidth} editing={editing} onEdit={() => setEditing(true)} />
          </div>
        </main>
        {editing && (
          <Editor
            deck={deck}
            slide={slide}
            index={current}
            findings={findings}
            byId={byId}
            onDeck={(patch) => change((d) => ({ ...d, ...patch }))}
            onSlide={(patch) => updateSlide(slide.id, patch)}
            onSelect={setIndex}
            onAdd={() => {
              const id = `s${Date.now().toString(36)}`;
              change((d) => {
                const slides = [...d.slides];
                slides.splice(current + 1, 0, { id, section: "custom", title: "New slide", body: "", finding_ids: [], notes: "" });
                return { ...d, slides };
              });
              setIndex(current + 1);
            }}
            onDelete={() => {
              change((d) => ({ ...d, slides: d.slides.filter((s) => s.id !== slide.id) }));
              setIndex(Math.max(0, current - 1));
            }}
            onMove={(delta) => {
              change((d) => {
                const slides = [...d.slides];
                const [item] = slides.splice(current, 1);
                slides.splice(current + delta, 0, item);
                return { ...d, slides };
              });
              setIndex(current + delta);
            }}
            onClose={() => setEditing(false)}
          />
        )}
      </div>
      {notes && (
        <div className="mx-3 mb-2 max-h-24 overflow-y-auto rounded-md border border-line bg-panel px-4 py-2 text-dense whitespace-pre-line text-ink-2 sm:mx-6" aria-label="Speaker notes">
          {slide.notes.trim() || <span className="text-ink-3 italic">No speaker notes for this slide.</span>}
        </div>
      )}
      <footer className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-dense sm:px-6">
        <Link
          href="/findings"
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-ink-2 hover:bg-hover hover:text-ink"
          onClick={(event) => {
            if (dirty && !window.confirm("Leave without saving the pitch changes?")) event.preventDefault();
          }}
        >
          <ArrowLeft className="size-4" aria-hidden /> Exit
        </Link>
        <div className="mx-auto flex items-center gap-1">
          <ToolbarButton label="Previous slide" disabled={current === 0} onClick={() => setIndex(current - 1)}>
            <ChevronLeft />
          </ToolbarButton>
          <span className="min-w-16 text-center tabular-nums" data-testid="slide-counter">
            {current + 1} / {total}
          </span>
          <ToolbarButton label="Next slide" disabled={current === total - 1} onClick={() => setIndex(current + 1)}>
            <ChevronRight />
          </ToolbarButton>
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-2 hidden items-center gap-1 text-2xs text-ink-3 lg:flex">
            <Kbd>
              <ArrowLeft aria-label="Left arrow" />
            </Kbd>
            <Kbd>
              <ArrowRight aria-label="Right arrow" />
            </Kbd>{" "}
            move · <Kbd>E</Kbd> edit · <Kbd>N</Kbd> notes · <Kbd>F</Kbd> full screen
          </span>
          <ToolbarButton label="Speaker notes" pressed={notes} onClick={() => setNotes((v) => !v)}>
            <NotebookText />
          </ToolbarButton>
          <ToolbarButton label="Edit slides" pressed={editing} onClick={() => setEditing((v) => !v)}>
            <Pencil />
          </ToolbarButton>
          <ToolbarButton label={fullscreen ? "Exit full screen" : "Full screen"} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize /> : <Expand />}
          </ToolbarButton>
          {dirty && (
            <Button size="sm" variant="primary" onClick={persist} loading={save.isPending} className="ml-1" data-testid="save-pitch">
              <Save /> Save
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

function ToolbarButton({ label, onClick, disabled, pressed, children }: { label: string; onClick: () => void; disabled?: boolean; pressed?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid size-8 place-items-center rounded-md text-ink-2 transition-colors duration-100 hover:bg-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent [&_svg]:size-4",
        pressed && "bg-raised text-accent",
      )}
    >
      {children}
    </button>
  );
}

/* ---------------- slide rendering ---------------- */

function Placeholder({ text, editing, onEdit, className }: { text: string; editing: boolean; onEdit: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onEdit}
      className={cn("rounded-md border border-dashed border-line-strong px-[1.2cqw] py-[0.6cqw] text-left text-ink-3 italic hover:border-accent hover:text-ink-2", className)}
      aria-label={`Placeholder: ${text || "empty"}. Edit slide`}
    >
      {text || "Empty — click to write"}
      {!editing && <span className="ml-[0.8cqw] text-[1.1cqw] not-italic">placeholder</span>}
    </button>
  );
}

function SlideView({
  deck,
  slide,
  index,
  total,
  byId,
  width,
  editing,
  onEdit,
}: {
  deck: PitchDeck;
  slide: PitchSlide;
  index: number;
  total: number;
  byId: Map<string, Finding>;
  width: number;
  editing: boolean;
  onEdit: () => void;
}) {
  const height = (width * 9) / 16;
  const attached = slide.finding_ids.map((id) => byId.get(id)).filter((f): f is Finding => Boolean(f));

  if (slide.section === "title") {
    return (
      <div className="flex h-full flex-col justify-center gap-[1.6cqw] bg-panel px-[7cqw] text-ink">
        <span className="block h-[0.35cqw] w-[6cqw] rounded-full bg-accent" aria-hidden />
        {isPlaceholder(deck.title) ? (
          <Placeholder text={deck.title} editing={editing} onEdit={onEdit} className="self-start border-ink-3/50 text-[4.6cqw] font-semibold text-ink-3" />
        ) : (
          <h1 className="text-[4.6cqw] leading-tight font-semibold tracking-tight text-balance">{deck.title}</h1>
        )}
        {deck.subtitle && <p className="text-[2cqw] text-ink-2">{deck.subtitle}</p>}
        {deck.team && <p className="text-[1.6cqw] text-ink-2">{deck.team}</p>}
        {slide.title && <p className="text-[1.6cqw] text-ink-2">{slide.title}</p>}
        {isPlaceholder(slide.body) ? (
          <Placeholder text={slide.body} editing={editing} onEdit={onEdit} className="self-start border-ink-3/50 text-[1.4cqw] text-ink-3" />
        ) : (
          <p className="text-[1.4cqw] whitespace-pre-line text-ink-3">{slide.body}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col px-[4.5cqw] pt-[3.4cqw] pb-[2cqw]">
      <h2 className="text-[3cqw] leading-tight font-semibold tracking-tight text-balance text-ink">
        {slide.title || <Placeholder text="" editing={editing} onEdit={onEdit} />}
      </h2>
      <div className="mt-[1.2cqw] max-w-[80cqw] text-[1.6cqw] leading-snug text-ink-2">
        {isPlaceholder(slide.body) ? (
          attached.length === 0 || slide.body.trim() ? <Placeholder text={slide.body} editing={editing} onEdit={onEdit} /> : null
        ) : (
          <p className="whitespace-pre-line">{slide.body}</p>
        )}
      </div>
      <div className="mt-[1.6cqw] min-h-0 flex-1">
        {attached.length === 1 && <SingleFinding finding={attached[0]} chartHeight={Math.max(140, height * 0.5)} editing={editing} />}
        {attached.length > 1 && (
          <div className={cn("grid h-full gap-[1.6cqw]", attached.length === 2 ? "grid-cols-2" : "grid-cols-3")}>
            {attached.slice(0, 3).map((f) => (
              <CompactFinding key={f.id} finding={f} chartHeight={Math.max(120, height * (attached.length === 2 ? 0.42 : 0.36))} editing={editing} />
            ))}
          </div>
        )}
      </div>
      <div className="mt-[1cqw] flex justify-between text-[1cqw] text-ink-3 tabular-nums">
        <span className="truncate">{isPlaceholder(deck.title) ? "" : deck.title}</span>
        <span>
          {index + 1} / {total}
          {attached.length > 3 && ` · ${attached.length - 3} more finding(s) not shown on this slide`}
        </span>
      </div>
    </div>
  );
}

function SingleFinding({ finding, chartHeight, editing }: { finding: Finding; chartHeight: number; editing: boolean }) {
  return (
    <div className={cn("grid h-full gap-[2cqw]", finding.chart ? "grid-cols-[3fr_2fr]" : "grid-cols-1")}>
      {finding.chart && (
        <div className="min-w-0 overflow-hidden">
          <ChartView data={finding.chart} height={chartHeight} toolbar={false} title={finding.title} />
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-[1cqw] overflow-hidden text-[1.3cqw]">
        {!finding.chart && <p className="text-[1.8cqw] font-semibold text-ink">{finding.title}</p>}
        {finding.description && <p className="text-ink">{finding.description}</p>}
        {finding.evidence.length > 0 && (
          <dl className="flex flex-col">
            {finding.evidence.slice(0, 5).map((e, i) => (
              <div key={i} className="flex justify-between gap-[1cqw] border-b border-line py-[0.4cqw]">
                <dt className="text-ink-2">{e.label}</dt>
                <dd className="font-semibold text-ink tabular-nums">{e.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {finding.interpretation ? (
          <p className="text-ink">{finding.interpretation}</p>
        ) : (
          editing && (
            <Badge tone="warning" className="self-start">
              finding has no interpretation
            </Badge>
          )
        )}
        {finding.implication && <p className="font-medium text-accent-ink">{finding.implication}</p>}
      </div>
    </div>
  );
}

function CompactFinding({ finding, chartHeight, editing }: { finding: Finding; chartHeight: number; editing: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-[0.8cqw] overflow-hidden text-[1.2cqw]">
      {finding.chart ? (
        <ChartView data={finding.chart} height={chartHeight} toolbar={false} title={finding.title} />
      ) : (
        <>
          <p className="text-[1.5cqw] font-semibold text-ink">{finding.title}</p>
          <dl className="flex flex-col">
            {finding.evidence.slice(0, 4).map((e, i) => (
              <div key={i} className="flex justify-between gap-[1cqw] border-b border-line py-[0.3cqw]">
                <dt className="text-ink-2">{e.label}</dt>
                <dd className="font-semibold text-ink tabular-nums">{e.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {finding.interpretation ? <p className="text-ink">{finding.interpretation}</p> : editing && <Badge tone="warning" className="self-start">no interpretation</Badge>}
    </div>
  );
}

/* ---------------- editor ---------------- */

function Editor({
  deck,
  slide,
  index,
  findings,
  byId,
  onDeck,
  onSlide,
  onSelect,
  onAdd,
  onDelete,
  onMove,
  onClose,
}: {
  deck: PitchDeck;
  slide: PitchSlide;
  index: number;
  findings: Finding[];
  byId: Map<string, Finding>;
  onDeck: (patch: Partial<PitchDeck>) => void;
  onSlide: (patch: Partial<PitchSlide>) => void;
  onSelect: (index: number) => void;
  onAdd: () => void;
  onDelete: () => void;
  onMove: (delta: number) => void;
  onClose: () => void;
}) {
  const available = findings.filter((f) => !slide.finding_ids.includes(f.id));
  return (
    <aside className="flex w-full max-w-sm shrink-0 flex-col overflow-y-auto border-l border-line bg-panel text-ink" aria-label="Slide editor" data-slide-editor>
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <p className="text-dense font-semibold">Edit pitch</p>
        <Button size="icon-sm" variant="ghost" aria-label="Close editor" onClick={onClose}>
          <X />
        </Button>
      </div>
      <section className="flex flex-col gap-3 border-b border-line p-4">
        <Field label="Solution title" htmlFor="deck-title">
          <Input id="deck-title" value={deck.title} onChange={(event) => onDeck({ title: event.target.value })} maxLength={200} />
        </Field>
        <Field label="Subtitle" htmlFor="deck-subtitle">
          <Input id="deck-subtitle" value={deck.subtitle} onChange={(event) => onDeck({ subtitle: event.target.value })} maxLength={200} />
        </Field>
        <Field label="Team" htmlFor="deck-team">
          <Input id="deck-team" value={deck.team} onChange={(event) => onDeck({ team: event.target.value })} maxLength={200} />
        </Field>
      </section>
      <section className="border-b border-line p-2">
        <ol className="flex flex-col">
          {deck.slides.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelect(i)}
                aria-current={i === index ? "true" : undefined}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-dense", i === index ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-hover")}
              >
                <span className="w-5 text-2xs tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{s.title || (s.section === "title" ? deck.title : "Untitled")}</span>
                {(isPlaceholder(s.body) || (s.section === "title" && isPlaceholder(deck.title))) && <span className="size-1.5 rounded-full bg-warning-mark" aria-label="has placeholder text" />}
              </button>
            </li>
          ))}
        </ol>
        <div className="mt-1 flex gap-1 px-1">
          <Button size="sm" variant="ghost" onClick={onAdd}>
            <Plus /> Slide after
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Move slide earlier" disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowLeft />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Move slide later" disabled={index === deck.slides.length - 1} onClick={() => onMove(1)}>
            <ArrowRight />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Delete slide" disabled={deck.slides.length <= 1} onClick={onDelete} className="ml-auto">
            <Trash2 />
          </Button>
        </div>
      </section>
      <section className="flex flex-col gap-3 p-4">
        <p className="text-dense font-semibold">Slide {index + 1}</p>
        <Field label="Layout" htmlFor="slide-section">
          <Select id="slide-section" value={slide.section} onChange={(event) => onSlide({ section: event.target.value as PitchSlide["section"] })}>
            {SECTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Heading" htmlFor="slide-title">
          <Input id="slide-title" value={slide.title} onChange={(event) => onSlide({ title: event.target.value })} maxLength={200} />
        </Field>
        <Field label="Body" htmlFor="slide-body" hint={isPlaceholder(slide.body) ? "still placeholder text" : undefined}>
          <Textarea id="slide-body" rows={4} value={slide.body} onChange={(event) => onSlide({ body: event.target.value })} />
        </Field>
        <Field label="Speaker notes" htmlFor="slide-notes">
          <Textarea id="slide-notes" rows={3} value={slide.notes} onChange={(event) => onSlide({ notes: event.target.value })} />
        </Field>
        {slide.section !== "title" && (
          <div className="flex flex-col gap-2">
            <p className="text-2xs font-medium text-ink-2">Findings on this slide</p>
            {slide.finding_ids.length === 0 && <p className="text-2xs text-ink-3">None attached.</p>}
            <ul className="flex flex-col gap-1">
              {slide.finding_ids.map((id) => {
                const f = byId.get(id);
                return (
                  <li key={id} className="flex items-center gap-2 rounded-md bg-raised px-2 py-1 text-dense">
                    <span className="min-w-0 flex-1 truncate">{f?.title ?? "Deleted finding"}</span>
                    {f && !f.interpretation && <Badge tone="warning">no interpretation</Badge>}
                    <Button size="icon-sm" variant="ghost" aria-label="Detach finding" onClick={() => onSlide({ finding_ids: slide.finding_ids.filter((x) => x !== id) })}>
                      <X />
                    </Button>
                  </li>
                );
              })}
            </ul>
            <Select
              value=""
              aria-label="Attach a finding"
              disabled={!available.length}
              onChange={(event) => event.target.value && onSlide({ finding_ids: [...slide.finding_ids, event.target.value] })}
              data-testid="attach-finding"
            >
              <option value="">{available.length ? "Attach a finding…" : findings.length ? "All findings attached" : "No findings saved yet"}</option>
              {[
                { label: "Marked “In pitch”", items: available.filter((f) => f.include_in_pitch) },
                { label: "Other findings", items: available.filter((f) => !f.include_in_pitch) },
              ]
                .filter((group) => group.items.length)
                .map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.items.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.title}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </Select>
            <p className="text-2xs text-ink-3">Up to three findings render per slide.</p>
          </div>
        )}
      </section>
    </aside>
  );
}
