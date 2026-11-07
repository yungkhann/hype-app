import { ensureChats, newThread } from "./chat.js?v=tape4";
import { defaultChecklist, fromRecord } from "./data.js?v=tape2";

const KEY = "cqa-studio-v2";

// Conversations and evaluation scores live in the backend and are loaded on start (setConversations, setScores);
// they are never kept here. Evaluations are run by the backend (GPT); the browser never scores.
// checklist: the applied checklist in the views' shape. checklistConfig: the same version in the backend's
// shape (null until the checklist is saved in ATLAS). checklistDraft: unsaved edits from the checklist page.
function fresh() {
  const thread = newThread();
  return {
    checklist: defaultChecklist(), checklistConfig: null, checklistDraft: null,
    conversations: [], scores: {}, appeals: [], chats: [thread], chatId: thread.id,
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const parsed = JSON.parse(raw);
    if (!parsed.checklist) return fresh();
    let needsSave = !Array.isArray(parsed.chats) || !parsed.chats.length;
    if ("conversations" in parsed || "apiUrl" in parsed) {
      // Saved by the earlier build, whose conversations were generated in the browser. Their appeals belong to
      // those generated cases, so they go too; checklist and chats are kept.
      parsed.appeals = [];
      delete parsed.apiUrl;
      needsSave = true;
    }
    if ("evaluations" in parsed) {
      // Placeholder scores computed in the browser by earlier builds: not evaluations, so they are dropped.
      delete parsed.evaluations;
      needsSave = true;
    }
    parsed.conversations = [];
    parsed.scores = {};
    parsed.checklistConfig ??= null;
    parsed.checklistDraft ??= null;
    parsed.appeals ??= [];
    const next = ensureChats(parsed);
    if (needsSave) saveState(next);
    return next;
  } catch {
    return fresh();
  }
}

export function saveState(state) {
  const { conversations, scores, ...kept } = state;
  localStorage.setItem(KEY, JSON.stringify(kept));
}

/** Use the backend's stored records. */
export function setConversations(state, records) {
  state.conversations = records.map(fromRecord);
  return state;
}

/** The latest completed evaluation per conversation (backend summaries, newest first). */
export function setScores(state, summaries) {
  const scores = {};
  for (const summary of summaries) scores[summary.conversation_id] ??= summary;
  state.scores = scores;
  return state;
}

export function resetState() {
  const state = fresh();
  saveState(state);
  return state;
}
