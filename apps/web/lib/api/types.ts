/**
 * Friendly aliases over the generated OpenAPI types (`pnpm gen:api` rewrites schema.d.ts).
 * Request types are relaxed where the backend supplies defaults.
 */
import type { components } from "./schema";

type S = components["schemas"];

export type ColumnKind = S["ColumnInfo"]["kind"];
export type ColumnInfo = S["ColumnInfo"];
export type Filter = S["Filter"];
export type FilterOp = Filter["op"];
export type SortKey = S["SortKey"];
export type SourceMeta = S["SourceMeta"];
export type LabelValue = S["LabelValue"];
export type TableData = S["TableData"];
export type Health = S["Health"];

export type DatasetSummary = S["DatasetSummary"];
export type DatasetDetail = S["DatasetDetail"];
export type StagedPreview = S["StagedPreview"];
export type IngestOptions = Partial<S["IngestOptions"]>;
export type PreviewResponse = S["PreviewResponse"];
export type SampleInfo = S["SampleInfo"];
export type Lineage = S["Lineage"];

export type DatasetProfile = S["DatasetProfile"];
export type ColumnProfile = S["ColumnProfile"];
export type QualityFlag = S["QualityFlag"];
export type Correlation = S["Correlation"];

export type QueryRequest = Partial<S["QueryRequest"]>;
export type QueryResponse = S["QueryResponse"];
export type AggFn = S["Metric"]["agg"];
export type Metric = { column?: string | null; agg: AggFn };
export type AggregateRequest = { group_by: string[]; metrics: Metric[]; filters?: Filter[]; sort?: SortKey | null; limit?: number };
export type AggregateResponse = S["AggregateResponse"];

export type ChartType = S["ChartSpec"]["type"];
export type ChartSpec = Pick<S["ChartSpec"], "type"> & Partial<Omit<S["ChartSpec"], "type">>;
export type ChartData = S["ChartData"];
export type BoxStats = S["BoxStats"];
export type HeatmapData = S["HeatmapData"];

export type SplitConfig = Partial<S["SplitConfig"]>;
export type TransformOp = S["TransformStep"]["op"];
export type TransformStep = { op: TransformOp } & Partial<Omit<S["TransformStep"], "op">>;
export type TransformRequest = { steps: TransformStep[]; name?: string | null; split?: SplitConfig | null; preview?: boolean };
export type TransformResult = S["TransformResult"];
export type StepLog = S["StepLog"];

export type TaskType = S["ExperimentRequest"]["task"];
export type ModelName = S["ExperimentRequest"]["model"];
export type ModelOption = S["ModelOption"];
export type ModelCheckRequest = Pick<S["ModelCheckRequest"], "dataset_id" | "target"> &
  Partial<Omit<S["ModelCheckRequest"], "split">> & { split?: SplitConfig | null };
export type ModelCheckResponse = S["ModelCheckResponse"];
export type ModelWarning = S["ModelWarning"];
export type ExperimentRequest = Pick<S["ExperimentRequest"], "dataset_id" | "target" | "task" | "model"> &
  Partial<Omit<S["ExperimentRequest"], "split">> & { split?: SplitConfig };
export type ExperimentSummary = S["ExperimentSummary"];
export type ExperimentDetail = S["ExperimentDetail"];
export type MetricValue = S["MetricValue"];

export type EvidenceItem = S["EvidenceItem"];
export type Finding = S["Finding"];
export type FindingIn = Pick<S["FindingIn"], "title"> & Partial<S["FindingIn"]>;
export type FindingPatch = Partial<S["FindingPatch"]>;
export type PitchDeck = S["PitchDeck"];
export type PitchSlide = S["PitchSlide"];
export type SavedView = S["SavedView"];
export type SavedViewIn = S["SavedViewIn"];

export type AnalysisInfo = S["AnalysisInfo"];
export type AnalysisResult = S["AnalysisResult"];
export type ChallengeInfo = S["ChallengeInfo"];

export type Deleted = S["Deleted"];
