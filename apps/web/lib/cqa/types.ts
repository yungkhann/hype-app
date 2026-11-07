/**
 * Aliases over the generated OpenAPI types for the CQA API (`pnpm gen:api` rewrites schema.d.ts).
 * Request types are relaxed where the backend supplies defaults.
 */
import type { components } from "@/lib/api/schema";

type S = components["schemas"];

export type Speaker = S["Message"]["speaker"];
export type Channel = S["ConversationSummary"]["channel"];
export type ConversationSource = S["ConversationSummary"]["source"];
export type Message = S["Message"];
export type Facet = S["Facet"];
export type ConversationSummary = S["ConversationSummary"];
export type ConversationDetail = S["ConversationDetail"];
export type ConversationPage = Omit<S["ConversationPage"], "facets"> & { facets: Record<string, Facet[]> };
export type ImportRun = S["ImportRun"];
export type ImportIssue = S["ImportIssue"];
export type AudioInfo = S["AudioInfo"];

export type AnswerType = NonNullable<S["Criterion"]["answer_type"]>;
export type RoundingMode = NonNullable<S["RoundingRule"]["mode"]>;
export type ChecklistOrigin = NonNullable<S["Checklist"]["origin"]>;
export type ScaleConfig = S["ScaleConfig"];
export type AnswerOption = S["AnswerOption"];
export type Criterion = S["Criterion"];
export type Section = S["Section"];
export type ScoringRules = S["ScoringRules"];
export type ChecklistConfig = S["ChecklistConfig"];
export type ChecklistVersion = S["ChecklistVersion"];
export type Checklist = S["Checklist"];
export type ChecklistSummary = S["ChecklistSummary"];
export type Replacement = S["Replacement"];

export type EvaluationStatus = S["EvaluationBrief"]["status"];
export type EvaluationBrief = S["EvaluationBrief"];
export type EvaluationSummary = S["EvaluationSummary"];
export type EvaluationPage = S["EvaluationPage"];
export type EvaluationRecord = S["EvaluationRecord"];
export type EvaluationDetail = S["EvaluationDetail"];
export type EvaluatorInfo = S["EvaluatorInfo"];
export type CriterionView = S["CriterionView"];
export type CriterionResult = S["CriterionResult"];
export type CriterionScore = S["CriterionScore"];
export type ScoreBreakdown = S["ScoreBreakdown"];
export type SectionScore = S["SectionScore"];
export type EvidenceRef = S["EvidenceRef"];
export type InspectedSpan = S["InspectedSpan"];
export type AnswerValue = CriterionResult["value"];
export type EvaluateRequest = S["EvaluateRequest"];
export type EvaluateResponse = S["EvaluateResponse"];
export type BatchStatus = S["BatchStatus"];

export type AppealStatus = S["Appeal"]["status"];
export type Appeal = S["Appeal"];
export type AppealDetail = S["AppealDetail"];
export type AppealCreate = S["AppealCreate"];
export type AppealDecisionIn = S["AppealDecisionIn"];
export type OverrideAnswer = S["OverrideAnswer"];
export type AuditEvent = S["AuditEvent"];

export type Overview = S["Overview"];
export type CriterionStat = S["CriterionStat"];
export type ScoreBin = S["ScoreBin"];
export type CqaInfo = S["CqaInfo"];

export type ConversationStatusFilter = "not_evaluated" | "pending" | "running" | "completed" | "failed" | "appealed";
export type ConversationSort = "id" | "imported_at" | "score" | "messages" | "duration" | "language" | "channel" | "evaluated_at";

export type ConversationQuery = {
  q?: string;
  language?: string[];
  channel?: Channel[];
  status?: ConversationStatusFilter[];
  group_id?: string;
  source?: ConversationSource;
  min_score?: number;
  max_score?: number;
  checklist_id?: string;
  sort?: ConversationSort;
  desc?: boolean;
  page?: number;
  page_size?: number;
};
