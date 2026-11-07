"use client";

import { ExternalLink, Play, Volume2 } from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/overlays";
import { Badge, Spinner } from "@/components/ui/surface";
import { errorMessage } from "@/lib/api/client";
import { useAudio } from "@/lib/cqa/api";
import { fmtClock, fmtMessageTime, splitHighlight } from "@/lib/cqa/format";
import type { Message } from "@/lib/cqa/types";
import { cn } from "@/lib/utils";
import { SpeakerLabel } from "./bits";

/** A cited line (and optionally the quoted range in it). `nonce` re-scrolls when the same line is cited again. */
export type Highlight = { messageId: string; start?: number | null; end?: number | null; nonce?: number };

/**
 * The transcript exactly as imported: every line keeps its role, its original timestamp and a stable id
 * (m1, m2, …) that evaluations cite. Evidence highlights a line (and the quoted range inside it); inspected
 * spans are shaded so a reviewer can see which lines were checked for a missing action.
 */
export function Transcript({
  messages,
  highlight,
  spanIds,
  citedIds,
  onSeek,
  lang,
  className,
}: {
  messages: Message[];
  /** BCP-47 language of the conversation, so screen readers pronounce it correctly. */
  lang?: string;
  highlight?: Highlight | null;
  spanIds?: Set<string>;
  citedIds?: Set<string>;
  onSeek?: (seconds: number) => void;
  className?: string;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const target = highlight?.messageId;
  const nonce = highlight?.nonce;

  useEffect(() => {
    if (!target) return;
    const element = listRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target)}"]`);
    if (!element) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    element.focus({ preventScroll: true });
  }, [target, nonce]);

  if (!messages.length) return <p className="px-4 py-6 text-dense text-ink-3">This conversation has no transcript lines.</p>;

  return (
    <ol ref={listRef} lang={lang} className={cn("flex flex-col", className)} aria-label="Transcript">
      {messages.map((message) => {
        const active = message.id === target;
        const inSpan = spanIds?.has(message.id);
        const cited = citedIds?.has(message.id);
        const [before, quoted, after] = active ? splitHighlight(message.text, highlight?.start, highlight?.end) : [message.text, "", ""];
        const offset = message.offset_seconds;
        return (
          <li
            key={message.id}
            data-message-id={message.id}
            id={`msg-${message.id}`}
            tabIndex={-1}
            aria-current={active ? "location" : undefined}
            className={cn(
              "grid scroll-mt-24 grid-cols-[4.25rem_minmax(0,1fr)] gap-x-3 border-b border-line px-4 py-2.5 last:border-b-0 focus:outline-none sm:grid-cols-[5.5rem_minmax(0,1fr)]",
              inSpan && "bg-raised",
              active && "bg-accent-soft",
              (message.speaker === "system" || message.speaker === "bot") && !active && "text-ink-2",
            )}
          >
            <div className="flex flex-col items-start gap-0.5 pt-px text-2xs text-ink-3 tabular-nums">
              {onSeek && offset !== null && offset !== undefined ? (
                <Tip content={`Play the recording from ${fmtClock(offset)}`}>
                  <button
                    type="button"
                    onClick={() => onSeek(offset)}
                    className="-ml-1 inline-flex items-center gap-1 rounded px-1 text-ink-2 hover:bg-hover hover:text-ink"
                    aria-label={`Play from ${fmtClock(offset)}`}
                  >
                    <Play className="size-3" aria-hidden />
                    {fmtClock(offset)}
                  </button>
                </Tip>
              ) : (
                <span title={message.timestamp}>{fmtMessageTime(message)}</span>
              )}
              <span className="font-mono">{message.id}</span>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <SpeakerLabel speaker={message.speaker} raw={message.speaker_raw} />
                {cited ? <Badge tone="accent">Cited</Badge> : null}
                {inSpan ? <Badge tone="neutral">Inspected</Badge> : null}
              </div>
              <p className="mt-0.5 text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">
                {before}
                {quoted ? <mark className="rounded-[3px] bg-accent/30 px-0.5 text-ink">{quoted}</mark> : null}
                {after}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The call recording. The organizers' audio_url is a player page; the backend resolves the signed audio file
 * behind it (allow-listed hosts only) so the browser can play and seek it here.
 */
export function AudioPlayer({ conversationId, audioRef }: { conversationId: string; audioRef: RefObject<HTMLAudioElement | null> }) {
  const audio = useAudio(conversationId, true);

  if (audio.isPending) return <Spinner label="Loading the recording…" className="px-4 py-3" />;
  if (audio.isError) return <p className="px-4 py-3 text-dense text-critical">Recording unavailable: {errorMessage(audio.error)}</p>;
  const info = audio.data;
  if (info.status === "unavailable") {
    return <p className="px-4 py-3 text-dense text-ink-3">{info.message ?? "No recording for this conversation."}</p>;
  }
  if (info.status === "player_only") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-dense text-ink-2">
        <span>{info.message ?? "The recording can only be played on the organizers' page."}</span>
        {info.player_url ? (
          <Button size="sm" variant="secondary" asChild>
            <a href={info.player_url} target="_blank" rel="noreferrer noopener">
              <ExternalLink aria-hidden />
              Open player
            </a>
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-center gap-2 text-2xs text-ink-3">
        <Volume2 className="size-3.5" aria-hidden />
        <span>Call recording · press a line’s time to play from there.</span>
      </div>
      <audio ref={audioRef} controls preload="metadata" src={info.stream_url ?? undefined} className="h-9 w-full" />
      <p className="text-2xs text-ink-3">{info.offset_basis}</p>
    </div>
  );
}
