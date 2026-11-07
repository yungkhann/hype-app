import { uid } from "./util.js";

export function defaultMessages() {
  return [
    {
      id: "m0",
      role: "assistant",
      text: "Ask about a conversation, a checklist item, or open appeals. Try “worst scores” or a case id like conv-01.",
      at: Date.now(),
    },
  ];
}

export function newThread(title = "New chat") {
  return {
    id: uid("chat"),
    title,
    updatedAt: Date.now(),
    messages: defaultMessages(),
  };
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
  if (!user?.text) return "New chat";
  const t = user.text.trim().replace(/\s+/g, " ");
  return t.length > 36 ? `${t.slice(0, 36)}…` : t;
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

export function replyTo(state, text) {
  const q = text.trim();
  const low = q.toLowerCase();
  const known = state.conversations.find((c) => low.includes(c.id.toLowerCase()));
  const idMatch = known ? [known.id] : q.match(/conv-\d+/i);
  if (idMatch) {
    const id = known ? known.id : idMatch[0].toLowerCase();
    const conv = state.conversations.find((c) => c.id === id);
    const ev = state.scores?.[id];
    if (!conv) return `I don’t have ${id} in this workspace.`;
    const open = state.appeals.filter((a) => a.conversationId === id && a.status === "open").length;
    const operator = conv.operator ? ` · operator ${conv.operator}` : "";
    const head = `${conv.id} · ${conv.language.toUpperCase()} · ${conv.source}${operator}.`;
    if (ev?.final_percent == null) return `${head} Not evaluated yet. ${open} open appeal${open === 1 ? "" : "s"}.`;
    const severe = ev.severe_errors ?? 0;
    return `${head} Score ${ev.final_percent.toFixed(2)}%. ${severe} critical flag${severe === 1 ? "" : "s"}, ${open} open appeal${open === 1 ? "" : "s"}.`;
  }
  if (/\b(worst|low|слабые|худш)/i.test(low)) {
    const ranked = [...state.conversations]
      .map((c) => ({ c, ev: state.scores?.[c.id] }))
      .filter((x) => x.ev?.final_percent != null)
      .sort((a, b) => a.ev.final_percent - b.ev.final_percent)
      .slice(0, 5);
    if (!ranked.length) return "No conversation has been evaluated yet.";
    return ranked.map((x) => `${x.c.id} · ${x.c.language} · ${x.ev.final_percent.toFixed(2)}%`).join("\n");
  }
  if (/\b(appeal|апелл)/i.test(low)) {
    const open = state.appeals.filter((a) => a.status === "open").length;
    return `${open} open · ${state.appeals.length} total. Open #/review to decide them.`;
  }
  if (/\b(checklist|критер)/i.test(low)) {
    const on = state.checklist.criteria.filter((c) => c.enabled);
    return `${on.length} enabled criteria. ` + on.slice(0, 6).map((c) => `${c.id} ${c.title} (${c.weight})`).join("; ") + (on.length > 6 ? "…" : ".");
  }
  const n = state.conversations.length;
  const langs = [...new Set(state.conversations.map((c) => c.language))].join(", ");
  return `${n} conversations on file (${langs}). Ask for a case id, “worst scores”, “appeals”, or “checklist”.`;
}

export function pushTurn(state, userText) {
  const text = userText.trim();
  if (!text) return state;
  const thread = activeChat(state);
  thread.messages.push({ id: uid("m"), role: "user", text, at: Date.now() });
  thread.messages.push({ id: uid("m"), role: "assistant", text: replyTo(state, text), at: Date.now() });
  thread.updatedAt = Date.now();
  if (thread.title === "New chat") thread.title = titleFrom(thread.messages);
  return state;
}
