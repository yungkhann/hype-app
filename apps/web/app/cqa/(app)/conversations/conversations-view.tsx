"use client";

import { AlertOctagon, ArrowDownWideNarrow, ArrowUpNarrowWide, ChevronLeft, ChevronRight, Gavel, MessagesSquare, Search, Volume2, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ChannelLabel, EvalStatusBadge, FixtureBadge, LanguageTag, MockBadge, NotEvaluatedBadge, ScoreChange } from "@/components/cqa/bits";
import { EvaluateDialog } from "@/components/cqa/evaluate-dialog";
import { ImportDialog } from "@/components/cqa/import-form";
import { PageHeader } from "@/components/shell/page";
import { Button } from "@/components/ui/button";
import { Input, NumberInput, Select } from "@/components/ui/input";
import { Tip } from "@/components/ui/overlays";
import { EmptyState, Notice, Panel, Skeleton } from "@/components/ui/surface";
import { errorMessage } from "@/lib/api/client";
import { useChecklists, useConversations } from "@/lib/cqa/api";
import { languageName } from "@/lib/cqa/format";
import type { Channel, ConversationQuery, ConversationSort, ConversationSource, ConversationStatusFilter, Facet } from "@/lib/cqa/types";
import { fmtDuration, fmtNumber } from "@/lib/format";
import { useDebounced } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

const STATUS_OPTIONS: { value: ConversationStatusFilter; label: string }[] = [
  { value: "not_evaluated", label: "Not evaluated" },
  { value: "pending", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "appealed", label: "Open appeal" },
];

const SORTS: { value: ConversationSort; label: string }[] = [
  { value: "id", label: "Conversation id" },
  { value: "score", label: "Score" },
  { value: "evaluated_at", label: "Evaluated" },
  { value: "imported_at", label: "Imported" },
  { value: "messages", label: "Lines" },
  { value: "duration", label: "Duration" },
  { value: "language", label: "Language" },
  { value: "channel", label: "Channel" },
];

