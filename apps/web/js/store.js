import { ensureChats, newThread } from "./chat.js?v=tape2";
import { defaultChecklist, fromRecord } from "./data.js?v=tape2";
import { applyAppeal, evaluateConversation } from "./scoring.js";
import { uid } from "./util.js";

const KEY = "cqa-studio-v2";

// Conversations live in the backend and are loaded on start (setConversations); they are never kept here.
function fresh() {
  const thread = newThread();
  return { checklist: defaultChecklist(), conversations: [], evaluations: {}, appeals: [], chats: [thread], chatId: thread.id };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const parsed = JSON.parse(raw);
    if (!parsed.checklist) return fresh();
    let needsSave = !Array.isArray(parsed.chats) || !parsed.chats.length;
    if ("conversations" in parsed || "apiUrl" in parsed) {
      // Saved by the earlier build, whose conversations were generated in the browser. Their evaluations and
      // appeals belong to those generated cases, so they go too; checklist and chats are kept.
      parsed.evaluations = {};
      parsed.appeals = [];
      delete parsed.apiUrl;
      needsSave = true;
    }
    parsed.conversations = [];
    parsed.evaluations ??= {};
    parsed.appeals ??= [];
    const next = ensureChats(parsed);
    if (needsSave) saveState(next);
    return next;
  } catch {
    return fresh();
  }
}

export function saveState(state) {
  const { conversations, ...kept } = state;
  localStorage.setItem(KEY, JSON.stringify(kept));
}

function evaluate(conv, checklist) {
  return { ...evaluateConversation(conv, checklist), transcriptHash: conv.hash };
}

/** Use the backend's stored records. Existing evaluations are kept unless that transcript changed. */
export function setConversations(state, records) {
  state.conversations = records.map(fromRecord);
  for (const conv of state.conversations) {
    const prev = state.evaluations[conv.id];
    if (!prev || prev.transcriptHash !== conv.hash) state.evaluations[conv.id] = evaluate(conv, state.checklist);
  }
  return state;
}

export function resetState() {
  const state = fresh();
  saveState(state);
  return state;
}

export function reevaluateAll(state) {
  for (const conv of state.conversations) {
    const prev = state.evaluations[conv.id];
    const next = evaluate(conv, state.checklist);
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
