"use client";

import { ArrowLeft, Clock3, Hash, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { PageHeader, PageSkeleton } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { EmptyState, Notice, Panel, PanelHeader } from "@/components/ui/surface";
import { ApiError, errorMessage } from "@/lib/api/client";
import { useConversation, useEvaluation } from "@/lib/cqa/api";
import { languageName, languageTag, spanMessageIds } from "@/lib/cqa/format";
import { fmtDate, fmtDuration, plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ChannelLabel, FixtureBadge, LanguageTag, Mono } from "./bits";
import { EvaluationPanel } from "./evaluation-panel";
import { AudioPlayer, Transcript, type Highlight } from "./transcript";

/**
 * Transcript + evaluation side by side. URL state: ?evaluation=<id>&criterion=<id>&msg=<m5>, so a reviewer
 * can link straight to a cited line. Used by the CQA page and the shell-less embed (Dynamics 365).
 */
export function ConversationWorkspace({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const conversation = useConversation(id);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [range, setRange] = useState<Highlight | null>(null);

  const evaluations = conversation.data?.evaluations ?? [];
  const evaluationId = params.get("evaluation") ?? evaluations[0]?.id ?? null;
  const focusedCriterion = params.get("criterion");
  const msg = params.get("msg");
  const detail = useEvaluation(evaluationId);

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  };

  const focused = useMemo(() => {
    if (!focusedCriterion || !detail.data) return null;
    return detail.data.final_results.find((r) => r.criterion_id === focusedCriterion) ?? null;
  }, [focusedCriterion, detail.data]);
  const messages = conversation.data?.messages;
  const spanIds = useMemo(() => spanMessageIds(focused?.inspected_spans, messages ?? []), [focused, messages]);
  const citedIds = useMemo(() => new Set((focused?.evidence ?? []).map((e) => e.message_id)), [focused]);
  const highlight: Highlight | null = msg ? (range?.messageId === msg ? range : { messageId: msg }) : null;

  if (conversation.isPending) return <PageSkeleton />;
  if (conversation.isError) {
    const missing = conversation.error instanceof ApiError && conversation.error.status === 404;
    return (
      <Panel>
        <EmptyState
          icon={MessagesSquare}
          title={missing ? "Conversation not found" : "Could not load the conversation"}
          action={
            embedded ? undefined : (
              <Button asChild>
                <Link href="/cqa/conversations">All conversations</Link>
              </Button>
            )
          }
        >
          {missing ? <>No conversation with id <Mono>{id}</Mono> has been imported.</> : errorMessage(conversation.error)}
        </EmptyState>
      </Panel>
    );
  }

  const data = conversation.data;
  const voice = data.channel === "voice";
  const seek = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = seconds;
    void audio.play().catch(() => undefined);
  };

  const header = (
    <div className="flex flex-wrap items-center gap-2 text-dense text-ink-2">
      <LanguageTag code={data.language} />
      <ChannelLabel channel={data.channel} />
      <span className="text-line-strong" aria-hidden>
        ·
      </span>
      <span className="tabular-nums">{plural(data.message_count, "line")}</span>
      {data.duration_seconds ? (
        <span className="inline-flex items-center gap-1 tabular-nums">
          <Clock3 className="size-3.5 text-ink-3" aria-hidden />
          {fmtDuration(data.duration_seconds)}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1">
        <Hash className="size-3.5 text-ink-3" aria-hidden />
        {data.group_ids.join(", ")}
      </span>
      {data.source === "fixture" ? <FixtureBadge /> : null}
    </div>
  );

  return (
    <div className={cn("flex flex-col", embedded ? "gap-3" : "gap-5")}>
      {embedded ? (
        <div className="flex flex-col gap-1.5">
          <h1 className="font-mono text-sm text-ink">{data.id}</h1>
          {header}
        </div>
      ) : (
        <PageHeader
          title={<span className="font-mono text-lg">{data.id}</span>}
          description={`${languageName(data.language)} ${voice ? "call" : "chat"} · imported ${fmtDate(data.imported_at, true)}${data.revision > 1 ? ` · revision ${data.revision}` : ""}`}
          meta={header}
          actions={
            <Button variant="ghost" asChild>
              <Link href="/cqa/conversations">
                <ArrowLeft aria-hidden />
                All conversations
              </Link>
            </Button>
          }
        />
      )}
      {data.warnings.length ? (
        <Notice tone="info" title="Import notes">
          <ul className="list-disc pl-4 text-xs">
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]">
        <Panel>
          <PanelHeader
            title="Transcript"
            description={`Original roles and timestamps · ${Object.entries(data.speaker_counts)
              .map(([speaker, count]) => `${count} ${speaker}`)
              .join(", ")}`}
          />
          {voice && data.has_audio ? (
            <div className="border-b border-line">
              <AudioPlayer conversationId={data.id} audioRef={audioRef} />
            </div>
          ) : null}
          <Transcript
            messages={data.messages}
            lang={languageTag(data.language)}
            highlight={highlight}
            spanIds={spanIds}
            citedIds={citedIds}
            onSeek={voice && data.has_audio ? seek : undefined}
          />
        </Panel>
        <div className="xl:sticky xl:top-16 xl:max-h-[calc(100dvh-5rem)] xl:overflow-y-auto">
          <EvaluationPanel
            conversationId={data.id}
            evaluations={evaluations}
            evaluationId={evaluationId}
            onSelectEvaluation={(next) => setParams({ evaluation: next, criterion: null, msg: null })}
            focusedCriterion={focusedCriterion}
            onFocusCriterion={(criterion) => setParams({ criterion })}
            onCite={(next) => {
              setRange({ ...next, nonce: Date.now() });
              setParams({ msg: next.messageId });
            }}
          />
        </div>
      </div>
    </div>
  );
}
