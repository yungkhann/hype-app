"use client";

/**
 * TanStack Query hooks for the CQA API (/api/v1/cqa). Every query key starts with "cqa", so a mutation
 * refreshes all CQA views with one invalidation. Views poll only while something is pending or running.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { conversationQueryString } from "./format";
import type {
  Appeal,
  AppealCreate,
  AppealDecisionIn,
  AppealDetail,
  AppealStatus,
  AudioInfo,
  AuditEvent,
  BatchStatus,
  Checklist,
  ChecklistConfig,
  ChecklistOrigin,
  ChecklistSummary,
  ConversationDetail,
  ConversationPage,
  ConversationQuery,
  CqaInfo,
  Criterion,
  EvaluateRequest,
  EvaluateResponse,
  EvaluationDetail,
  EvaluationPage,
  EvaluationStatus,
  ImportRun,
  Overview,
} from "./types";

const BASE = "/cqa";
const ACTIVE: EvaluationStatus[] = ["pending", "running"];
const POLL_MS = 1_200;

export const cqaKeys = {
  all: ["cqa"] as const,
  info: ["cqa", "info"] as const,
  overview: (checklistId?: string) => ["cqa", "overview", checklistId ?? "auto"] as const,
  imports: ["cqa", "imports"] as const,
  conversations: (query: ConversationQuery) => ["cqa", "conversations", query] as const,
  conversation: (id: string) => ["cqa", "conversation", id] as const,
  checklists: (archived: boolean) => ["cqa", "checklists", archived] as const,
  checklist: (id: string) => ["cqa", "checklist", id] as const,
  evaluations: (query: EvaluationQuery) => ["cqa", "evaluations", query] as const,
  evaluation: (id: string) => ["cqa", "evaluation", id] as const,
  batch: (id: string) => ["cqa", "batch", id] as const,
  appeals: (query: AppealQuery) => ["cqa", "appeals", query] as const,
  appeal: (id: string) => ["cqa", "appeal", id] as const,
  audit: (query: AuditQuery) => ["cqa", "audit", query] as const,
};

export type EvaluationQuery = {
  conversation_id?: string;
  checklist_id?: string;
  status?: EvaluationStatus;
  batch_id?: string;
  mock?: boolean;
  page?: number;
  page_size?: number;
};
export type AppealQuery = { status?: AppealStatus; evaluation_id?: string; conversation_id?: string };
export type AuditQuery = { conversation_id?: string; evaluation_id?: string; checklist_id?: string; appeal_id?: string; limit?: number };

function qs(params: Record<string, unknown>): string {
  return conversationQueryString(params as ConversationQuery);
}

function useInvalidateCqa() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: cqaKeys.all });
}

/* ---------- info, overview, imports ---------- */

export function useCqaInfo() {
  return useQuery({ queryKey: cqaKeys.info, queryFn: () => api<CqaInfo>(`${BASE}/info`), staleTime: 30_000 });
}

export function useOverview(checklistId?: string) {
  return useQuery({
    queryKey: cqaKeys.overview(checklistId),
    queryFn: () => api<Overview>(`${BASE}/overview${qs({ checklist_id: checklistId })}`),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const statuses = query.state.data?.evaluations_by_status ?? [];
      return statuses.some((f) => ACTIVE.includes(f.value as EvaluationStatus) && f.count > 0) ? POLL_MS * 2 : false;
    },
  });
}

export function useImports() {
  return useQuery({ queryKey: cqaKeys.imports, queryFn: () => api<ImportRun[]>(`${BASE}/imports`) });
}

export function useImportGroup() {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: (body: { group_id: string; source?: "organizer_api" | "fixture" }) =>
      api<ImportRun>(`${BASE}/imports`, { body }),
    onSettled: invalidate,
  });
}

/* ---------- conversations ---------- */