function readQuery(params: URLSearchParams): ConversationQuery {
  const num = (key: string) => {
    const raw = params.get(key);
    if (raw === null || raw === "") return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const list = <T extends string>(key: string) => {
    const values = params.getAll(key).filter(Boolean) as T[];
    return values.length ? values : undefined;
  };
  return {
    q: params.get("q") ?? undefined,
    language: list<string>("language"),
    channel: list<Channel>("channel"),
    status: list<ConversationStatusFilter>("status"),
    group_id: params.get("group_id") ?? undefined,
    source: (params.get("source") as ConversationSource | null) ?? undefined,
    min_score: num("min_score"),
    max_score: num("max_score"),
    checklist_id: params.get("checklist_id") ?? undefined,
    sort: (params.get("sort") as ConversationSort | null) ?? "id",
    desc: params.get("desc") === "true" || undefined,
    page: num("page") ?? 1,
    page_size: PAGE_SIZE,
  };
}

function facetOptions(facets: Facet[] | undefined, label: (value: string) => string = (v) => v) {
  return (facets ?? []).map((f) => (
    <option key={f.value} value={f.value}>
      {label(f.value)} ({f.count})
    </option>
  ));
}

export function ConversationsView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const query = readQuery(params);
  const [search, setSearch] = useState(query.q ?? "");
  const debounced = useDebounced(search, 300);
  const conversations = useConversations(query);
  const checklists = useChecklists();

  const update = (patch: Partial<Record<keyof ConversationQuery, string | string[] | number | boolean | undefined>>, resetPage = true) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      next.delete(key);
      if (value === undefined || value === "" || value === false) continue;
      if (Array.isArray(value)) value.forEach((v) => next.append(key, v));
      else next.set(key, String(value));
    }
    if (resetPage && !("page" in patch)) next.delete("page");
    if (next.get("sort") === "id") next.delete("sort");
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  // Debounced search goes to the URL (shareable, survives "back" from a conversation).
  useEffect(() => {
    if ((debounced.trim() || undefined) !== query.q) update({ q: debounced.trim() || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to the debounced text
  }, [debounced]);

  const data = conversations.data;
  const facets = data?.facets ?? {};
  const filtered = Boolean(
    query.q || query.language || query.channel || query.status || query.group_id || query.source || query.min_score !== undefined || query.max_score !== undefined,
  );
  const page = data?.page ?? 1;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const from = data && data.total ? (page - 1) * data.page_size + 1 : 0;
  const to = data ? Math.min(data.total, page * data.page_size) : 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Conversations"
        description="Every imported chat and call, with its latest evaluation. Open one to read the transcript and the evidence behind each score."
        actions={
          <>
            <ImportDialog />
            <EvaluateDialog />
          </>
        }
      />

      <Panel>
        <div className="flex flex-wrap items-end gap-2 border-b border-line px-4 py-3">
          <div className="relative min-w-52 flex-1 sm:max-w-80">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search id or transcript text"
              aria-label="Search conversations"
              className="pl-8"
            />
          </div>
          <Select aria-label="Language" value={query.language?.[0] ?? ""} onChange={(e) => update({ language: e.target.value ? [e.target.value] : undefined })} className="w-36">
            <option value="">All languages</option>
            {facetOptions(facets.language, (v) => `${v} · ${languageName(v)}`)}
          </Select>
          <Select aria-label="Channel" value={query.channel?.[0] ?? ""} onChange={(e) => update({ channel: e.target.value ? [e.target.value] : undefined })} className="w-32">
            <option value="">All channels</option>
            {facetOptions(facets.channel, (v) => (v === "voice" ? "Calls" : "Chats"))}
          </Select>
          <Select aria-label="Evaluation status" value={query.status?.[0] ?? ""} onChange={(e) => update({ status: e.target.value ? [e.target.value] : undefined })} className="w-40">
            <option value="">Any status</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
          <Select aria-label="Group" value={query.group_id ?? ""} onChange={(e) => update({ group_id: e.target.value || undefined })} className="w-36">
            <option value="">All groups</option>
            {facetOptions(facets.group)}
          </Select>
          <div className="flex items-center gap-1.5">
            <NumberInput
              aria-label="Minimum score"
              placeholder="Score ≥"
              value={query.min_score ?? null}
              allowEmpty
              min={0}
              onValueChange={(v) => update({ min_score: v ?? undefined })}
              className="w-[5.5rem]"
            />
            <NumberInput
              aria-label="Maximum score"
              placeholder="≤"
              value={query.max_score ?? null}
              allowEmpty
              min={0}
              onValueChange={(v) => update({ max_score: v ?? undefined })}
              className="w-[4.5rem]"
            />
          </div>
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                update({ q: undefined, language: undefined, channel: undefined, status: undefined, group_id: undefined, source: undefined, min_score: undefined, max_score: undefined });
              }}
            >
              <X aria-hidden />
              Clear
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-1.5">
            <Select aria-label="Score from checklist" value={query.checklist_id ?? ""} onChange={(e) => update({ checklist_id: e.target.value || undefined })} className="w-48">
              <option value="">Latest result, any checklist</option>
              {(checklists.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Sort by" value={query.sort ?? "id"} onChange={(e) => update({ sort: e.target.value }, false)} className="w-36">
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  Sort: {s.label}
                </option>
              ))}
            </Select>
            <Tip content={query.desc ? "Descending" : "Ascending"}>
              <Button variant="ghost" size="icon" aria-label={query.desc ? "Sort ascending" : "Sort descending"} onClick={() => update({ desc: !query.desc }, false)}>
                {query.desc ? <ArrowDownWideNarrow aria-hidden /> : <ArrowUpNarrowWide aria-hidden />}
              </Button>
            </Tip>
          </div>
        </div>

        {conversations.isError ? (
          <div className="p-4">
            <Notice tone="critical" title="Could not load conversations">
              {errorMessage(conversations.error)}
            </Notice>
          </div>
        ) : !data ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : data.total === 0 ? (
          <EmptyState icon={MessagesSquare} title={filtered ? "No conversations match these filters" : "No conversations yet"} action={filtered ? undefined : <ImportDialog />}>
            {filtered ? "Clear a filter or search for something else." : "Import a dataset group from the organizers’ API to begin."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-dense">
              <thead className="bg-sunken text-left text-2xs font-medium text-ink-3">
                <tr>
                  <th className="px-4 py-2 font-medium">Conversation</th>
                  <th className="px-3 py-2 font-medium">Lang</th>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 text-right font-medium">Lines</th>
                  <th className="px-3 py-2 text-right font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Group</th>
                  <th className="px-3 py-2 text-right font-medium">Score</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">
                    <span className="sr-only">Flags</span>
                  </th>
                </tr>
              </thead>
              <tbody className={cn(conversations.isFetching && conversations.isPlaceholderData && "opacity-60")}>
                {data.items.map((item) => {
                  const e = item.latest_evaluation;
                  return (
                    <tr key={item.id} className="border-t border-line hover:bg-hover">
                      <td className="max-w-[22rem] px-4 py-2">
                        <Link href={`/cqa/conversations/${encodeURIComponent(item.id)}`} className="font-mono text-xs text-accent-ink hover:underline">
                          {item.id}
                        </Link>
                        <p className="truncate text-xs text-ink-3" title={item.preview}>
                          {item.preview}
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <LanguageTag code={item.language} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <ChannelLabel channel={item.channel} />
                          {item.has_audio ? (
                            <Tip content="Has a call recording">
                              <Volume2 className="size-3.5 text-ink-3" aria-label="Has a recording" />
                            </Tip>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-2">{fmtNumber(item.message_count)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-2">{item.duration_seconds ? fmtDuration(item.duration_seconds) : "—"}</td>
                      <td className="px-3 py-2 text-xs text-ink-2">
                        <span className="inline-flex items-center gap-1.5">
                          {item.group_ids.join(", ")}
                          {item.source === "fixture" ? <FixtureBadge /> : null}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {e?.status === "completed" ? <ScoreChange original={e.original_total} final={e.final_total} max={e.max_score} /> : <span className="text-ink-3">—</span>}
                      </td>
                      <td className="px-3 py-2">{e ? <EvalStatusBadge status={e.status} /> : <NotEvaluatedBadge />}</td>
                      <td className="px-4 py-2">
                        <span className="flex items-center justify-end gap-1.5">
                          {e?.severe_errors ? (
                            <Tip content={`${e.severe_errors} severe error(s)`}>
                              <AlertOctagon className="size-4 text-critical" aria-label={`${e.severe_errors} severe errors`} />
                            </Tip>
                          ) : null}
                          {item.open_appeals ? (
                            <Tip content={`${item.open_appeals} open appeal(s)`}>
                              <Gavel className="size-4 text-warning" aria-label={`${item.open_appeals} open appeals`} />
                            </Tip>
                          ) : null}
                          {e?.is_mock ? <MockBadge /> : null}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-2xs text-ink-3">
            <span className="tabular-nums">
              {from}–{to} of {fmtNumber(data.total)} conversations
              {query.checklist_id ? " · scores from the selected checklist" : " · score of the latest result, after reviewer overrides"}
            </span>
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => update({ page: page - 1 }, false)}>
                <ChevronLeft aria-hidden />
                Previous
              </Button>
              <span className="px-1 tabular-nums">
                {page} / {pages}
              </span>
              <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => update({ page: page + 1 }, false)}>
                Next
                <ChevronRight aria-hidden />
              </Button>
            </span>
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
