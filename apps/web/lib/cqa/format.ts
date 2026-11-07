/**
 * Pure CQA display helpers. No React, no fetching: everything here is unit-tested in tests/cqa.test.ts.
 * Scores are never computed here. The backend scoring engine is the only source of numbers; these helpers
 * only format what it returned.
 */
import type {
  AnswerValue,
  ChecklistConfig,
  ConversationQuery,
  Criterion,
  CriterionScore,
  EvaluationStatus,
  InspectedSpan,
  Message,
  Speaker,
} from "./types";

export const LANGUAGES: Record<string, string> = { RU: "Russian", KZ: "Kazakh", EN: "English" };

export function languageName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  return LANGUAGES[code] ?? code;
}

/** BCP-47 tag for a dataset language code (KZ is Kazakh: "kk"). */
export function languageTag(code: string | null | undefined): string | undefined {
  const tags: Record<string, string> = { RU: "ru", KZ: "kk", EN: "en" };
  return code ? tags[code] : undefined;
}

export const SPEAKER_LABEL: Record<Speaker, string> = {
  client: "Client",
  operator: "Operator",
  bot: "Bot",
  system: "System",
  unknown: "Unknown",
};

export const STATUS_LABEL: Record<EvaluationStatus, string> = {
  pending: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

export const ORIGIN_LABEL = {
  custom: "Custom",
  official: "Official",
  dev_sample: "Dev sample · unofficial",
} as const;

/** A score as shown in tables: one decimal at most, em dash when there is none. */
export function fmtScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

/** Points with up to two decimals: criterion points are rarely whole numbers after N/A redistribution. */
export function fmtPoints(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return (Math.round(value * 100) / 100).toString();
}

/** A fraction 0–1 as a whole percent. */
export function fmtShare(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

/** Seconds as m:ss (or h:mm:ss) for transcript offsets and the audio player. */
export function fmtClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The transcript timestamp as the source wrote it, shortened for ISO instants (keeps HH:MM:SS). */
export function fmtMessageTime(message: Pick<Message, "timestamp" | "offset_seconds" | "at">): string {
  if (message.at) {
    const match = /T(\d{2}:\d{2}:\d{2})/.exec(message.at);
    if (match) return match[1];
  }
  return message.timestamp;
}

export type Outcome = "met" | "partial" | "missed" | "na" | "invalid" | "missing";

/** What a criterion score means for a reader. Uses the engine's normalized value; never recomputes points. */
export function outcomeOf(score: Pick<CriterionScore, "status" | "normalized"> | null | undefined): Outcome {
  if (!score || score.status === "missing") return "missing";
  if (score.status === "na") return "na";
  if (score.status === "invalid") return "invalid";
  const n = score.normalized ?? 0;
  if (n >= 1) return "met";
  if (n <= 0) return "missed";
  return "partial";
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  met: "Met",
  partial: "Partial",
  missed: "Not met",
  na: "N/A",
  invalid: "Invalid",
  missing: "Missing",
};

/** The answer in the checklist's own terms: Yes/No, "4 of 0–5 (label)", or the option label. */
export function answerLabel(criterion: Criterion, value: AnswerValue | undefined, isNa = false): string {
  if (isNa) return "Not applicable";
  if (value === null || value === undefined) return "—";
  const type = criterion.answer_type ?? "binary";
  if (type === "binary") return value === true ? "Yes" : value === false ? "No" : String(value);
  if (type === "scale") {
    const scale = criterion.scale;
    const label = scale?.labels?.[String(value)];
    return `${value} on ${scale?.min ?? 0}–${scale?.max ?? 5}${label ? ` · ${label}` : ""}`;
  }
  const option = criterion.options?.find((o) => o.id === value);
  return option ? option.label : String(value);
}

/** Every value a reviewer may pick for a criterion, in checklist order. */
export function answerChoices(criterion: Criterion): { value: boolean | number | string; label: string }[] {
  const type = criterion.answer_type ?? "binary";
  if (type === "binary") {
    return [
      { value: true, label: "Yes" },
      { value: false, label: "No" },
    ];
  }
  if (type === "options") return (criterion.options ?? []).map((o) => ({ value: o.id, label: `${o.label} (${o.points} pts)` }));
  return scalePoints(criterion).map((v) => ({ value: v, label: answerLabel(criterion, v) }));
}

/** The allowed points of a scale, matching the backend's ScaleConfig.points(). */
export function scalePoints(criterion: Pick<Criterion, "scale">): number[] {
  const min = criterion.scale?.min ?? 0;
  const max = criterion.scale?.max ?? 5;
  const step = criterion.scale?.step ?? 1;
  if (!(step > 0) || max <= min) return [];
  const count = Math.floor((max - min) / step + 1e-9);
  return Array.from({ length: Math.min(count, 100) + 1 }, (_, i) => Number((min + i * step).toFixed(6)));
}

/** A short description of how a criterion is answered, for the checklist table. */
export function answerTypeSummary(criterion: Criterion): string {
  const type = criterion.answer_type ?? "binary";
  if (type === "binary") return "Yes / No";
  if (type === "scale") {
    const s = criterion.scale;
    return `Scale ${s?.min ?? 0}–${s?.max ?? 5}${(s?.step ?? 1) !== 1 ? ` step ${s?.step}` : ""}`;
  }
  return `${criterion.options?.length ?? 0} options`;
}

/** Message ids covered by inspected spans (a span is inclusive at both ends, by transcript index). */
export function spanMessageIds(spans: InspectedSpan[] | undefined, messages: Pick<Message, "id" | "index">[]): Set<string> {
  const ids = new Set<string>();
  for (const span of spans ?? []) {
    for (const message of messages) {
      if (message.index >= span.start_index && message.index <= span.end_index) ids.add(message.id);
    }
  }
  return ids;
}

/** Split a message's text around a matched evidence range, for highlighting. Falls back to no highlight. */
export function splitHighlight(text: string, start: number | null | undefined, end: number | null | undefined): [string, string, string] {
  if (start === null || start === undefined || end === null || end === undefined) return [text, "", ""];
  if (start < 0 || end > text.length || start >= end) return [text, "", ""];
  return [text.slice(0, start), text.slice(start, end), text.slice(end)];
}

/** Query string for the conversations endpoint: arrays repeat the key, empty values are left out. */
export function conversationQueryString(query: ConversationQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== "") params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Total weight → each criterion's configured share, as the editor shows it (before any N/A redistribution). */
export function weightShares(criteria: Pick<Criterion, "id" | "weight">[]): Record<string, number> {
  const total = criteria.reduce((sum, c) => sum + (Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0), 0);
  return Object.fromEntries(criteria.map((c) => [c.id, total > 0 ? c.weight / total : 0]));
}

/** Validates a criterion id the same way the backend does (CRITERION_ID_PATTERN). */
export const CRITERION_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** Turn a name into a criterion id candidate: "Greets the client" → "greets_the_client". */
export function criterionIdFrom(name: string): string {
  const id = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return id || "criterion";
}

/** First id not already taken: base, base_2, base_3 … */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base.slice(0, 44)}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base.slice(0, 40)}_${Date.now() % 100000}`;
}

/** Move an item one step up (-1) or down (+1); returns a new array, unchanged when out of range. */
export function moveItem<T>(items: T[], index: number, step: -1 | 1): T[] {
  const target = index + step;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = items.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * Problems with a criterion before it is sent, mirroring the backend's Criterion / ScaleConfig / AnswerOption
 * validation (the backend still validates everything; this only gives immediate feedback in the editor).
 */
export function criterionIssues(criterion: Criterion, takenIds: Iterable<string> = []): string[] {
  const issues: string[] = [];
  const taken = new Set(takenIds);
  if (!CRITERION_ID.test(criterion.id)) issues.push("Id: lowercase letters, digits, _ or -, starting with a letter or digit (max 48).");
  else if (taken.has(criterion.id)) issues.push(`Id “${criterion.id}” is already used in this checklist.`);
  if (!criterion.name.trim()) issues.push("Name is required.");
  if (!(criterion.weight > 0) || criterion.weight > 1000) issues.push("Weight must be greater than 0 and at most 1000.");
  const type = criterion.answer_type ?? "binary";
  if (type === "scale") {
    const min = criterion.scale?.min ?? 0;
    const max = criterion.scale?.max ?? 5;
    const step = criterion.scale?.step ?? 1;
    if (!(max > min)) issues.push("Scale maximum must be greater than the minimum.");
    else if (!(step > 0)) issues.push("Scale step must be positive.");
    else {
      const points = (max - min) / step;
      if (Math.abs(points - Math.round(points)) > 1e-9) issues.push("(max − min) must be a whole number of steps.");
      else if (Math.round(points) > 100) issues.push("A scale may have at most 101 points.");
    }
  }
  if (type === "options") {
    const options = criterion.options ?? [];
    if (options.length < 2) issues.push("An options answer needs at least two options.");
    if (options.length > 12) issues.push("At most 12 options.");
    if (new Set(options.map((o) => o.id)).size !== options.length) issues.push("Option ids must be unique.");
    if (options.some((o) => !CRITERION_ID.test(o.id))) issues.push("Option ids: lowercase letters, digits, _ or -.");
    if (options.some((o) => !o.label.trim())) issues.push("Every option needs a label.");
    if (options.some((o) => !(o.points >= 0) || o.points > 1000)) issues.push("Option points must be between 0 and 1000.");
    if (options.length && Math.max(...options.map((o) => o.points)) <= 0) issues.push("At least one option must score above zero.");
  }
  return issues;
}

/** A sensible new criterion: binary, weight 10, no section. */
export function blankCriterion(takenIds: Iterable<string>, sectionId: string | null = null): Criterion {
  return {
    id: uniqueId("new_criterion", takenIds),
    name: "",
    description: "",
    section_id: sectionId,
    weight: 10,
    answer_type: "binary",
    scale: null,
    options: null,
    na_allowed: false,
    na_rule: "",
    severe_error_enabled: false,
    severe_error_rule: "",
  };
}

/** Drops the fields that do not apply to the answer type, as the backend would. */
export function normalizeCriterion(criterion: Criterion): Criterion {
  const type = criterion.answer_type ?? "binary";
  return {
    ...criterion,
    name: criterion.name.trim(),
    scale: type === "scale" ? (criterion.scale ?? { min: 0, max: 5, step: 1 }) : null,
    options: type === "options" ? (criterion.options ?? []) : null,
    na_rule: criterion.na_allowed ? (criterion.na_rule ?? "") : "",
    severe_error_rule: criterion.severe_error_enabled ? (criterion.severe_error_rule ?? "") : "",
  };
}

/** Accepts an ATLAS checklist export ({format, name, config}) or a bare configuration ({criteria, sections, scoring}). */
export function parseChecklistFile(
  text: string,
  fallbackName: string,
): { name: string; description: string; origin: "custom" | "official" | "dev_sample"; config: ChecklistConfig } {
  const data = JSON.parse(text) as Record<string, unknown>;
  if (!data || typeof data !== "object") throw new Error("The file is not a JSON object.");
  const config = (data.config ?? data) as ChecklistConfig;
  if (!config || !Array.isArray(config.criteria)) throw new Error("The file has no criteria list.");
  const origin = data.origin === "official" || data.origin === "dev_sample" ? data.origin : "custom";
  return {
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : fallbackName,
    description: typeof data.description === "string" ? data.description : "",
    origin,
    config: { sections: config.sections ?? [], criteria: config.criteria, ...(config.scoring ? { scoring: config.scoring } : {}) },
  };
}
