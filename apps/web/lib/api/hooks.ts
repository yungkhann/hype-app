"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type {
  AggregateRequest,
  AggregateResponse,
  AnalysisInfo,
  AnalysisResult,
  ChallengeInfo,
  ChartData,
  ChartSpec,
  DatasetDetail,
  DatasetProfile,
  DatasetSummary,
  Deleted,
  ExperimentDetail,
  ExperimentRequest,
  ExperimentSummary,
  Filter,
  Finding,
  FindingIn,
  FindingPatch,
  Health,
  ModelCheckRequest,
  ModelCheckResponse,
  ModelOption,
  PitchDeck,
  PreviewResponse,
  QueryRequest,
  QueryResponse,
  SampleInfo,
  SavedView,
  SavedViewIn,
  TransformRequest,
  TransformResult,
} from "./types";

export const keys = {
  health: ["health"] as const,
  datasets: ["datasets"] as const,
  dataset: (id: string) => ["dataset", id] as const,
  profile: (id: string) => ["profile", id] as const,
  preview: (id: string) => ["preview", id] as const,
  samples: ["samples"] as const,
  query: (id: string, body: QueryRequest) => ["query", id, body] as const,
  aggregate: (id: string, body: AggregateRequest) => ["aggregate", id, body] as const,
  chart: (id: string, spec: ChartSpec) => ["chart", id, spec] as const,
  analyses: ["analyses"] as const,
  models: ["models"] as const,
  experiments: (datasetId?: string) => ["experiments", datasetId ?? "all"] as const,
  experiment: (id: string) => ["experiment", id] as const,
  findings: ["findings"] as const,
  pitch: ["pitch"] as const,
  views: (datasetId: string) => ["views", datasetId] as const,
  challenge: ["challenge"] as const,
};

/* ---------- system ---------- */

export function useHealth() {
  return useQuery({
    queryKey: keys.health,
    queryFn: () => api<Health>("/health"),
    staleTime: 60_000,
    retry: 1,
    refetchInterval: (query) => (query.state.status === "error" ? 5_000 : false),
  });
}

/* ---------- datasets ---------- */

export function useDatasets() {
  return useQuery({ queryKey: keys.datasets, queryFn: () => api<DatasetSummary[]>("/datasets") });
}

export function useDataset(id: string | null | undefined) {
  return useQuery({
    queryKey: keys.dataset(id ?? ""),
    queryFn: () => api<DatasetDetail>(`/datasets/${id}`),
    enabled: Boolean(id),
    retry: (count, error) => (error as { status?: number }).status !== 404 && count < 2,
  });
}

export function useProfile(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.profile(id ?? ""),
    queryFn: () => api<DatasetProfile>(`/datasets/${id}/profile`),
    enabled: Boolean(id) && enabled,
    staleTime: Infinity,
  });
}

export function useSamples() {
  return useQuery({ queryKey: keys.samples, queryFn: () => api<SampleInfo[]>("/datasets/samples"), staleTime: Infinity });
}

export function usePreview(id: string | null | undefined) {
  return useQuery({
    queryKey: keys.preview(id ?? ""),
    queryFn: () => api<PreviewResponse>(`/datasets/${id}/preview`),
    enabled: Boolean(id),
  });
}

export function useInvalidateDatasets() {
  const client = useQueryClient();
  return (id?: string) => {
    void client.invalidateQueries({ queryKey: keys.datasets });
    if (id) {
      void client.invalidateQueries({ queryKey: keys.dataset(id) });
      void client.invalidateQueries({ queryKey: keys.profile(id) });
      void client.invalidateQueries({ queryKey: keys.preview(id) });
      void client.invalidateQueries({ queryKey: ["query", id] });
      void client.invalidateQueries({ queryKey: ["aggregate", id] });
      void client.invalidateQueries({ queryKey: ["chart", id] });
    }
  };
}

export function useLoadSample() {
  const invalidate = useInvalidateDatasets();
  return useMutation({
    mutationFn: (filename: string) => api<DatasetDetail>(`/datasets/samples/${encodeURIComponent(filename)}`, { method: "POST" }),
    onSuccess: (detail) => invalidate(detail.id),
  });
}

export function useDeleteDataset() {
  const invalidate = useInvalidateDatasets();
  return useMutation({
    mutationFn: (id: string) => api<Deleted>(`/datasets/${id}`, { method: "DELETE" }),
    onSuccess: (result) => invalidate(result.id),
  });
}

export function useRenameDataset() {
  const invalidate = useInvalidateDatasets();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api<DatasetDetail>(`/datasets/${id}`, { method: "PATCH", body: { name } }),
    onSuccess: (detail) => invalidate(detail.id),
  });
}

export function useRefreshProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<DatasetProfile>(`/datasets/${id}/profile/refresh`, { method: "POST" }),
    onSuccess: (profile) => client.setQueryData(keys.profile(profile.dataset_id), profile),
  });
}

/* ---------- analysis ---------- */

export function useQueryRows(id: string | null | undefined, body: QueryRequest) {
  return useQuery({
    queryKey: keys.query(id ?? "", body),
    queryFn: ({ signal }) => api<QueryResponse>(`/datasets/${id}/query`, { body, signal }),
    enabled: Boolean(id),
    placeholderData: keepPreviousData,
  });
}

