import { buildConversations, defaultChecklist } from "./data.js";
import { applyAppeal, evaluateConversation } from "./scoring.js";
import { uid } from "./util.js";

const KEY = "cqa-studio-v2";

function fresh() {
  const checklist = defaultChecklist();
  const conversations = buildConversations();
  const evaluations = {};
  for (const conv of conversations) evaluations[conv.id] = evaluateConversation(conv, checklist);
  return { checklist, conversations, evaluations, appeals: [], apiUrl: "" };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const parsed = JSON.parse(raw);
    if (!parsed.checklist || !parsed.conversations?.length) return fresh();
    return parsed;
  } catch {
    return fresh();
  }
}

export function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function resetState() {
  const state = fresh();
  saveState(state);
  return state;
}

export function reevaluateAll(state) {
  for (const conv of state.conversations) {
    const prev = state.evaluations[conv.id];
    const next = evaluateConversation(conv, state.checklist);
    if (prev?.originalTotal != null) next.originalTotal = prev.originalTotal;
    state.evaluations[conv.id] = next;
  }
  return state;
}

export function submitAppeal(state, conversationId, criterionId, comment) {
  const evaluation = state.evaluations[conversationId];
  const row = evaluation.rows.find((r) => r.criterionId === criterionId);
  state.appeals.unshift({
    id: uid("apl"),
    conversationId,
    criterionId,
    comment,
    originalScore: row.score,
    originalAnswer: row.answer,
    status: "open",
    reviewerAnswer: null,
    reviewerReason: "",
    createdAt: new Date().toISOString(),
    decidedAt: null,
  });
  return state;
}

export function decideAppeal(state, appealId, reviewerAnswer, reason) {
  const appeal = state.appeals.find((a) => a.id === appealId);
  if (!appeal) return state;
  const checklist = state.checklist;
  const evaluation = state.evaluations[appeal.conversationId];
  if (evaluation.originalTotal == null) evaluation.originalTotal = evaluation.total;
  state.evaluations[appeal.conversationId] = applyAppeal(evaluation, checklist, appeal.criterionId, reviewerAnswer);
  appeal.status = "reviewed";
  appeal.reviewerAnswer = reviewerAnswer;
  appeal.reviewerReason = reason;
  appeal.decidedAt = new Date().toISOString();
  const row = state.evaluations[appeal.conversationId].rows.find((r) => r.criterionId === appeal.criterionId);
  appeal.finalScore = row.score;
  appeal.finalTotal = state.evaluations[appeal.conversationId].total;
  return state;
}
