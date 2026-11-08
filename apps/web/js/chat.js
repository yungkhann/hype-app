import { t, tn } from "./i18n.js?v=tape54";
import { uid } from "./util.js";

// Threads are stored in the browser. An untitled thread keeps the legacy title "New chat" (or null), and the
// greeting keeps the id "m0", so both are shown in the current interface language whenever they are rendered.
const UNTITLED = "New chat";

export function defaultMessages() {
  return [{ id: "m0", role: "assistant", text: t("chat.greeting"), at: Date.now() }];
}

export function newThread(title = UNTITLED) {
  return {
    id: uid("chat"),
    title,
    updatedAt: Date.now(),
    messages: defaultMessages(),
  };
}

/** The title to show: a thread named from its first question keeps that text; an untitled one is translated. */
export function chatTitle(thread) {
  return !thread.title || thread.title === UNTITLED ? t("chat.untitled") : thread.title;
}

/** The text to show for a stored message: the greeting follows the interface language. */
export function messageText(message) {
  return message.id === "m0" && message.role === "assistant" ? t("chat.greeting") : message.text;
}

export function ensureChats(state) {
  if (Array.isArray(state.chats) && state.chats.length) {
    if (!state.chats.some((c) => c.id === state.chatId)) state.chatId = state.chats[0].id;
    return state;
  }
  if (Array.isArray(state.chat) && state.chat.length) {
    const thread = newThread(titleFrom(state.chat));
    thread.messages = state.chat;
    state.chats = [thread];
    state.chatId = thread.id;
    delete state.chat;
    return state;
  }
  const thread = newThread();
  state.chats = [thread];
  state.chatId = thread.id;
  return state;
}

export function activeChat(state) {
  ensureChats(state);
  return state.chats.find((c) => c.id === state.chatId) || state.chats[0];
}

function titleFrom(messages) {
  const user = messages.find((m) => m.role === "user");
  if (!user?.text) return UNTITLED;
  const text = user.text.trim().replace(/\s+/g, " ");
  return text.length > 36 ? `${text.slice(0, 36)}…` : text;
}

export function startChat(state) {
  ensureChats(state);
  const thread = newThread();
  state.chats.unshift(thread);
  state.chatId = thread.id;
  return thread;
}

export function openChat(state, id) {
  ensureChats(state);
  if (state.chats.some((c) => c.id === id)) state.chatId = id;
  return state;
}

export function removeChat(state, id) {
  ensureChats(state);
  state.chats = state.chats.filter((c) => c.id !== id);
  if (!state.chats.length) {
    const thread = newThread();
    state.chats = [thread];
    state.chatId = thread.id;
    return state;
  }
  if (state.chatId === id) state.chatId = state.chats[0].id;
  return state;
}

// state.appeals holds the backend's appeals (status "pending" until a manager decides).
const openAppeals = (state, conversationId) =>
  (state.appeals ?? []).filter((a) => a.status === "pending" && (!conversationId || a.conversation_id === conversationId)).length;

export function replyTo(state, text) {
  const q = text.trim();
  const low = q.toLowerCase();
  const known = state.conversations.find((c) => low.includes(c.id.toLowerCase()));
  const idMatch = known ? [known.id] : q.match(/conv-\d+/i);
  if (idMatch) {
    const id = known ? known.id : idMatch[0].toLowerCase();
    const conv = state.conversations.find((c) => c.id === id);
    const ev = state.scores?.[id];
    if (!conv) return t("chat.unknownCase", { id });
    const open = tn("chat.openAppeals", openAppeals(state, id));
    const head = `${conv.id} · ${conv.language.toUpperCase()} · ${t(`channel.${conv.source}`)}.`;
    if (ev?.final_percent == null) return `${head} ${t("chat.notEvaluated")} ${open}.`;
    const severe = tn("chat.criticalFlags", ev.severe_errors ?? 0);
    return `${head} ${t("chat.score", { score: `${ev.final_percent.toFixed(2)}%` })} ${severe}, ${open}.`;
  }
  if (/\b(worst|low)|слаб|худш|нашар/i.test(low)) {
    const ranked = [...state.conversations]
      .map((c) => ({ c, ev: state.scores?.[c.id] }))
      .filter((x) => x.ev?.final_percent != null)
      .sort((a, b) => a.ev.final_percent - b.ev.final_percent)
      .slice(0, 5);
    if (!ranked.length) return t("chat.noneEvaluated");
    return ranked.map((x) => `${x.c.id} · ${x.c.language} · ${x.ev.final_percent.toFixed(2)}%`).join("\n");
  }
  if (/\bappeal|апелл|шағым/i.test(low)) {
    return t("chat.appeals", { open: openAppeals(state), total: (state.appeals ?? []).length });
  }
  if (/\bchecklist|критер|чек-?лист/i.test(low)) {
    const on = state.checklist.criteria.filter((c) => c.enabled);
    const listed = on.slice(0, 6).map((c) => `${c.id} ${c.title} (${c.weight})`).join("; ") + (on.length > 6 ? "…" : ".");
    return `${tn("chat.enabledCriteria", on.length)} ${listed}`;
  }
  const langs = [...new Set(state.conversations.map((c) => c.language))].join(", ");
  return t("chat.fallback", { count: tn("chat.conversations", state.conversations.length), langs });
}

export function pushTurn(state, userText) {
  const text = userText.trim();
  if (!text) return state;
  const thread = activeChat(state);
  thread.messages.push({ id: uid("m"), role: "user", text, at: Date.now() });
  thread.messages.push({ id: uid("m"), role: "assistant", text: replyTo(state, text), at: Date.now() });
  thread.updatedAt = Date.now();
  if (!thread.title || thread.title === UNTITLED) thread.title = titleFrom(thread.messages);
  return state;
}
