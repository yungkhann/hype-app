// Checklist configuration in the backend's shape (/api/v1/cqa/checklists) and the conversions to the shape the
// browser-side views and mock scorer use. The backend owns checklists and their immutable versions; the browser
// keeps the applied version (state.checklistConfig) and, while the manager edits, an unsaved draft
// (state.checklistDraft) that "Save checklist" stores as the next version.

import { defaultChecklist } from "./data.js?v=tape2";
import { t } from "./i18n.js?v=tape6";

export const CRITERION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const MAX_ALLOWED_SCORES = 101;
const MAX_SCORE_VALUE = 10_000;

/** 20 → "20", 12.5 → "12.5", 0.30000000000000004 → "0.3". */
export function fmt(value) {
  return String(Math.round(Number(value) * 1e6) / 1e6);
}

/** Sum of weights without float drift (33.3 + 33.3 + 33.4 is exactly 100). */
export function weightSum(weights) {
  return weights.reduce((sum, w) => sum + Math.round(Number(w) * 1e6), 0) / 1e6;
}

/** JSON with sorted keys, so two configurations compare equal whatever order their keys were written in. */
export function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The points of a min/max/step scale, or null when it is not a whole number of steps or has over 101 points. */
export function scalePoints(scale) {
  const min = Number(scale?.min ?? 0);
  const max = Number(scale?.max ?? 0);
  const step = Number(scale?.step ?? 1);
  if (!(step > 0) || !(max > min)) return null;
  const count = (max - min) / step;
  if (Math.abs(count - Math.round(count)) > 1e-9 || Math.round(count) + 1 > MAX_ALLOWED_SCORES) return null;
  return Array.from({ length: Math.round(count) + 1 }, (_, i) => Math.round((min + i * step) * 1e10) / 1e10);
}

/** A scale that starts at 0 and has no labels scores exactly like a numeric criterion with the same points. */
export function scaleAsScores(criterion) {
  const scale = criterion.scale;
  if (criterion.answer_type !== "scale" || !scale || Number(scale.min) !== 0) return null;
  if (scale.labels && Object.keys(scale.labels).length) return null;
  return scalePoints(scale);
}

export function isIndicator(criterion) {
  return Number(criterion.weight) === 0 && !!criterion.severe_error_enabled && criterion.answer_type === "binary";
}

export function sectionName(config, sectionId) {
  return config.sections?.find((s) => s.id === sectionId)?.name ?? "";
}

/**
 * Parse "0, 5, 10, 15, 20" (commas, semicolons or spaces). Returns {scores} or {error}. The rules match the
 * backend's: at least two numbers from 0 to 10000, no duplicates, lowest to highest, highest above 0.
 */
export function parseAllowedScores(text) {
  const tokens = String(text ?? "").split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return { error: t("scores.empty") };
  const scores = [];
  for (const token of tokens) {
    if (/^-\d/.test(token)) return { error: t("scores.negative") };
    if (!/^\d+(\.\d+)?$/.test(token)) return { error: t("scores.notNumber", { token }) };
    scores.push(Number(token));
  }
  if (scores.length < 2) return { error: t("scores.tooFew") };
  if (scores.length > MAX_ALLOWED_SCORES) return { error: t("scores.tooMany", { max: MAX_ALLOWED_SCORES }) };
  const twice = scores.find((s, i) => scores.indexOf(s) !== i);
  if (twice !== undefined) return { error: t("scores.duplicate", { score: fmt(twice) }) };
  if (scores.some((s) => s > MAX_SCORE_VALUE)) return { error: t("scores.tooHigh", { max: MAX_SCORE_VALUE }) };
  if (scores.some((s, i) => i > 0 && s < scores[i - 1])) {
    const sorted = [...scores].sort((a, b) => a - b).map(fmt).join(", ");
    return { error: t("scores.order", { sorted }) };
  }
  if (scores.at(-1) === 0) return { error: t("scores.zeroMax") };
  return { scores };
}