export function useConversations(query: ConversationQuery) {
  return useQuery({
    queryKey: cqaKeys.conversations(query),
    queryFn: ({ signal }) => api<ConversationPage>(`${BASE}/conversations${conversationQueryString(query)}`, { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) =>
      q.state.data?.items.some((c) => c.latest_evaluation && ACTIVE.includes(c.latest_evaluation.status)) ? POLL_MS : false,
  });
}

export function useConversation(id: string | null | undefined) {
  return useQuery({
    queryKey: cqaKeys.conversation(id ?? ""),
    queryFn: () => api<ConversationDetail>(`${BASE}/conversations/${encodeURIComponent(id!)}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.evaluations.some((e) => ACTIVE.includes(e.status)) ? POLL_MS : false),
  });
}

/** Resolved lazily and kept apart from the "cqa" prefix: the signed stream URL must not reload on every mutation. */
export function useAudio(id: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["cqa-audio", id ?? ""],
    queryFn: () => api<AudioInfo>(`${BASE}/conversations/${encodeURIComponent(id!)}/audio`),
    enabled: !!id && enabled,
    staleTime: 8 * 60_000,
    retry: 0,
  });
}

/* ---------- checklists ---------- */

export function useChecklists(includeArchived = false) {
  return useQuery({
    queryKey: cqaKeys.checklists(includeArchived),
    queryFn: () => api<ChecklistSummary[]>(`${BASE}/checklists${qs({ include_archived: includeArchived || undefined })}`),
  });
}

export function useChecklist(id: string | null | undefined) {
  return useQuery({
    queryKey: cqaKeys.checklist(id ?? ""),
    queryFn: () => api<Checklist>(`${BASE}/checklists/${id}`),
    enabled: !!id,
  });
}

export function useCreateChecklist() {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: (body: { name: string; description?: string; origin?: ChecklistOrigin; config: ChecklistConfig; note?: string }) =>
      api<Checklist>(`${BASE}/checklists`, { body }),
    onSuccess: invalidate,
  });
}

export function useCreateDevChecklist() {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: () => api<Checklist>(`${BASE}/checklists/dev-sample`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useImportChecklist() {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: (body: { name: string; description?: string; origin?: ChecklistOrigin; config: ChecklistConfig }) =>
      api<Checklist>(`${BASE}/checklists/import`, { body }),
    onSuccess: invalidate,
  });
}

export type ChecklistPatch = {
  base_version: number;
  name?: string;
  description?: string;
  origin?: ChecklistOrigin;
  archived?: boolean;
  config?: ChecklistConfig;
  note?: string;
};

export function useUpdateChecklist(id: string) {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: (body: ChecklistPatch) => api<Checklist>(`${BASE}/checklists/${id}`, { method: "PUT", body }),
    onSuccess: invalidate,
  });
}

export function useReplaceCriterion(id: string) {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: ({ criterionId, ...body }: { criterionId: string; base_version: number; criterion: Criterion; note?: string }) =>
      api<Checklist>(`${BASE}/checklists/${id}/criteria/${encodeURIComponent(criterionId)}/replace`, { body }),
    onSuccess: invalidate,
  });
}

export function useDuplicateChecklist(id: string) {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: (body: { name?: string; version?: number }) => api<Checklist>(`${BASE}/checklists/${id}/duplicate`, { body }),
    onSuccess: invalidate,
  });
}

export function useDeleteChecklist() {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: (id: string) => api<{ id: string }>(`${BASE}/checklists/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

/* ---------- evaluations ---------- */

export function useEvaluate() {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: (body: EvaluateRequest) => api<EvaluateResponse>(`${BASE}/evaluations`, { body }),
    onSuccess: invalidate,
  });
}

export function useRerun() {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: (evaluationId: string) => api<EvaluateResponse>(`${BASE}/evaluations/${evaluationId}/rerun`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function useEvaluations(query: EvaluationQuery) {
  return useQuery({
    queryKey: cqaKeys.evaluations(query),
    queryFn: () => api<EvaluationPage>(`${BASE}/evaluations${qs(query)}`),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((e) => ACTIVE.includes(e.status)) ? POLL_MS : false),
  });
}

export function useEvaluation(id: string | null | undefined) {
  return useQuery({
    queryKey: cqaKeys.evaluation(id ?? ""),
    queryFn: () => api<EvaluationDetail>(`${BASE}/evaluations/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.evaluation.status) ? POLL_MS : false),
  });
}

/** Polls a batch until it is done, then refreshes every CQA view once. */
export function useBatch(id: string | null | undefined) {
  const client = useQueryClient();
  return useQuery({
    queryKey: cqaKeys.batch(id ?? ""),
    queryFn: async () => {
      const status = await api<BatchStatus>(`${BASE}/evaluations/batches/${id}`);
      if (status.done) void client.invalidateQueries({ queryKey: cqaKeys.all, predicate: (q) => q.queryKey[1] !== "batch" });
      return status;
    },
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.done ? false : POLL_MS),
  });
}

/* ---------- appeals & audit ---------- */

export function useAppeals(query: AppealQuery = {}) {
  return useQuery({ queryKey: cqaKeys.appeals(query), queryFn: () => api<Appeal[]>(`${BASE}/appeals${qs(query)}`) });
}

export function useAppeal(id: string | null | undefined) {
  return useQuery({
    queryKey: cqaKeys.appeal(id ?? ""),
    queryFn: () => api<AppealDetail>(`${BASE}/appeals/${id}`),
    enabled: !!id,
  });
}

export function useCreateAppeal() {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: (body: AppealCreate) => api<Appeal>(`${BASE}/appeals`, { body }),
    onSuccess: invalidate,
  });
}

export function useDecideAppeal(id: string) {
  const invalidate = useInvalidateCqa();
  return useMutation({
    mutationFn: (body: AppealDecisionIn) => api<Appeal>(`${BASE}/appeals/${id}/decision`, { body }),
    onSuccess: invalidate,
  });
}

export function useAudit(query: AuditQuery, enabled = true) {
  return useQuery({
    queryKey: cqaKeys.audit(query),
    queryFn: () => api<AuditEvent[]>(`${BASE}/audit${qs(query)}`),
    enabled,
  });
}

/** Absolute URL of the checklist export (served as an attachment by the API). */
export function checklistExportPath(id: string, version?: number) {
  return `${BASE}/checklists/${id}/export${qs({ version })}`;
}