export function useAggregate(id: string | null | undefined, body: AggregateRequest | null) {
  return useQuery({
    queryKey: keys.aggregate(id ?? "", body ?? { group_by: [], metrics: [] }),
    queryFn: ({ signal }) => api<AggregateResponse>(`/datasets/${id}/aggregate`, { body: body!, signal }),
    enabled: Boolean(id) && Boolean(body?.group_by.length),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useChart(id: string | null | undefined, spec: ChartSpec | null) {
  return useQuery({
    queryKey: keys.chart(id ?? "", spec ?? { type: "bar" }),
    queryFn: ({ signal }) => api<ChartData>(`/datasets/${id}/visualize`, { body: spec!, signal }),
    enabled: Boolean(id) && Boolean(spec),
    retry: false,
    staleTime: 30_000,
  });
}

export function fetchChart(id: string, spec: ChartSpec) {
  return api<ChartData>(`/datasets/${id}/visualize`, { body: spec });
}

export function useTransform() {
  const invalidate = useInvalidateDatasets();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: TransformRequest }) =>
      api<TransformResult>(`/datasets/${id}/transform`, { body }),
    onSuccess: (result) => {
      if (!result.preview && result.dataset_id) invalidate(result.dataset_id);
    },
  });
}

export function useAnalyses() {
  return useQuery({ queryKey: keys.analyses, queryFn: () => api<AnalysisInfo[]>("/analyses"), staleTime: Infinity });
}

export function useRunAnalysis() {
  return useMutation({
    mutationFn: ({ datasetId, analysisId, params, filters }: { datasetId: string; analysisId: string; params: Record<string, unknown>; filters?: Filter[] }) =>
      api<AnalysisResult>(`/datasets/${datasetId}/analyses/${encodeURIComponent(analysisId)}`, {
        body: { params, filters: filters ?? [] },
      }),
  });
}

export function useChallenge() {
  return useQuery({ queryKey: keys.challenge, queryFn: () => api<ChallengeInfo>("/challenge/info") });
}

/* ---------- models ---------- */

export function useModels() {
  return useQuery({ queryKey: keys.models, queryFn: () => api<ModelOption[]>("/models"), staleTime: Infinity });
}

export function useModelCheck(body: ModelCheckRequest | null) {
  return useQuery({
    queryKey: ["model-check", body],
    queryFn: ({ signal }) => api<ModelCheckResponse>("/experiments/check", { body: body!, signal }),
    enabled: Boolean(body?.dataset_id && body?.target),
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useExperiments(datasetId?: string | null) {
  return useQuery({
    queryKey: keys.experiments(datasetId ?? undefined),
    queryFn: () => api<ExperimentSummary[]>(`/experiments${datasetId ? `?dataset_id=${datasetId}` : ""}`),
    refetchInterval: (query) =>
      query.state.data?.some((e) => e.status === "queued" || e.status === "running") ? 1_500 : false,
  });
}

export function useExperiment(id: string | null | undefined) {
  return useQuery({
    queryKey: keys.experiment(id ?? ""),
    queryFn: () => api<ExperimentDetail>(`/experiments/${id}`),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "queued" || status === "running" ? 1_000 : false;
    },
  });
}

export function useStartExperiment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ExperimentRequest) => api<ExperimentDetail>("/experiments", { body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["experiments"] }),
  });
}

export function useDeleteExperiment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Deleted>(`/experiments/${id}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["experiments"] }),
  });
}

/* ---------- findings, pitch, views ---------- */

export function useFindings() {
  return useQuery({ queryKey: keys.findings, queryFn: () => api<Finding[]>("/findings") });
}

export function useCreateFinding() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: FindingIn) => api<Finding>("/findings", { body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.findings }),
  });
}

export function useUpdateFinding() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: FindingPatch }) =>
      api<Finding>(`/findings/${id}`, { method: "PATCH", body: patch }),
    onSuccess: (finding) =>
      client.setQueryData<Finding[]>(keys.findings, (list) => list?.map((f) => (f.id === finding.id ? finding : f))),
  });
}

export function useDeleteFinding() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Deleted>(`/findings/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.findings });
      void client.invalidateQueries({ queryKey: keys.pitch });
    },
  });
}

export function useReorderFindings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => api<Finding[]>("/findings/order", { method: "PUT", body: { ids } }),
    onMutate: async (ids) => {
      await client.cancelQueries({ queryKey: keys.findings });
      const previous = client.getQueryData<Finding[]>(keys.findings);
      if (previous) {
        const byId = new Map(previous.map((f) => [f.id, f]));
        client.setQueryData(keys.findings, ids.map((id) => byId.get(id)).filter(Boolean));
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) client.setQueryData(keys.findings, context.previous);
    },
    onSuccess: (list) => client.setQueryData(keys.findings, list),
  });
}

export function usePitch() {
  return useQuery({ queryKey: keys.pitch, queryFn: () => api<PitchDeck>("/pitch") });
}

export function useSavePitch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (deck: PitchDeck) => api<PitchDeck>("/pitch", { method: "PUT", body: deck }),
    onSuccess: (deck) => client.setQueryData(keys.pitch, deck),
  });
}

export function useViews(datasetId: string | null | undefined) {
  return useQuery({
    queryKey: keys.views(datasetId ?? ""),
    queryFn: () => api<SavedView[]>(`/views?dataset_id=${datasetId}`),
    enabled: Boolean(datasetId),
  });
}

export function useSaveView() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SavedViewIn) => api<SavedView>("/views", { body }),
    onSuccess: (view) => void client.invalidateQueries({ queryKey: keys.views(view.dataset_id) }),
  });
}

export function useDeleteView() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<Deleted>(`/views/${id}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["views"] }),
  });
}