function criterionRecord(fields) {
  return {
    id: fields.id,
    name: fields.name,
    description: fields.description ?? "",
    section_id: fields.section_id ?? null,
    weight: Number(fields.weight),
    answer_type: fields.answer_type ?? "binary",
    allowed_scores: fields.allowed_scores ?? null,
    scale: fields.scale ?? null,
    options: fields.options ?? null,
    na_allowed: !!fields.na_allowed,
    na_rule: fields.na_rule ?? "",
    severe_error_enabled: !!fields.severe_error_enabled,
    severe_error_rule: fields.severe_error_rule ?? "",
    enabled: fields.enabled !== false,
  };
}

function slug(text) {
  return String(text).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function uniqueSectionId(sections, name) {
  const taken = new Set(sections.map((s) => s.id));
  const base = slug(name);
  if (base && /^[a-z0-9]/.test(base) && !taken.has(base)) return base;
  for (let n = sections.length + 1; ; n += 1) {
    const id = `section-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Build a backend configuration from a browser-only checklist (one saved before checklists lived in ATLAS). */
export function localToConfig(local) {
  const sections = [];
  const sectionIdFor = (name) => {
    let section = sections.find((s) => s.name === name);
    if (!section) {
      section = { id: uniqueSectionId(sections, name), name, description: "" };
      sections.push(section);
    }
    return section.id;
  };
  const criteria = (local.criteria ?? []).map((c) => {
    const section = String(c.section ?? "").trim();
    const fields = {
      id: c.id, name: c.title, description: c.wording, section_id: section ? sectionIdFor(section) : null,
      weight: c.weight, na_allowed: c.naAllowed, severe_error_enabled: c.severe, enabled: c.enabled,
    };
    if (c.answerType === "numeric" && c.allowedScores?.length) {
      return criterionRecord({ ...fields, answer_type: "numeric", allowed_scores: [...c.allowedScores] });
    }
    if (c.answerType === "scale") {
      const points = scalePoints(c.scale);
      if (points && Number(c.scale?.min ?? 0) === 0) {
        return criterionRecord({ ...fields, answer_type: "numeric", allowed_scores: points });
      }
      const { min = 0, max = 5, step = 1 } = c.scale ?? {};
      return criterionRecord({ ...fields, answer_type: "scale", scale: { min, max, step, labels: {} } });
    }
    return criterionRecord({ ...fields, answer_type: "binary" });
  });
  return {
    sections,
    criteria,
    scoring: {
      max_score: 100,
      rounding: { mode: "half_up", digits: local.rounding ?? 2 },
      severe_error_policy: "flag_only",
      na_policy: "redistribute",
    },
  };
}

/** A backend configuration → the checklist shape the views, the chat and the mock scorer read. */
export function configToLocal(config, source, previous) {
  const known = new Map([...defaultChecklist().criteria, ...(previous?.criteria ?? [])].map((c) => [c.id, c]));
  return {
    id: source ? `${source.id}@v${source.version}` : previous?.id ?? "cqa-local",
    label: source ? `${source.name} v${source.version}` : previous?.label,
    title: source?.name ?? previous?.title ?? "Checklist",
    note: source ? source.description : previous?.note ?? "",
    rounding: config.scoring?.rounding?.digits ?? 2,
    source: source ?? null,
    criteria: config.criteria.map((c) => {
      const base = {
        id: c.id,
        section: sectionName(config, c.section_id),
        title: c.name,
        wording: c.description ?? "",
        weight: Number(c.weight),
        naAllowed: !!c.na_allowed,
        enabled: c.enabled !== false,
        severe: !!c.severe_error_enabled,
        signals: known.get(c.id)?.signals ?? { positive: [], negative: [] },
      };
      if (c.answer_type === "numeric" || c.answer_type === "options") {
        const scores = c.answer_type === "numeric"
          ? [...c.allowed_scores]
          : [...new Set((c.options ?? []).map((o) => Number(o.points)))].sort((a, b) => a - b);
        return { ...base, answerType: "numeric", allowedScores: scores, scale: { min: scores[0], max: scores.at(-1) } };
      }
      if (c.answer_type === "scale") return { ...base, answerType: "scale", scale: { ...c.scale } };
      return { ...base, answerType: "yes_no", scale: { yes: 1, no: 0 } };
    }),
  };
}

/** The configuration of the applied checklist version. */
export function appliedConfig(state) {
  return state.checklistConfig ?? localToConfig(state.checklist);
}

/** What the checklist page shows and the editor changes: the unsaved draft, else the applied version. */
export function editingConfig(state) {
  return state.checklistDraft?.config ?? appliedConfig(state);
}

/** Use a checklist returned by the backend (its latest version) as the applied checklist. */
export function adoptChecklist(state, checklist) {
  const version = checklist.versions.find((v) => v.version === checklist.latest_version) ?? checklist.versions.at(-1);
  const source = {
    id: checklist.id, version: version.version, name: checklist.name, description: checklist.description ?? "",
    origin: checklist.origin,
  };
  state.checklistConfig = version.config;
  state.checklist = configToLocal(version.config, source, state.checklist);
  return state;
}

/**
 * Change the editable configuration and keep the result as the draft. A draft that ends up identical to the
 * applied version is dropped, so "unsaved changes" only shows when there are some.
 */
export function stageChange(state, mutate) {
  const applied = appliedConfig(state);
  const draft = state.checklistDraft ?? {
    baseId: state.checklist.source?.id ?? null,
    baseVersion: state.checklist.source?.version ?? null,
    config: structuredClone(applied),
  };
  const config = structuredClone(draft.config);
  mutate(config);
  const keptSections = new Set((applied.sections ?? []).map((s) => s.id));
  const used = new Set(config.criteria.map((c) => c.section_id).filter(Boolean));
  config.sections = (config.sections ?? []).filter((s) => used.has(s.id) || keptSections.has(s.id));
  const unchanged = canon(config) === canon(applied) && draft.baseId === (state.checklist.source?.id ?? null);
  state.checklistDraft = unchanged ? null : { ...draft, config };
  return state;
}

/** Insert or replace one criterion (by its id before editing) and put it in the named section. */
export function putCriterion(config, originalId, criterion, section) {
  const name = String(section ?? "").trim();
  let sectionId = null;
  if (name) {
    config.sections ??= [];
    let found = config.sections.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
    if (!found) {
      found = { id: uniqueSectionId(config.sections, name), name, description: "" };
      config.sections.push(found);
    }
    sectionId = found.id;
  }
  const record = { ...criterion, section_id: sectionId };
  const index = originalId ? config.criteria.findIndex((c) => c.id === originalId) : -1;
  if (index >= 0) config.criteria[index] = record;
  else config.criteria.push(record);
  return config;
}

export function dropCriterion(config, id) {
  config.criteria = config.criteria.filter((c) => c.id !== id);
  return config;
}

export function nextCriterionId(config) {
  const taken = new Set(config.criteria.map((c) => c.id));
  for (let n = config.criteria.length + 1; ; n += 1) {
    if (!taken.has(`criterion-${n}`)) return `criterion-${n}`;
  }
}

/** A short version note: what the draft added, edited and removed compared with the applied version. */
export function changeNote(before, after) {
  const old = new Map(before.criteria.map((c) => [c.id, canon(c)]));
  const now = new Map(after.criteria.map((c) => [c.id, canon(c)]));
  const added = [...now.keys()].filter((id) => !old.has(id));
  const removed = [...old.keys()].filter((id) => !now.has(id));
  const edited = [...now.keys()].filter((id) => old.has(id) && old.get(id) !== now.get(id));
  const parts = [];
  if (added.length) parts.push(`added ${added.join(", ")}`);
  if (edited.length) parts.push(`edited ${edited.join(", ")}`);
  if (removed.length) parts.push(`removed ${removed.join(", ")}`);
  const note = parts.length ? `Checklist editor: ${parts.join("; ")}` : "Checklist editor";
  return note.length > 500 ? `${note.slice(0, 497)}…` : note;
}
