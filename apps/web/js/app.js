import {
  GROUP_ID_RE,
  cqaInfo,
  cqaOverview,
  createAppeal,
  createChecklist,
  decideAppeal,
  errorText,
  getAppeal,
  getAudio,
  getBatch,
  getChecklist,
  getEvaluation,
  rerunEvaluation,
  importGroup,
  importJson,
  listAppeals,
  listChecklistVersions,
  listChecklists,
  listConversationRecords,
  listEvaluations,
  reassessAppeal,
  resultsFile,
  resultsReport,
  startEvaluation,
  updateChecklist,
} from "./api.js?v=tape54";
import { activeChat, chatTitle, messageText, openChat, pushTurn, removeChat, startChat } from "./chat.js?v=tape23";
import {
  adoptChecklist,
  appliedConfig,
  changeNote,
  dropCriterion,
  editingConfig,
  fmt,
  putCriterion,
  scalePoints,
  sectionName,
  stageChange,
} from "./checklist.js?v=tape23";
import {
  closeCriterionEditor,
  isCriterionEditorDirty,
  isCriterionEditorOpen,
  openCriterionEditor,
} from "./criterion-editor.js?v=tape23";
import { bindFileDrop, fileDropHtml, jsonFileError, readDropFile, resetFileDrop, setFileDropBusy, setFileDropError, showFileName } from "./file-drop.js?v=tape44";
import { applyStatic, getLang, hasKey, langCode, langName, locale, nextLang, setLang, t, tn } from "./i18n.js?v=tape54";
import {
  addOnboardCriterion,
  applyOfficialChecklist,
  continueEnabled,
  onboardStep,
  sampleTranscriptJson,
  viewCoach,
  viewOnboard,
} from "./onboard.js?v=tape44";
import { loadState, saveState, setConversations, setScores } from "./store.js?v=tape23";
import { mountMessageScroller } from "./message-scroller.js?v=tape1";
import { Bubble, Button, ChatPrompt, Field, Message, MessageScroller, MessageScrollerItem } from "./ui.js?v=tape23";
import { byId, esc } from "./util.js";

const icon = {
  grid: '<svg viewBox="0 0 24 24"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
  languages: '<svg viewBox="0 0 24 24"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  messages: '<svg viewBox="0 0 24 24"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>',
  checks: '<svg viewBox="0 0 24 24"><path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
};

let state = loadState();
// Conversations come from the backend; until the first answer the list shows that it is loading.
const conversationsStatus = { loading: true, error: "" };
// Set while an import is on its way and the transcript is not known yet.
let pendingOpen = null;
// Transcripts built from a JSON file, kept if the API has not stored them yet.
const localPreview = new Map();
// Saving the checklist as a version; conflictVersion is set when someone else saved a newer version first.
const checklistStatus = { saving: false, error: "", conflictVersion: null };
const applyUi = { busy: false };
// Appeals come from the backend (state.appeals); while GPT reassesses one, the list is reloaded every few seconds.
const appealsStatus = { loading: true, error: "" };
// The newest evaluation status per conversation (any checklist), for the list's Status column.
let evaluationStatus = {};

function persist() {
  saveState(state);
}

function draft() {
  if (!state.onboardDraft) state.onboardDraft = { pack: "", json: "", payload: "" };
  return state.onboardDraft;
}

function showOnboardError(msg) {
  const err = document.querySelector("[data-onboard-error]");
  if (!err) return;
  err.hidden = !msg;
  err.textContent = msg || "";
}

async function finishSetup(payload) {
  state.onboarded = true;
  state.onboardVersion = 2;
  persist();
  if (payload) {
    await loadIntoDialog(() => importJson(payload), payloadConversationId(payload), payload);
    return;
  }
  const id = state.conversations[0]?.id;
  const next = id ? convHref(id) : "#/";
  if (location.hash === next || location.hash === next.slice(1)) render();
  else location.hash = next;
}

function bindOnboard() {
  const root = document.querySelector("[data-onboard-step]");
  if (!root) return;
  const step = Number(root.getAttribute("data-onboard-step") || 1);
  document.querySelector("[data-onboard='skip']")?.addEventListener("click", () => finishSetup());
  document.querySelectorAll("[data-choice]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group = btn.getAttribute("data-choice-group");
      const value = btn.getAttribute("data-choice");
      const d = draft();
      d[group] = value;
      if (group === "lang") setLang(value);
      if (group === "pack" && value === "official") applyOfficialChecklist(state);
      if (group === "pack" && value === "custom" && !d.clearedCustom) {
        state.checklist.criteria = [];
        d.clearedCustom = true;
      }
      persist();
      render();
    });
  });
  document.querySelector("[data-onboard-add]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const result = addOnboardCriterion(state, e.currentTarget);
    if (!result.ok) {
      showOnboardError(result.error);
      return;
    }
    persist();
    render();
  });
  document.querySelectorAll("[data-onboard-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.checklist.criteria = state.checklist.criteria.filter((c) => c.id !== btn.getAttribute("data-onboard-remove"));
      persist();
      render();
    });
  });
  const payloadBox = document.querySelector('[data-field="payload"]');
  payloadBox?.addEventListener("input", () => {
    draft().payload = payloadBox.value;
    const go = document.querySelector("[data-onboard='continue']");
    if (go) go.disabled = !continueEnabled(state, step);
  });
  const zone = document.querySelector("[data-file-drop]");
  if (zone) {
    bindFileDrop(zone, { onFile: (file) => acceptDroppedFile(zone, file, async (text, file) => {
      draft().json = "file";
      draft().payload = text;
      draft().fileName = file.name || "";
      persist();
      const box = document.querySelector('[data-field="payload"]');
      if (box) box.value = text;
      const go = document.querySelector("[data-onboard='continue']");
      if (go) go.disabled = !continueEnabled(state, step);
    }) });
  }
  document.querySelector("[data-onboard='back']")?.addEventListener("click", () => {
    if (step > 1) location.hash = `#/onboard/${step - 1}`;
  });
  document.querySelector("[data-onboard='continue']")?.addEventListener("click", async () => {
    if (step < 4) {
      location.hash = `#/onboard/${step + 1}`;
      return;
    }
    const d = draft();
    const raw = d.json === "sample" ? sampleTranscriptJson() : (payloadBox?.value || d.payload || "").trim();
    if (!raw) {
      showOnboardError(t("onboard.chats.needJson"));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      showOnboardError(t("onboard.chats.badJson"));
      return;
    }
    await finishSetup(payload);
  });
}

async function reloadConversations() {
  conversationsStatus.loading = true;
  conversationsStatus.error = "";
  try {
    setConversations(state, await listConversationRecords());
    persist();
  } catch (err) {
    conversationsStatus.error = errorText(err);
  } finally {
    conversationsStatus.loading = false;
  }
  keepLocalPreviews();
  render();
}

function stageLocalConversations(list) {
  for (const conv of list) {
    if (!conv?.id) continue;
    localPreview.set(conv.id, conv);
    const index = state.conversations.findIndex((item) => item.id === conv.id);
    if (index >= 0) state.conversations[index] = conv;
    else state.conversations.unshift(conv);
  }
}

function keepLocalPreviews() {
  for (const conv of localPreview.values()) {
    if (!state.conversations.some((item) => item.id === conv.id)) state.conversations.unshift(conv);
  }
}

/** Show a timestamp as the source wrote it: MM:SS as is, ISO 8601 by its own clock time (no time-zone shift). */
function clock(ts) {
  const text = String(ts ?? "");
  return text.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? text;
}

/** A stored instant in the interface language. */
function when(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString(locale());
}

// ---- Routes ------------------------------------------------------------------------------------------------
// #/conversations (also #/), #/conversations/:id (also #/c/:id), #/appeals (also #/review), #/appeals/:id,
// #/checklist, #/chat.

function decodeId(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function route() {
  const path = (location.hash.slice(1) || "/").split("?")[0];
  let match;
  if (path.startsWith("/onboard")) return { name: "onboard", step: onboardStep(path) };
  if (path.startsWith("/checklist")) return { name: "checklist" };
  if ((match = path.match(/^\/appeals\/([^/]+)/))) return { name: "appeal", id: decodeId(match[1]) };
  if (path.startsWith("/appeals") || path.startsWith("/review")) return { name: "appeals" };
  if (path.startsWith("/chat")) return { name: "chat", id: path.match(/^\/chat\/([^/]+)/)?.[1] ?? null };
  if ((match = path.match(/^\/(?:c|conversations)\/([^/]+)/))) return { name: "detail", id: decodeId(match[1]) };
  return { name: "list" };
}

function navKey() {
  return { list: "list", checklist: "checklist", appeals: "review", appeal: "review", chat: "chat" }[route().name] ?? "";
}

const convHref = (id) => `#/conversations/${encodeURIComponent(id)}`;
const appealHref = (id) => `#/appeals/${encodeURIComponent(id)}`;

function setNav() {
  applyStatic();
  const key = navKey();
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.nav === key);
  });
  const demo = document.querySelector("[data-demo-link]");
  if (demo) demo.setAttribute("href", state.conversations[0] ? convHref(state.conversations[0].id) : "#/");
  const search = document.querySelector('[data-filter="q"]');
  if (search && document.activeElement !== search) {
    const q = new URLSearchParams(location.hash.split("?")[1] || "");
    search.value = q.get("q") || "";
  }
  const switcher = document.querySelector("[data-action='switch-lang']");
  if (switcher) {
    const label = t("lang.switch", { name: langName(), next: langName(nextLang()) });
    switcher.querySelector("[data-lang-code]").textContent = langCode();
    switcher.setAttribute("aria-label", label);
    switcher.title = label;
  }
}

function render() {
  let current = route();
  if (!state.onboarded && current.name !== "onboard") {
    history.replaceState(null, "", "#/onboard/1");
    current = { name: "onboard", step: 1 };
  }
  document.querySelector(".app")?.classList.toggle("is-onboard", current.name === "onboard");
  setNav();
  const view = byId("view");
  if (current.name === "chat" && current.id) openChat(state, current.id);
  if (current.name === "onboard") view.innerHTML = viewOnboard(state, current.step || 1);
  else if (current.name === "checklist") view.innerHTML = viewChecklist();
  else if (current.name === "appeals") view.innerHTML = viewAppeals();
  else if (current.name === "appeal") view.innerHTML = viewAppeal(current.id);
  else if (current.name === "chat") view.innerHTML = viewChat();
  else if (current.name === "detail") view.innerHTML = viewDetail(current.id);
  else view.innerHTML = viewList();
  bind();
  // Older links open the editor with #/checklist?edit=<id>.
  const h = location.hash.slice(1) || "/";
  const editId = current.name === "checklist" ? new URLSearchParams(h.split("?")[1] || "").get("edit") : null;
  if (editId) {
    history.replaceState(null, "", "#/checklist");
    openEditor(editId);
  }
}

/** Switch the interface language. Stored text (transcripts, rationales, comments) is shown as written. */
function switchLanguage() {
  setLang(nextLang());
  if (importDialog && !importDialog.open) {
    importDialog.remove();
    importDialog = null;
  }
  if (exportDialog && !exportDialog.open) {
    exportDialog.remove();
    exportDialog = null;
  }
  render();
}

function viewChat() {
  const thread = activeChat(state);
  const history = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const items = thread.messages
    .map((m) => {
      const user = m.role === "user";
      const body = esc(messageText(m)).replace(/\n/g, "<br>");
      return MessageScrollerItem({
        id: m.id,
        scrollAnchor: user,
        children: Message({
          align: user ? "end" : "start",
          children: Bubble({
            align: user ? "end" : "start",
            variant: user ? "default" : "secondary",
            children: body,
          }),
        }),
      });
    })
    .join("");
  return `
    <section class="chat-page">
      <aside class="chat-history" aria-label="${esc(t("chat.historyLabel"))}">
        <button type="button" class="chat-new" data-action="new-chat">
          <svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          ${esc(t("chat.new"))}
        </button>
        <p class="chat-history-label">${esc(t("chat.history"))}</p>
        <nav class="chat-history-list">
          ${history.map((c) => `
            <div class="chat-history-row ${c.id === thread.id ? "is-on" : ""}">
              <a class="chat-history-item" href="#/chat/${esc(c.id)}" data-chat-id="${esc(c.id)}">${esc(chatTitle(c))}</a>
              <button type="button" class="chat-history-del" data-action="delete-chat" data-chat-id="${esc(c.id)}" aria-label="${esc(t("chat.delete"))}">
                <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
              </button>
            </div>`).join("")}
        </nav>
      </aside>
      <div class="chat-shell">
        ${MessageScroller(items)}
        <form class="chat-prompt" data-chat-form>${ChatPrompt()}</form>
      </div>
    </section>`;
}

// ---- Conversations ---------------------------------------------------------------------------------------

const STATUS_TONE = { completed: "badge-good", running: "badge-info", pending: "badge-info", failed: "badge-crit" };

function statusBadge(status) {
  return `<span class="badge ${STATUS_TONE[status] ?? "badge-muted"}">${esc(t(`status.${status ?? "none"}`))}</span>`;
}

function speakerLabel(speaker) {
  return hasKey(`speaker.${speaker}`) ? t(`speaker.${speaker}`) : String(speaker ?? "");
}

function viewList() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const lang = q.get("lang") || "";
  const source = q.get("source") || "";
  const search = (q.get("q") || "").toLowerCase();
  const rows = state.conversations.filter((c) => {
    if (lang && c.language !== lang) return false;
    if (source && c.source !== source) return false;
    if (search && !`${c.id} ${c.operator} ${c.language}`.toLowerCase().includes(search)) return false;
    return true;
  });
  const all = state.conversations.length;
  const countText = conversationsStatus.loading && !all ? t("list.loading")
    : rows.length === all ? tn("list.count", all) : t("list.countOf", { shown: rows.length, all });
  const hrefOf = ({ lang: nextLang = lang, source: nextSource = source } = {}) => {
    const p = new URLSearchParams();
    if (nextLang) p.set("lang", nextLang);
    if (nextSource) p.set("source", nextSource);
    const qs = p.toString();
    return qs ? `#/?${qs}` : "#/";
  };
  const chip = (on, label, href, ico) =>
    `<a class="tool ${on ? "is-on" : ""}" href="${href}"><span class="tool-ico">${ico}</span>${esc(label)}</a>`;
  const rule = `<span class="tool-rule" aria-hidden="true"></span>`;
  const empty = conversationsStatus.loading ? t("list.loading") : all ? t("list.noMatch") : t("list.empty");
  return `
    <section class="home">
      <div class="home-hero">
        <img class="home-mascot" src="img/mascot-wave-slow.gif?v=3" width="280" height="280" alt="" />
        <h1>${esc(t("list.heroTitle"))}</h1>
        <form class="hero-search" data-hero-import>
          <input class="hero-q" name="q" type="text" placeholder="${esc(t(heroMethod === "json" ? "list.heroPlaceholderJson" : "list.heroPlaceholderApi"))}" autocomplete="off" spellcheck="false" />
          <div class="hero-bar">
          <div class="hero-tools">
            <button type="button" class="hero-plus" data-hero-file aria-label="${esc(t("list.attachJson"))}">${icon.plus}</button>
            <div class="hero-method" role="switch" tabindex="0" aria-checked="${heroMethod === "json" ? "true" : "false"}" aria-label="${esc(t("list.methodLabel"))}">
              <span class="hero-method-thumb" data-hero-method-thumb></span>
              <input type="hidden" name="import_method" value="${heroMethod === "json" ? "json" : "api"}" />
              <span class="hero-method-btn${heroMethod !== "json" ? " is-on" : ""}" data-hero-method="api">${esc(t("list.methodApi"))}</span>
              <span class="hero-method-btn${heroMethod === "json" ? " is-on" : ""}" data-hero-method="json">${esc(t("list.methodJson"))}</span>
            </div>
          </div>
          <div class="hero-end">
          <div class="hero-model">
            <input type="hidden" name="model" value="${evaluationUi.mode === 2 ? "openai" : "gemma"}" />
            <button type="button" class="hero-model-btn" data-hero-model-btn aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(t("list.modelLabel"))}">
              <span data-hero-model-label>${esc(evaluationUi.mode === 2 ? t("list.modelOpenai") : t("list.modelQwen"))}</span>
            </button>
            <div class="hero-model-menu" data-hero-model-menu hidden role="listbox" aria-label="${esc(t("list.modelLabel"))}">
              ${[
                ["openai", t("list.modelOpenai"), evaluationUi.mode === 2],
                ["gemma", t("list.modelQwen"), evaluationUi.mode === 1],
              ].map(([value, label, on]) => `
                <button type="button" class="hero-model-item${on ? " is-on" : ""}" role="option" data-model="${value}" aria-selected="${on}">
                  <span class="hero-model-check" aria-hidden="true">${on ? icon.check : ""}</span>
                  ${esc(label)}
                </button>`).join("")}
            </div>
          </div>
          <button class="hero-go" type="submit" aria-label="${esc(t("list.import"))}">${icon.arrow}</button>
          </div>
          </div>
        </form>
      </div>
      <div class="home-cards">
        <a class="home-card" href="#/checklist">
          <span class="home-card-go" aria-hidden="true">${icon.arrow}</span>
          <span class="home-card-ico">${icon.checks}</span>
          <h3>${esc(t("nav.checklist"))}</h3>
          <p>${esc(t("list.cardChecklist"))}</p>
        </a>
        <a class="home-card" href="#/appeals">
          <span class="home-card-go" aria-hidden="true">${icon.arrow}</span>
          <span class="home-card-ico">${icon.file}</span>
          <h3>${esc(t("nav.appeals"))}</h3>
          <p>${esc(t("list.cardAppeals"))}</p>
        </a>
      </div>
      <section class="home-history" id="home-history">
      <div class="tool-row">
        ${chip(!lang && !source, t("list.all"), hrefOf({ lang: "", source: "" }), icon.grid)}
        ${rule}
        ${chip(source === "chat", t("list.chats"), hrefOf({ source: source === "chat" ? "" : "chat" }), icon.messages)}
        ${chip(source === "call", t("list.calls"), hrefOf({ source: source === "call" ? "" : "call" }), icon.phone)}
        ${rule}
        ${chip(lang === "kz", t("list.kazakh"), hrefOf({ lang: lang === "kz" ? "" : "kz" }), '<span class="tool-mark">kz</span>')}
        ${chip(lang === "ru", t("list.russian"), hrefOf({ lang: lang === "ru" ? "" : "ru" }), '<span class="tool-mark">ru</span>')}
        ${chip(lang === "en", t("list.english"), hrefOf({ lang: lang === "en" ? "" : "en" }), '<span class="tool-mark">en</span>')}
      </div>
      <div class="list-head">
        <p class="hint" role="status">${esc(countText)}</p>
        <span class="ui-btn-row">
          ${Button(esc(t("list.export")), { attrs: 'data-action="open-export"' })}
        </span>
      </div>
      ${conversationsStatus.error ? `<div class="notice notice-error list-notice" role="alert">${esc(t("list.loadError", { error: conversationsStatus.error }))} ${Button(esc(t("common.retry")), { attrs: 'data-action="reload-conversations"' })}</div>` : ""}
      <div class="table-wrap">
        <table>
          <thead><tr><th>${esc(t("list.th.id"))}</th><th>${esc(t("list.th.lang"))}</th><th>${esc(t("list.th.source"))}</th><th>${esc(t("list.th.operator"))}</th><th>${esc(t("list.th.status"))}</th><th>${esc(t("list.th.score"))}</th><th>${esc(t("list.th.flags"))}</th></tr></thead>
          <tbody>
            ${!rows.length ? `<tr><td colspan="7" class="hint">${esc(empty)}</td></tr>` : ""}
            ${rows.map((c) => {
              const ev = state.scores[c.id];
              const open = state.appeals.filter((a) => a.conversation_id === c.id && a.status === "pending").length;
              return `<tr>
                <td><a class="linkish" href="${esc(convHref(c.id))}">${esc(c.id)}</a></td>
                <td>${esc(c.language.toUpperCase())}</td>
                <td>${c.source === "call" ? `<span class="badge badge-info">${esc(t("channel.call"))}</span>` : `<span class="badge badge-muted">${esc(t("channel.chat"))}</span>`}</td>
                <td>${esc(c.operator || "—")}</td>
                <td>${statusBadge(evaluationStatus[c.id] ?? null)}</td>
                <td class="num">${esc(pct(ev?.final_percent))}</td>
                <td>${ev?.severe_errors ? `<span class="badge badge-crit">${esc(t("list.critical"))}</span>` : ""} ${open ? `<span class="badge badge-warn">${esc(tn("list.appeals", open))}</span>` : ""}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      </section>
    </section>`;
}

/** The transcript in its original order; turn numbers are 1-based positions in the source array. */
function transcriptHtml(messages) {
  return `<div class="transcript">
            ${messages.map((m, i) => {
              const align = m.speaker === "operator" ? "end" : m.speaker === "client" ? "start" : "center";
              const variant = m.speaker === "operator" ? "default" : m.speaker === "client" ? "paper" : "muted";
              const bubbleAlign = align === "center" ? "start" : align;
              return `
              <article class="msg" id="msg-${esc(m.id)}" data-msg="${esc(m.id)}" data-align="${align}">
                <div class="msg-meta"><span class="tape">#${i + 1}</span><span class="role role-${esc(m.speaker)}">${esc(speakerLabel(m.speaker))}</span><button type="button" class="tape" data-jump="${esc(m.id)}" data-offset="${m.offsetSeconds ?? ""}" title="${esc(m.ts)}">${esc(clock(m.ts))}</button></div>
                ${Bubble({ align: bubbleAlign, variant, children: esc(m.text) })}
              </article>`;
            }).join("")}
          </div>`;
}

// The stored audio_url is the organizers' player page; the backend resolves a playable source when it can.
const audioUi = {}; // conversation id → { loading } | { info } | { error }
const isHttp = (url) => /^https?:\/\//i.test(String(url ?? ""));

function audioHtml(conv) {
  if (!conv.audioUrl) return "";
  let entry = audioUi[conv.id];
  if (!entry) {
    entry = audioUi[conv.id] = { loading: true };
    getAudio(conv.id)
      .then((info) => { audioUi[conv.id] = { info }; }, (err) => { audioUi[conv.id] = { error: errorText(err) }; })
      .finally(() => { if (currentDetailId() === conv.id) render(); });
  }
  const wrap = (html) => `<div style="padding:12px 16px 0">${html}</div>`;
  if (entry.loading) return wrap(`<p class="hint">${esc(t("audio.loading"))}</p>`);
  const info = entry.info;
  if (isHttp(info?.stream_url)) return wrap(`<audio class="audio" controls preload="metadata" src="${esc(info.stream_url)}"></audio>`);
  const player = info?.player_url ?? conv.audioUrl;
  const note = entry.error ?? info?.message ?? "";
  const link = isHttp(player) ? `<a class="linkish" href="${esc(player)}" target="_blank" rel="noopener noreferrer">${esc(t("audio.open"))}</a>` : esc(t("audio.unavailable"));
  return wrap(`${link}${note ? `<p class="hint">${esc(note)}</p>` : ""}`);
}

/** Scroll to a transcript line. On a call with a ready player, also move the playhead to that line's offset. */
function jumpToMessage(messageId, fallback) {
  const node = document.getElementById(`msg-${messageId}`);
  document.querySelectorAll(".msg.is-hit").forEach((el) => el.classList.remove("is-hit"));
  if (node) {
    node.classList.add("is-hit");
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  const audio = document.querySelector("audio.audio");
  if (!audio) return;
  const conv = state.conversations.find((c) => c.source === "call" && c.messages.some((m) => m.id === messageId));
  const stored = conv?.messages.find((m) => m.id === messageId)?.offsetSeconds;
  const parsed = Number(fallback);
  const offset = typeof stored === "number" ? stored : (Number.isFinite(parsed) ? parsed : null);
  if (offset == null) return;
  const wasPlaying = !audio.paused;
  audio.currentTime = offset;
  if (wasPlaying && audio.paused) audio.play().catch(() => {});
}

function waitingForConversation(id) {
  if (conversationsStatus.loading) return true;
  if (!pendingOpen) return false;
  return pendingOpen.id ? pendingOpen.id === id : id === "_loading";
}

/** Placeholders until a transcript exists. The JSON chat itself is drawn as soon as the file is read. */
function transcriptSkeleton() {
  const sides = ["start", "end", "start", "end", "start"];
  return `<div class="transcript transcript-wait" role="status" aria-busy="true" aria-label="${esc(t("detail.loading"))}">
    ${sides.map((side) => `<div class="sk-row${side === "end" ? " is-end" : ""}"><span class="sk-bubble"></span></div>`).join("")}
  </div>`;
}

function evaluationPending(id) {
  if (evaluationUi.syncing.has(id)) return true;
  if (evaluationUi.checklists === null || !evaluationUi.history[id]) return true;
  // A failed fetch is not a finished score pane: keep the skeleton until the data arrives.
  return !!(evaluationUi.checklistsError || evaluationUi.errors[id]);
}

/** Thinking mascot and card placeholders in the score pane, while that pane's data is still on the way. */
function evalSkeleton() {
  return `
    <div class="pane-head"><h2>${esc(t("eval.title"))}</h2></div>
    <div class="eval-wait" role="status" aria-busy="true" aria-label="${esc(t("eval.loadingHistory"))}">
      <div class="sk-stack" aria-hidden="true">
        <span class="sk-card"></span>
        <span class="sk-card sk-card-short"></span>
        <span class="sk-card sk-card-mid"></span>
        <span class="sk-card"></span>
        <span class="sk-card sk-card-short"></span>
      </div>
      <img class="think-mascot" src="img/mascot-think.gif?v=3" alt="" />
    </div>`;
}

/** Dialog shell used only before any transcript is known. The score side stays a skeleton. */
function viewDetailShell(id) {
  const real = id && id !== "_loading";
  if (real && needsEvaluationSync(id)) {
    syncEvaluationPane(id).then(() => {
      if (currentDetailId() === id) render();
    });
  }
  const title = real ? esc(id) : esc(t("detail.loading"));
  return `
    <section class="page-wide">
      <div class="pane-head">
        <div>
          <a href="#/">${esc(t("nav.home"))}</a>
          <h2 style="margin-top:4px">${title}</h2>
        </div>
        ${heroHtml("—", t("detail.loading"), "")}
      </div>
      <div class="split">
        <div class="pane">
          <div class="pane-head"><h2>${esc(t("detail.transcript"))}</h2></div>
          ${transcriptSkeleton()}
        </div>
        <div class="pane is-eval-wait">
          ${evalSkeleton()}
        </div>
      </div>
    </section>`;
}

function viewDetail(id) {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return waitingForConversation(id) ? viewDetailShell(id) : `<section class="page"><p>${esc(t("detail.notFound"))}</p></section>`;
  if (needsEvaluationSync(id)) {
    syncEvaluationPane(id).then(() => {
      if (currentDetailId() === id) render();
    });
  }
  const shown = shownEvaluation(id);
  const coach = state.coachDone ? "" : viewCoach(t("detail.coach"));
  return `
    ${coach}
    <section class="page-wide">
      <div class="pane-head">
        <div>
          <a href="#/">${esc(t("nav.home"))}</a>
          <h2 style="margin-top:4px">${esc(conv.id)} · ${esc(conv.language.toUpperCase())} · ${esc(t(`channel.${conv.source}`))}</h2>
        </div>
        ${scoreHero(id, shown)}
      </div>
      <div class="split">
        <div class="pane">
          <div class="pane-head"><h2>${esc(t("detail.transcript"))}</h2><span class="badge badge-muted">${esc(tn("detail.turns", conv.messages.length))}</span></div>
          ${audioHtml(conv)}
          ${transcriptHtml(conv.messages)}
        </div>
        <div class="pane${evaluationPending(id) ? " is-eval-wait" : ""}">
          ${evaluationPending(id) ? evalSkeleton() : evaluationPane(id, shown)}
        </div>
      </div>
    </section>`;
}

// ---- Evaluation --------------------------------------------------------------------------------------------
// The backend evaluates: it sends the transcript and the selected checklist version to GPT, validates the answer
// and computes the score. This page only asks for an evaluation, follows its status, and shows what was stored.

const OFFICIAL_TEMPLATE = "freedom-broker-official";
const POLL_MS = 1500;
const MODE_KEY = "cqa-eval-mode";
let heroMethod = "api";
const evaluationUi = {
  checklists: null, // ChecklistSummary[] (not archived), null until loaded
  checklistsError: "",
  versions: {}, // checklist id → ChecklistVersionSummary[], newest first
  selection: null, // { checklistId, version } — version null follows the latest version
  history: {}, // conversation id → EvaluationSummary[], newest first
  details: {}, // evaluation id → EvaluationDetail (or { error })
  starting: {}, // conversation id → true while the evaluation is being queued
  errors: {}, // conversation id → message
  syncing: new Set(),
  polling: new Set(),
  mode: storedMode(),
};

// Evaluation mode (backend: app/cqa/routing.py). 1: Qwen answers the official criteria that still match the
// official definition, GPT the custom and modified ones. 2: GPT answers everything. GPT reassesses appeals in both.
function storedMode() {
  try {
    return localStorage.getItem(MODE_KEY) === "2" ? 2 : 1;
  } catch {
    return 1;
  }
}

function chooseMode(mode) {
  evaluationUi.mode = mode === 2 ? 2 : 1;
  try {
    localStorage.setItem(MODE_KEY, String(evaluationUi.mode));
  } catch {
    // remembered for this page only
  }
}

const modeLabel = (mode) => t(mode === 2 ? "eval.mode2" : "eval.mode1");
const modeHint = (mode) => t(mode === 2 ? "eval.mode2Hint" : "eval.mode1Hint");
const PROVIDER_NAMES = { gemma: "Qwen", openai: "GPT" };

function pct(value) {
  return value == null ? "—" : `${Number(value).toFixed(2)}%`;
}

function num(value) {
  return value == null ? "—" : String(Math.round(Number(value) * 100) / 100);
}

function currentDetailId() {
  const current = route();
  return current.name === "detail" ? current.id : null;
}

/** GPT writes its explanations in the interface language (RU, KZ or EN); transcripts are never translated. */
function uiLanguage() {
  return getLang();
}

function noticeBox(tone, html, role = "status") {
  return `<div class="notice ${tone}" role="${role}" style="margin:0 16px 12px">${html}</div>`;
}

function checklistSummary(id) {
  return (evaluationUi.checklists ?? []).find((c) => c.id === id) ?? null;
}

/** The selected checklist: kept while it exists, else the one on the checklist page, else the official one. */
function currentSelection() {
  const list = evaluationUi.checklists ?? [];
  if (evaluationUi.selection && list.some((c) => c.id === evaluationUi.selection.checklistId)) return evaluationUi.selection;
  const pick = list.find((c) => c.id === state.checklist.source?.id) ?? list.find((c) => c.template_id === OFFICIAL_TEMPLATE) ?? list[0];
  evaluationUi.selection = pick ? { checklistId: pick.id, version: null } : null;
  return evaluationUi.selection;
}

function selectedVersion(selection) {
  return selection?.version ?? checklistSummary(selection?.checklistId)?.latest_version ?? null;
}

/** The newest evaluation of this conversation with the selected checklist version, with its detail when loaded. */
function shownEvaluation(convId) {
  const selection = currentSelection();
  const version = selectedVersion(selection);
  const summary = selection
    ? (evaluationUi.history[convId] ?? []).find((e) => e.checklist_id === selection.checklistId && e.checklist_version === version) ?? null
    : null;
  const detail = summary ? evaluationUi.details[summary.id] ?? null : null;
  const record = detail?.evaluation ?? null;
  return { selection, version, summary, detail, record, status: record?.status ?? summary?.status ?? null };
}

function needsEvaluationSync(convId) {
  if (evaluationUi.syncing.has(convId)) return false;
  if (evaluationUi.checklists === null || !evaluationUi.history[convId]) return true;
  const { selection, summary } = shownEvaluation(convId);
  if (selection && !evaluationUi.versions[selection.checklistId]) return true;
  return !!(summary && !evaluationUi.details[summary.id]);
}

/** Load what the evaluation pane needs (checklists, versions, this conversation's evaluations, the shown one). */
async function syncEvaluationPane(convId) {
  evaluationUi.syncing.add(convId);
  try {
    if (evaluationUi.checklists === null) {
      try {
        evaluationUi.checklists = (await listChecklists()).filter((c) => !c.archived);
        evaluationUi.checklistsError = "";
      } catch (err) {
        evaluationUi.checklists = [];
        evaluationUi.checklistsError = t("eval.checklistsError", { error: errorText(err) });
      }
    }
    const selection = currentSelection();
    const jobs = [];
    if (selection && !evaluationUi.versions[selection.checklistId]) {
      const id = selection.checklistId;
      jobs.push(listChecklistVersions(id).then((v) => { evaluationUi.versions[id] = v; }, () => { evaluationUi.versions[id] = []; }));
    }
    if (!evaluationUi.history[convId]) {
      jobs.push(listEvaluations({ conversation_id: convId, page_size: 200 }).then(
        (page) => { evaluationUi.history[convId] = page.items; },
        (err) => {
          evaluationUi.history[convId] = [];
          evaluationUi.errors[convId] = t("eval.historyError", { error: errorText(err) });
        },
      ));
    }
    await Promise.all(jobs);
    const { summary } = shownEvaluation(convId);
    if (summary && !evaluationUi.details[summary.id]) {
      try {
        evaluationUi.details[summary.id] = await getEvaluation(summary.id);
      } catch (err) {
        evaluationUi.details[summary.id] = { error: errorText(err) };
      }
    }
    const shown = shownEvaluation(convId);
    if (shown.summary && (shown.status === "pending" || shown.status === "running")) pollEvaluation(shown.summary.id, convId);
  } finally {
    evaluationUi.syncing.delete(convId);
  }
}

/** Follow a queued evaluation until the backend marks it completed or failed. */
async function pollEvaluation(evaluationId, convId) {
  if (evaluationUi.polling.has(evaluationId)) return;
  evaluationUi.polling.add(evaluationId);
  let status = evaluationUi.details[evaluationId]?.evaluation?.status ?? null;
  try {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      let detail;
      try {
        detail = await getEvaluation(evaluationId);
      } catch (err) {
        evaluationUi.errors[convId] = t("eval.followError", { error: errorText(err) });
        break;
      }
      evaluationUi.details[evaluationId] = detail;
      const next = detail.evaluation.status;
      if (next !== status) {
        status = next;
        if (currentDetailId() === convId) render();
      }
      if (next === "completed" || next === "failed") break;
    }
  } finally {
    evaluationUi.polling.delete(evaluationId);
  }
  delete evaluationUi.history[convId]; // reload the list with the final status
  loadScores();
  if (currentDetailId() === convId) render();
}

async function runEvaluation(convId) {
  const selection = currentSelection();
  const version = selectedVersion(selection);
  if (!selection || !version || evaluationUi.starting[convId]) return;
  evaluationUi.errors[convId] = "";
  evaluationUi.starting[convId] = true;
  render();
  try {
    const response = await startEvaluation({
      checklist_id: selection.checklistId,
      checklist_version: version,
      conversation_ids: [convId],
      explanation_language: uiLanguage(),
      mode_type: evaluationUi.mode,
    });
    const queued = response.evaluations[0];
    evaluationUi.history[convId] = [queued, ...(evaluationUi.history[convId] ?? [])];
    pollEvaluation(queued.id, convId);
  } catch (err) {
    evaluationUi.errors[convId] = t("eval.startError", { error: errorText(err) });
  } finally {
    evaluationUi.starting[convId] = false;
    if (currentDetailId() === convId) render();
  }
}

/** Re-run a failed evaluation in its mode: a new record that keeps the providers' answers that succeeded. */
async function retryEvaluation(convId, button) {
  const id = button?.dataset.rerun;
  if (!id || !convId || evaluationUi.starting[convId]) return;
  evaluationUi.errors[convId] = "";
  evaluationUi.starting[convId] = true;
  render();
  try {
    const queued = (await rerunEvaluation(id)).evaluations[0];
    evaluationUi.history[convId] = [queued, ...(evaluationUi.history[convId] ?? [])];
    pollEvaluation(queued.id, convId);
  } catch (err) {
    evaluationUi.errors[convId] = t("eval.startError", { error: errorText(err) });
  } finally {
    evaluationUi.starting[convId] = false;
    if (currentDetailId() === convId) render();
  }
}

/**
 * Every evaluation summary (newest first): the latest completed one per conversation feeds the list's Score column
 * and the chat, the latest of any status feeds the Status column.
 */
async function loadScores() {
  try {
    const items = [];
    for (let page = 1; page <= 25; page += 1) {
      const data = await listEvaluations({ page, page_size: 200 });
      items.push(...data.items);
      if (page * data.page_size >= data.total) break;
    }
    setScores(state, items);
    const latest = {};
    for (const item of items) latest[item.conversation_id] ??= item.status;
    evaluationStatus = latest;
  } catch {
    return; // The list keeps showing "—"; the detail page reports API errors itself.
  }
  if (navKey() === "list") render();
}

function heroHtml(big, sub, badge) {
  return `
        <div class="score-hero">
          <div>
            <div class="score-big">${esc(big)}</div>
            ${sub ? `<div class="hint">${esc(sub)}</div>` : ""}
          </div>
          ${badge}
        </div>`;
}

function scoreHero(convId, shown) {
  const { record, status } = shown;
  const score = record?.status === "completed" ? record.final_score : null;
  let big = "—";
  let sub = t("eval.notEvaluated");
  let badge = "";
  if (score) {
    big = pct(score.percent);
    const original = record.original_score?.percent;
    sub = score.percent == null ? t("eval.allNa")
      : original != null && original !== score.percent ? t("eval.originalFinal", { original: pct(original), final: pct(score.percent) }) : "";
    badge = score.severe_errors.length
      ? `<span class="badge badge-crit">${esc(t("eval.criticalBadge"))}</span>`
      : `<span class="badge badge-good">${esc(t("eval.noCriticalBadge"))}</span>`;
  } else if (evaluationUi.starting[convId] || status === "pending" || status === "running") {
    sub = t("eval.evaluating");
  } else if (status === "failed") {
    sub = t("eval.failedShort");
  }
  return heroHtml(big, sub, badge);
}

function evaluationMeta(shown) {
  const { record, selection, version } = shown;
  if (record) {
    const model = record.model_info?.name || record.evaluator.version;
    const at = record.completed_at ? ` · ${when(record.completed_at)}` : "";
    const by = record.mode_type ? modeLabel(record.mode_type) : record.evaluator.label;
    return `${by}${model ? ` · ${model}` : ""} · ${record.checklist_name} v${record.checklist_version}${at}`;
  }
  const checklist = checklistSummary(selection?.checklistId);
  return checklist ? t("eval.metaChecklist", { name: checklist.name, version }) : "";
}

function evaluationControls(convId, shown) {
  const list = evaluationUi.checklists;
  const { selection, version, status } = shown;
  const versions = selection ? evaluationUi.versions[selection.checklistId] ?? [] : [];
  const checklistOptions = (list ?? []).map((c) => `<option value="${esc(c.id)}" ${c.id === selection?.checklistId ? "selected" : ""}>${esc(c.name)}</option>`).join("")
    || `<option>${esc(t(list === null ? "eval.loadingChecklists" : "eval.noChecklist"))}</option>`;
  const versionLabel = (v, latest) => `${t("eval.versionN", { n: v })}${latest ? ` ${t("eval.latest")}` : ""}`;
  const versionOptions = versions.length
    ? versions.map((v) => `<option value="${v.version}" ${v.version === version ? "selected" : ""}>${esc(versionLabel(v.version, v.is_latest))}</option>`).join("")
    : version ? `<option value="${version}">${esc(versionLabel(version, false))}</option>` : "";
  const busy = evaluationUi.starting[convId] || status === "pending" || status === "running";
  const running = (shown.record?.mode_type ?? evaluationUi.mode) === 1 ? t("eval.runningHybrid") : t("eval.running");
  const progress = evaluationUi.starting[convId] ? t("eval.starting") : status === "pending" ? t("eval.queued") : status === "running" ? running : "";
  const mode = evaluationUi.mode;
  const label = busy ? t("eval.evaluating") : shown.summary ? t("eval.again") : t("eval.run");
  return `
          <form class="crit-card form-grid" data-evaluate-form novalidate>
            <div>
              <label class="field-label" for="eval-checklist">${esc(t("eval.checklist"))}</label>
              <select class="input" id="eval-checklist" name="checklist" ${list?.length ? "" : "disabled"}>${checklistOptions}</select>
            </div>
            <div>
              <label class="field-label" for="eval-version">${esc(t("eval.version"))}</label>
              <select class="input" id="eval-version" name="version" ${versionOptions ? "" : "disabled"}>${versionOptions}</select>
            </div>
            <div>
              <label class="field-label" for="eval-mode">${esc(t("eval.mode"))}</label>
              <select class="input" id="eval-mode" name="mode" aria-describedby="eval-mode-hint">
                ${[1, 2].map((m) => `<option value="${m}" ${m === mode ? "selected" : ""}>${esc(modeLabel(m))}</option>`).join("")}
              </select>
              <p class="hint" id="eval-mode-hint">${esc(modeHint(mode))}</p>
            </div>
            <div class="ui-btn-row">
              ${Button(esc(label), { variant: "primary", type: "submit", attrs: busy || !version ? "disabled" : "" })}
              <span class="hint" role="status" aria-live="polite">${esc(progress)}</span>
            </div>
          </form>`;
}

function evaluationNotices(convId, shown) {
  const { record, detail, summary, selection } = shown;
  const parts = [];
  if (evaluationUi.checklistsError) parts.push(noticeBox("notice-error", esc(evaluationUi.checklistsError), "alert"));
  if (evaluationUi.errors[convId]) parts.push(noticeBox("notice-error", esc(evaluationUi.errors[convId]), "alert"));
  if (detail?.error) parts.push(noticeBox("notice-error", esc(t("eval.detailError", { error: detail.error })), "alert"));
  if (record?.status === "failed") {
    const issues = record.error?.issues ?? [];
    const failedParts = (record.parts ?? []).filter((p) => p.status !== "completed");
    const retry = record.mode_type && failedParts.length && failedParts.length < record.parts.length
      ? `<p>${Button(esc(t("eval.retryPart", { provider: failedParts.map((p) => PROVIDER_NAMES[p.provider] ?? p.label).join(", ") })), { attrs: `data-rerun="${esc(record.id)}"` })}</p>`
      : "";
    parts.push(noticeBox("notice-error", `<strong>${esc(t("eval.failed"))}</strong> ${esc(record.error?.message ?? "")}
      ${issues.length ? `<ul>${issues.slice(0, 5).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}
      <p class="hint">${esc(t("eval.noScore"))}</p>${retry}`, "alert"));
  }
  if (record?.evaluator?.is_mock) parts.push(noticeBox("notice-warn", esc(t("eval.mock"))));
  if (detail?.stale) parts.push(noticeBox("notice-warn", esc(t("eval.stale"))));
  if (selection && !summary && evaluationUi.history[convId] && !evaluationUi.starting[convId]) {
    parts.push(`<p class="hint" style="padding:0 16px 12px">${esc(t("eval.notYet"))}</p>`);
  }
  if (!evaluationUi.history[convId] && !parts.length) parts.push(`<p class="hint" style="padding:0 16px 12px">${esc(t("eval.loadingHistory"))}</p>`);
  return parts.join("");
}

function answerText(criterion, result, score) {
  if (result.is_na) return t("value.na");
  if (Number(criterion.weight) === 0) return t(result.value === true ? "value.critical" : "value.noCritical");
  if (criterion.answer_type === "binary") return t(result.value ? "value.yes" : "value.no");
  if (criterion.answer_type === "options") {
    const option = (criterion.options ?? []).find((o) => o.id === result.value);
    return `${option?.label ?? result.value} · ${num(score?.raw_score)}/${num(score?.raw_max)}`;
  }
  return `${num(result.value)}/${num(score?.raw_max)}`;
}

/** An answer as words: yes / no, critical error, N/A, the option label or the number. */
function valueText(criterion, value, isNa) {
  if (isNa) return t("value.na");
  if (value === null || value === undefined) return "—";
  if (!criterion) return String(value);
  if (criterion.answer_type === "binary") {
    if (Number(criterion.weight) === 0) return t(value === true ? "value.critical" : "value.noCritical");
    return t(value ? "value.yes" : "value.no");
  }
  if (criterion.answer_type === "options") return (criterion.options ?? []).find((o) => o.id === value)?.label ?? String(value);
  return num(value);
}

function evidenceButtons(refs) {
  return (refs ?? []).map((e) =>
    `<button class="btn btn-ghost" type="button" data-jump="${esc(e.message_id)}" data-offset="${e.offset_seconds ?? ""}">${esc(t("crit.evidence", { n: e.message_index + 1, speaker: speakerLabel(e.speaker) }))}</button>`).join("");
}

// ---- Appeals on the conversation page ----------------------------------------------------------------------
// "Appeal" on a criterion card submits the dispute; the backend stores it and asks GPT for a separate
// reassessment. A criterion with an undecided appeal shows its status and a link instead of the button.

const appealDrafts = {}; // "<evaluation id>:<criterion id>" → { open, text, busy, error }

function criterionAppeals(record, criterionId, detailAppeals) {
  const found = new Map();
  for (const a of detailAppeals ?? []) if (a.criterion_id === criterionId) found.set(a.id, a);
  for (const a of state.appeals) if (a.evaluation_id === record.id && a.criterion_id === criterionId) found.set(a.id, a);
  return [...found.values()].sort((a, b) => `${b.created_at}${b.id}`.localeCompare(`${a.created_at}${a.id}`));
}

function appealControls(record, criterionId, detailAppeals) {
  const appeals = criterionAppeals(record, criterionId, detailAppeals);
  const open = appeals.find((a) => a.status === "pending");
  const shown = open ?? appeals[0];
  const link = shown ? `${stageBadge(shown)}<a class="btn btn-ghost" href="${esc(appealHref(shown.id))}">${esc(t("appeal.open"))}</a>` : "";
  if (open) return link;
  const expanded = appealDrafts[`${record.id}:${criterionId}`]?.open ? "true" : "false";
  return `${link}<button class="btn" type="button" data-appeal="${esc(criterionId)}" aria-expanded="${expanded}">${esc(t("appeal.button"))}</button>`;
}

function appealForm(record, criterionId) {
  const draft = appealDrafts[`${record.id}:${criterionId}`] ?? {};
  const fieldId = `appeal-${criterionId}`;
  return `<form class="form-grid appeal-form" data-appeal-form="${esc(criterionId)}" data-evaluation="${esc(record.id)}" ${draft.open ? "" : "hidden"} novalidate>
                <label class="field-label" for="${esc(fieldId)}">${esc(t("appeal.label"))}</label>
                <textarea class="input" id="${esc(fieldId)}" name="comment" rows="3" maxlength="2000" required placeholder="${esc(t("appeal.placeholder"))}">${esc(draft.text ?? "")}</textarea>
                ${draft.error ? `<p class="notice notice-error" role="alert">${esc(draft.error)}</p>` : ""}
                <div class="ui-btn-row">
                  <button class="btn btn-primary" type="submit" ${draft.busy ? "disabled" : ""}>${esc(t(draft.busy ? "appeal.submitting" : "appeal.submit"))}</button>
                </div>
              </form>`;
}

async function submitAppeal(form) {
  const criterionId = form.dataset.appealForm;
  const evaluationId = form.dataset.evaluation;
  const key = `${evaluationId}:${criterionId}`;
  const draft = (appealDrafts[key] ??= { open: true, text: "" });
  if (draft.busy) return;
  draft.text = form.comment.value;
  const comment = draft.text.trim();
  if (comment.length < 3) {
    draft.error = t("appeal.tooShort");
    render();
    document.getElementById(`appeal-${criterionId}`)?.focus();
    return;
  }
  draft.busy = true;
  draft.error = "";
  render();
  try {
    const appeal = await createAppeal({
      evaluation_id: evaluationId,
      criterion_id: criterionId,
      comment,
      explanation_language: uiLanguage(),
    });
    delete appealDrafts[key];
    mergeAppeal(appeal);
    loadAppeals();
  } catch (err) {
    draft.busy = false;
    draft.error = t("appeal.error", { error: errorText(err) });
  }
  render();
}

function criterionCard(view, sectionNames, record, detailAppeals) {
  const c = view.criterion;
  const r = view.final;
  const s = view.final_score;
  if (!r || !s) return "";
  const indicator = Number(c.weight) === 0;
  const tone = r.is_na ? "badge-info" : indicator ? (r.value === true ? "badge-crit" : "badge-good") : s.normalized === 0 ? "badge-crit" : "badge-good";
  const meta = indicator ? t("crit.indicator")
    : r.is_na ? t("crit.naWeight", { weight: num(c.weight) })
    : t("crit.weight", { weight: num(c.weight), applied: num(s.max_points), points: num(s.points) });
  const section = c.section_id ? sectionNames[c.section_id] ?? c.section_id : "";
  const flagged = r.severe_error && !indicator
    ? r.severe_error_reason && r.severe_error_reason !== r.explanation ? t("crit.flaggedReason", { reason: r.severe_error_reason }) : t("crit.flagged")
    : "";
  const revised = view.overridden && view.original ? t("crit.revised", { value: answerText(c, view.original, view.original_score ?? s) }) : "";
  const provider = record?.mode_type ? (view.original ?? r).provider : null;
  const answeredBy = provider ? ` · ${t("crit.by", { model: PROVIDER_NAMES[provider] ?? provider })}` : "";
  return `<article class="crit-card ${s.severe_error ? "severe" : ""}" id="crit-${esc(c.id)}">
              <div class="crit-top">
                <h3>${esc(c.name)}</h3>
                <span class="badge ${tone}">${esc(answerText(c, r, s))}</span>
              </div>
              <p class="crit-meta">${esc(meta)}${section ? ` · ${esc(section)}` : ""}${esc(answeredBy)}</p>
              ${revised ? `<p class="hint">${esc(revised)}</p>` : ""}
              <p>${esc(r.explanation)}</p>
              ${r.is_na && r.na_reason && r.na_reason !== r.explanation ? `<p class="hint">${esc(r.na_reason)}</p>` : ""}
              ${flagged ? `<p class="hint">${esc(flagged)}</p>` : ""}
              ${(r.inspected_spans ?? []).map((span) => `<p class="hint">${esc(t("crit.span", { start: span.start_index + 1, end: span.end_index + 1 }))}</p>`).join("")}
              <div class="crit-actions">${evidenceButtons(r.evidence)}${appealControls(record, c.id, detailAppeals)}</div>
              ${appealForm(record, c.id)}
            </article>`;
}

function evaluationPane(convId, shown) {
  const { record } = shown;
  const completed = record?.status === "completed" ? shown.detail : null;
  const sectionNames = Object.fromEntries((record?.checklist?.sections ?? []).map((s) => [s.id, s.name]));
  const sections = completed ? record.final_score?.sections ?? [] : [];
  return `
          <div class="pane-head"><h2>${esc(t("eval.title"))}</h2><span class="hint">${esc(evaluationMeta(shown))}</span></div>
          ${evaluationControls(convId, shown)}
          ${evaluationNotices(convId, shown)}
          ${sections.length ? `<div class="sections">
            ${sections.map((s) => `<span class="section-chip">${esc(s.name)} ${s.points == null ? esc(t("value.na")) : `${num(s.points)}/${num(s.max_points)}`}</span>`).join("")}
          </div>` : ""}
          ${completed ? completed.criteria.map((view) => criterionCard(view, sectionNames, record, completed.appeals)).join("") : ""}`;
}

// ---- Appeals --------------------------------------------------------------------------------------------
// The backend keeps every appeal with its GPT reassessments and the manager's decision. GPT only recommends: the
// manager confirms the original, accepts the recommendation or overrides it, and the backend recalculates.

const APPEALS_POLL_MS = 3000;
const REVIEWER_KEY = "cqa-reviewer";
const STAGE_TONE = { reassessing: "badge-info", ready_for_review: "badge-warn", reassessment_failed: "badge-crit", decided: "badge-good" };
let appealsTimer = null;
let appealsSignature = null;

function stageBadge(appeal) {
  return `<span class="badge ${STAGE_TONE[appeal.stage] ?? "badge-muted"}">${esc(t(`stage.${appeal.stage}`))}</span>`;
}

function mergeAppeal(appeal) {
  const index = state.appeals.findIndex((a) => a.id === appeal.id);
  if (index >= 0) state.appeals[index] = appeal;
  else state.appeals.unshift(appeal);
}

/** Reload every appeal; while one is being reassessed, check again in a few seconds. */
async function loadAppeals() {
  clearTimeout(appealsTimer);
  appealsTimer = null;
  try {
    state.appeals = await listAppeals();
    appealsStatus.error = "";
  } catch (err) {
    appealsStatus.error = errorText(err);
  } finally {
    appealsStatus.loading = false;
  }
  if (state.appeals.some((a) => a.stage === "reassessing")) appealsTimer = setTimeout(loadAppeals, APPEALS_POLL_MS);
  const signature = `${state.appeals.map((a) => `${a.id}:${a.stage}`).join("|")}#${appealsStatus.error}`;
  const changed = signature !== appealsSignature;
  appealsSignature = signature;
  if (changed && ["list", "appeals", "detail"].includes(route().name)) render();
}

/** The answers a manager can choose for this criterion (its configuration in the evaluated version). */
function answerOptions(criterion) {
  if (!criterion) return [];
  let values = [];
  if (criterion.answer_type === "binary") values = [true, false];
  else if (criterion.answer_type === "numeric") values = criterion.allowed_scores ?? [];
  else if (criterion.answer_type === "scale") values = scalePoints(criterion.scale) ?? [];
  else if (criterion.answer_type === "options") values = (criterion.options ?? []).map((o) => o.id);
  const options = values.map((value) => ({ value, na: false, label: valueText(criterion, value, false) }));
  if (criterion.na_allowed) options.push({ value: null, na: true, label: t("value.na") });
  return options;
}

/** A scored criterion may carry a critical-error flag; an indicator's answer is the flag itself. */
function flagAllowed(criterion) {
  return !!criterion?.severe_error_enabled && Number(criterion.weight) !== 0;
}

function sameValue(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return a === b;
}

function originalCell(appeal) {
  const r = appeal.disputed_result;
  const value = valueText(appeal.criterion_config, r?.value, r?.is_na);
  return appeal.disputed_max_points ? `${value} (${num(appeal.disputed_points)}/${num(appeal.disputed_max_points)})` : value;
}

function gptCell(appeal) {
  const gpt = appeal.reassessment;
  if (gpt?.status !== "completed") return '<span class="hint">—</span>';
  const tone = gpt.recommendation === "change" ? "badge-warn" : "badge-muted";
  return `<span class="badge ${tone}">${esc(t(`rec.${gpt.recommendation}`))}</span> ${esc(valueText(appeal.criterion_config, gpt.recommended_value, gpt.recommended_is_na))}`;
}

function finalCell(appeal) {
  const d = appeal.decision;
  if (!d) return '<span class="hint">—</span>';
  const result = d.new_result ?? d.previous_result;
  const score = d.percent_after != null ? ` · ${pct(d.percent_after)}` : "";
  return esc(`${t(`decision.${d.decision}`)}: ${valueText(appeal.criterion_config, result?.value, result?.is_na)}${score}`);
}

function viewAppeals() {
  const items = state.appeals;
  const title = esc(t("appeals.title"));
  if (!items.length) {
    if (appealsStatus.loading) return `<section class="empty"><h1>${title}</h1><p>${esc(t("appeals.loading"))}</p></section>`;
    if (appealsStatus.error) {
      return `<section class="empty"><h1>${title}</h1><p role="alert">${esc(t("appeals.loadError", { error: appealsStatus.error }))}</p>${Button(esc(t("common.retry")), { attrs: 'data-action="reload-appeals"' })}</section>`;
    }
    return `<section class="empty"><h1>${title}</h1><p>${esc(t("appeals.empty"))}</p><a class="btn btn-primary" href="#/">${esc(t("appeals.goHome"))}</a></section>`;
  }
  const open = items.filter((a) => a.status === "pending").length;
  return `
    <section class="library">
      <div class="page-head"><div><h1 class="studio-title">${title}</h1><p>${esc(t("appeals.summary", { open, total: items.length }))}</p></div></div>
      ${appealsStatus.error ? `<div class="notice notice-error" role="alert" style="margin-bottom:16px">${esc(t("appeals.loadError", { error: appealsStatus.error }))}</div>` : ""}
      <div class="table-wrap">
        <table>
          <thead><tr><th>${esc(t("appeals.th.conversation"))}</th><th>${esc(t("appeals.th.criterion"))}</th><th>${esc(t("appeals.th.original"))}</th><th>${esc(t("appeals.th.gpt"))}</th><th>${esc(t("appeals.th.status"))}</th><th>${esc(t("appeals.th.final"))}</th></tr></thead>
          <tbody>
            ${items.map((a) => `<tr>
                <td><a class="linkish" href="${esc(convHref(a.conversation_id))}">${esc(a.conversation_id)}</a></td>
                <td><a class="linkish" href="${esc(appealHref(a.id))}">${esc(a.criterion_name)}</a></td>
                <td class="num">${esc(originalCell(a))}</td>
                <td>${gptCell(a)}</td>
                <td>${stageBadge(a)}</td>
                <td>${finalCell(a)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </section>`;
}

// ---- Appeal review -----------------------------------------------------------------------------------------

const appealUi = {
  details: {}, // appeal id → AppealDetail
  loading: new Set(),
  polling: new Set(),
  errors: {}, // appeal id → load error
  retrying: {},
  saving: {},
  forms: {}, // appeal id → the decision form's values, kept across re-renders
  notices: {}, // appeal id → { tone, text }
};

function currentAppealId() {
  const current = route();
  return current.name === "appeal" ? current.id : null;
}

async function loadAppeal(id) {
  if (appealUi.loading.has(id)) return;
  appealUi.loading.add(id);
  try {
    const detail = await getAppeal(id);
    appealUi.details[id] = detail;
    delete appealUi.errors[id];
    mergeAppeal(detail.appeal);
    if (detail.appeal.stage === "reassessing") pollAppeal(id);
  } catch (err) {
    appealUi.errors[id] = errorText(err);
  } finally {
    appealUi.loading.delete(id);
  }
  if (currentAppealId() === id) render();
}

/** Follow GPT's reassessment until it is completed or failed. */
async function pollAppeal(id) {
  if (appealUi.polling.has(id)) return;
  appealUi.polling.add(id);
  try {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      let detail;
      try {
        detail = await getAppeal(id);
      } catch {
        continue; // Try again on the next tick; the page keeps showing the last known state.
      }
      appealUi.details[id] = detail;
      mergeAppeal(detail.appeal);
      if (detail.appeal.stage !== "reassessing") break;
    }
  } finally {
    appealUi.polling.delete(id);
  }
  if (currentAppealId() === id) render();
  loadAppeals();
}

async function retryReassessment(id) {
  if (appealUi.retrying[id]) return;
  appealUi.retrying[id] = true;
  appealUi.notices[id] = null;
  render();
  try {
    const appeal = await reassessAppeal(id);
    mergeAppeal(appeal);
    if (appealUi.details[id]) appealUi.details[id] = { ...appealUi.details[id], appeal, impact: null };
    if (appealUi.forms[id]) appealUi.forms[id].decision = null; // pick the default again once GPT has answered
    if (appeal.stage === "reassessing") pollAppeal(id);
    else loadAppeal(id);
    loadAppeals();
  } catch (err) {
    appealUi.notices[id] = { tone: "notice-error", text: t("ad.retryError", { error: errorText(err) }) };
  } finally {
    appealUi.retrying[id] = false;
  }
  if (currentAppealId() === id) render();
}

function decisionDefaults(detail) {
  const gpt = detail.appeal.reassessment;
  const canAccept = gpt?.status === "completed";
  const original = detail.appeal.disputed_result ?? detail.original_result;
  const target = canAccept ? { value: gpt.recommended_value, na: gpt.recommended_is_na } : { value: original?.value, na: !!original?.is_na };
  const options = answerOptions(detail.criterion);
  const index = options.findIndex((o) => (target.na ? o.na : !o.na && sameValue(o.value, target.value)));
  let reviewer = "";
  try {
    reviewer = localStorage.getItem(REVIEWER_KEY) ?? "";
  } catch {
    reviewer = "";
  }
  return {
    decision: null,
    value: String(Math.max(0, index)),
    critical: canAccept ? !!gpt.recommended_critical_error : !!original?.severe_error,
    explanation: "",
    reviewer,
  };
}

async function saveDecision(id) {
  const detail = appealUi.details[id];
  const form = appealUi.forms[id];
  if (!detail || !form || appealUi.saving[id]) return;
  const explanation = form.explanation.trim();
  if (explanation.length < 3) {
    appealUi.notices[id] = { tone: "notice-error", text: t("ad.explanationShort") };
    render();
    document.getElementById("decision-explanation")?.focus();
    return;
  }
  const reviewer = form.reviewer.trim();
  const body = { decision: form.decision, explanation, reviewer: reviewer || "Reviewer" };
  if (form.decision === "override") {
    const option = answerOptions(detail.criterion)[Number(form.value)];
    if (!option) return;
    body.override = {
      value: option.na ? null : option.value,
      is_na: option.na,
      severe_error: !option.na && flagAllowed(detail.criterion) && !!form.critical,
    };
  }
  appealUi.saving[id] = true;
  appealUi.notices[id] = null;
  render();
  try {
    const appeal = await decideAppeal(id, body);
    mergeAppeal(appeal);
    try {
      if (reviewer) localStorage.setItem(REVIEWER_KEY, reviewer);
    } catch {
      // Remembering the name is only a convenience.
    }
    delete appealUi.forms[id];
    appealUi.notices[id] = { tone: "notice-ok", text: t("ad.saved") };
    // The evaluation's final score changed: reload what shows it.
    delete evaluationUi.details[appeal.evaluation_id];
    delete evaluationUi.history[appeal.conversation_id];
    appealUi.saving[id] = false;
    await loadAppeal(id);
    loadScores();
    loadAppeals();
    return;
  } catch (err) {
    appealUi.notices[id] = { tone: "notice-error", text: t("ad.saveError", { error: errorText(err) }) };
  }
  appealUi.saving[id] = false;
  if (currentAppealId() === id) render();
}

function originalCard(detail) {
  const { appeal, criterion: c } = detail;
  const r = appeal.disputed_result ?? detail.original_result;
  if (!r) return "";
  const indicator = Number(c.weight) === 0;
  const tone = r.is_na ? "badge-info" : indicator ? (r.value === true ? "badge-crit" : "badge-good") : "badge-muted";
  const meta = [];
  if (!indicator && appeal.disputed_max_points) meta.push(t("ad.points", { points: num(appeal.disputed_points), max: num(appeal.disputed_max_points) }));
  if (appeal.percent_at_submission != null) meta.push(t("ad.atSubmission", { percent: pct(appeal.percent_at_submission) }));
  return `<article class="crit-card ${r.severe_error ? "severe" : ""}">
            <div class="crit-top"><h3>${esc(t("ad.original"))}</h3><span class="badge ${tone}">${esc(valueText(c, r.value, r.is_na))}</span></div>
            ${meta.length ? `<p class="crit-meta">${esc(meta.join(" · "))}</p>` : ""}
            ${c.description ? `<p class="hint">${esc(c.description)}</p>` : ""}
            <p>${esc(r.explanation)}</p>
            ${r.severe_error && !indicator ? `<p class="hint">${esc(t("crit.flagged"))}</p>` : ""}
            ${(r.evidence ?? []).length ? `<div class="crit-actions">${evidenceButtons(r.evidence)}</div>` : ""}
          </article>`;
}

function appealCard(appeal) {
  return `<article class="crit-card">
            <div class="crit-top"><h3>${esc(t("ad.appeal"))}</h3>${stageBadge(appeal)}</div>
            <p class="crit-meta">${esc(t("ad.submittedBy", { name: appeal.submitted_by, when: when(appeal.created_at) }))}</p>
            <p>${esc(appeal.comment)}</p>
          </article>`;
}

function gptCard(id, detail) {
  const { appeal, criterion: c, impact } = detail;
  const gpt = appeal.reassessment;
  const earlier = appeal.reassessments.slice(0, -1).filter((r) => r.status === "failed").length;
  const head = (badge) => `<div class="crit-top"><h3>${esc(t("ad.gpt"))}</h3>${badge}</div>`;
  const earlierHint = earlier ? `<p class="hint">${esc(tn("ad.earlierFailed", earlier))}</p>` : "";
  if (!gpt || gpt.status === "failed") {
    const error = gpt?.error;
    const message = error?.code && hasKey(`gpt.error.${error.code}`) ? t(`gpt.error.${error.code}`) : error?.message ?? "";
    const issues = error?.issues ?? [];
    const retrying = !!appealUi.retrying[id];
    const retry = appeal.status === "pending"
      ? `<p class="hint">${esc(t("ad.gptFailedNote"))}</p>
            <div class="crit-actions">${Button(esc(t(retrying ? "ad.retrying" : "ad.retry")), { attrs: `data-action="retry-reassessment" data-appeal-id="${esc(id)}"${retrying ? " disabled" : ""}` })}</div>`
      : "";
    return `<article class="crit-card">
            ${head(`<span class="badge badge-crit">${esc(t("stage.reassessment_failed"))}</span>`)}
            <p>${esc(t("ad.gptFailed"))} ${esc(message)}</p>
            ${issues.length ? `<ul>${issues.slice(0, 5).map((i) => `<li class="hint">${esc(i)}</li>`).join("")}</ul>` : ""}
            ${retry}
            ${earlierHint}
          </article>`;
  }
  if (gpt.status !== "completed") {
    return `<article class="crit-card">
            ${head(`<span class="badge badge-info">${esc(t("stage.reassessing"))}</span>`)}
            <p class="hint" role="status">${esc(t("ad.gptRunning", { version: appeal.checklist_version }))}</p>
            ${earlierHint}
          </article>`;
  }
  let impactText = "";
  if (impact && appeal.status === "pending") {
    impactText = impact.percent_before !== impact.percent_after
      ? t("ad.impact", { before: pct(impact.percent_before), after: pct(impact.percent_after) })
      : t("ad.impactSame", { percent: pct(impact.percent_after) });
  }
  const model = gpt.model || gpt.requested_model || gpt.reassessor;
  return `<article class="crit-card">
            ${head(`<span class="badge ${gpt.recommendation === "change" ? "badge-warn" : "badge-good"}">${esc(t(`rec.${gpt.recommendation}`))}</span>`)}
            <p class="crit-meta">${esc(t("ad.model", { model, when: when(gpt.completed_at) }))}</p>
            <p><strong>${esc(t("ad.recommended", { value: valueText(c, gpt.recommended_value, gpt.recommended_is_na) }))}</strong></p>
            ${gpt.recommended_critical_error ? `<p class="hint">${esc(t("ad.recommendedCritical"))}</p>` : ""}
            <p>${esc(gpt.rationale)}</p>
            ${impactText ? `<p class="hint">${esc(impactText)}</p>` : ""}
            ${(gpt.evidence ?? []).length ? `<div class="crit-actions">${evidenceButtons(gpt.evidence)}</div>` : ""}
            ${earlierHint}
          </article>`;
}

function decisionCard(id, detail) {
  const { appeal, criterion: c } = detail;
  const heading = `<div class="crit-top"><h3>${esc(t("ad.decision"))}</h3>`;
  const d = appeal.decision;
  if (d) {
    const result = d.new_result ?? d.previous_result;
    const score = d.percent_before != null && d.percent_after != null && d.percent_before !== d.percent_after
      ? t("ad.score", { before: pct(d.percent_before), after: pct(d.percent_after) })
      : t("ad.scoreSame", { percent: pct(d.percent_after ?? d.percent_before) });
    const follows = d.follows_gpt === true ? t("ad.followsGpt") : d.follows_gpt === false ? t("ad.differsGpt") : t("ad.noGpt");
    const critical = result?.severe_error && flagAllowed(c) ? ` · ${esc(t("value.critical"))}` : "";
    return `<article class="crit-card">
            ${heading}<span class="badge badge-good">${esc(t(`decision.${d.decision}`))}</span></div>
            <p class="crit-meta">${esc(t("ad.decidedBy", { reviewer: d.reviewer, when: when(d.decided_at) }))}</p>
            <p><strong>${esc(t("ad.final", { value: valueText(c, result?.value, result?.is_na) }))}</strong>${critical}</p>
            <p>${esc(d.explanation)}</p>
            <p class="hint">${esc(score)} · ${esc(follows)}</p>
          </article>`;
  }
  if (appeal.stage === "reassessing") {
    return `<article class="crit-card">${heading}</div><p class="hint">${esc(t("ad.waitGpt"))}</p></article>`;
  }
  const gpt = appeal.reassessment;
  const canAccept = gpt?.status === "completed";
  const form = (appealUi.forms[id] ??= decisionDefaults(detail));
  if (!form.decision || (form.decision === "accept" && !canAccept)) form.decision = canAccept ? "accept" : "confirm";
  const original = appeal.disputed_result ?? detail.original_result;
  const options = answerOptions(c);
  const choice = (value, label, disabled = false) =>
    `<option value="${value}" ${form.decision === value ? "selected" : ""} ${disabled ? "disabled" : ""}>${esc(label)}</option>`;
  const hidden = form.decision === "override" ? "" : "hidden";
  const saving = !!appealUi.saving[id];
  return `<form class="crit-card form-grid" data-decision-form="${esc(id)}" novalidate>
            ${heading}</div>
            <p class="hint">${esc(t("ad.gptOnlyRecommends"))}</p>
            <div>
              <label class="field-label" for="decision-kind">${esc(t("ad.decisionLabel"))}</label>
              <select class="input" id="decision-kind" name="decision">
                ${canAccept ? choice("accept", t("ad.opt.accept", { value: valueText(c, gpt.recommended_value, gpt.recommended_is_na) })) : ""}
                ${choice("confirm", t("ad.opt.confirm", { value: valueText(c, original?.value, original?.is_na) }))}
                ${choice("override", t("ad.opt.override"), !options.length)}
              </select>
            </div>
            <div data-when="override" ${hidden}>
              <label class="field-label" for="decision-answer">${esc(t("ad.value"))}</label>
              <select class="input" id="decision-answer" name="answer">
                ${options.map((o, i) => `<option value="${i}" ${String(i) === form.value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
              </select>
            </div>
            ${flagAllowed(c) ? `<div data-when="override" ${hidden}><label class="ui-check"><input type="checkbox" name="critical" ${form.critical ? "checked" : ""} /><span>${esc(t("ad.critical"))}</span></label></div>` : ""}
            <div>
              <label class="field-label" for="decision-explanation">${esc(t("ad.explanation"))}</label>
              <textarea class="input" id="decision-explanation" name="explanation" rows="3" maxlength="4000" required placeholder="${esc(t("ad.explanationPlaceholder"))}">${esc(form.explanation)}</textarea>
            </div>
            <div>
              <label class="field-label" for="decision-reviewer">${esc(t("ad.reviewer"))}</label>
              <input class="input" id="decision-reviewer" name="reviewer" maxlength="120" autocomplete="name" placeholder="${esc(t("ad.reviewerPlaceholder"))}" value="${esc(form.reviewer)}" />
            </div>
            <div class="ui-btn-row">
              ${Button(esc(t(saving ? "ad.saving" : "ad.save")), { variant: "primary", type: "submit", attrs: saving ? "disabled" : "" })}
            </div>
          </form>`;
}

function viewAppeal(id) {
  const detail = appealUi.details[id];
  if (!detail) {
    if (!appealUi.loading.has(id) && !appealUi.errors[id]) loadAppeal(id);
    const error = appealUi.errors[id];
    const body = error
      ? `<div class="notice notice-error" role="alert">${esc(t("ad.loadError", { error }))} ${Button(esc(t("common.retry")), { attrs: `data-action="reload-appeal" data-appeal-id="${esc(id)}"` })}</div>`
      : `<p class="hint">${esc(t("ad.loading"))}</p>`;
    return `<section class="page"><p><a href="#/appeals">${esc(t("nav.appeals"))}</a></p>${body}</section>`;
  }
  const { appeal, evaluation } = detail;
  const messages = (detail.transcript ?? []).map((m) => ({
    id: m.id, ts: m.timestamp, speaker: m.speaker, text: m.text,
    offsetSeconds: typeof m.offset_seconds === "number" ? m.offset_seconds : null,
  }));
  const notice = appealUi.notices[id];
  const sub = evaluation.original_percent != null && evaluation.final_percent !== evaluation.original_percent
    ? t("eval.originalFinal", { original: pct(evaluation.original_percent), final: pct(evaluation.final_percent) })
    : "";
  const meta = t("ad.meta", { checklist: evaluation.checklist_name, version: appeal.checklist_version, when: when(evaluation.completed_at) });
  return `
    <section class="page-wide">
      <div class="pane-head">
        <div>
          <a href="#/appeals">${esc(t("nav.appeals"))}</a>
          <h2 style="margin-top:4px">${esc(appeal.criterion_name)} · <a class="linkish" href="${esc(convHref(appeal.conversation_id))}">${esc(appeal.conversation_id)}</a></h2>
        </div>
        ${heroHtml(pct(evaluation.final_percent), sub, stageBadge(appeal))}
      </div>
      <div class="split">
        <div class="pane">
          <div class="pane-head"><h2>${esc(t("detail.transcript"))}</h2><span class="badge badge-muted">${esc(tn("detail.turns", messages.length))}</span></div>
          ${transcriptHtml(messages)}
        </div>
        <div class="pane">
          <div class="pane-head"><h2>${esc(t("ad.review"))}</h2><span class="hint">${esc(meta)}</span></div>
          ${notice ? noticeBox(notice.tone, esc(notice.text), notice.tone === "notice-error" ? "alert" : "status") : ""}
          ${detail.evaluation_stale ? noticeBox("notice-warn", esc(t("ad.stale"))) : ""}
          ${originalCard(detail)}
          ${appealCard(appeal)}
          ${gptCard(id, detail)}
          ${decisionCard(id, detail)}
        </div>
      </div>
    </section>`;
}

// ---- Checklist -----------------------------------------------------------------------------------------
// The page shows the unsaved draft when there is one, else the applied version. The criterion dialog changes
// the draft; "Save checklist" stores it in ATLAS as the next checklist version (or creates the checklist).

function checklistSubtitle() {
  const source = state.checklist.source;
  const parts = [source ? t("cl.version", { name: source.name, version: source.version }) : String(state.checklist.note ?? "").replace(/\.$/, "")];
  if (state.checklistDraft) parts.push(t("cl.unsaved"));
  return parts.join(" · ");
}

function checklistNotice() {
  if (!checklistStatus.error) return "";
  const reload = checklistStatus.conflictVersion
    ? Button(esc(t("cl.reload", { version: checklistStatus.conflictVersion })), { attrs: 'data-action="reload-checklist"' })
    : "";
  return `<div class="notice notice-error" role="alert" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px">
      <span>${esc(checklistStatus.error)}</span>${reload}
    </div>`;
}

function viewChecklist() {
  const config = editingConfig(state);
  return `
    <section class="library library-wide">
      <div class="page-head">
        <div>
          <h1 class="studio-title">${esc(t("cl.title"))}</h1>
          <p>${esc(checklistSubtitle())}</p>
        </div>
        <div class="ui-btn-row">
          ${Button(esc(t("cl.add")), { attrs: 'data-action="add-criterion"' })}
          ${Button(esc(t(checklistStatus.saving ? "cl.saving" : "cl.save")), { variant: "primary", attrs: `data-action="apply-checklist"${checklistStatus.saving ? " disabled" : ""}` })}
          ${Button(esc(t(applyUi.busy ? "cl.applying" : "cl.apply")), { attrs: `data-action="apply-all"${checklistStatus.saving || applyUi.busy ? " disabled" : ""}` })}
        </div>
      </div>
      ${checklistNotice()}
      <div class="card-grid">
        ${config.criteria.map((c) => {
          const section = sectionName(config, c.section_id);
          const tags = [t("cl.weight", { weight: fmt(c.weight) }), c.na_allowed ? t("cl.na") : "", c.severe_error_enabled ? t("cl.severe") : ""].filter(Boolean);
          return `
          <button type="button" class="lib-card ${c.enabled !== false ? "" : "is-off"}" data-open-edit="${esc(c.id)}">
            <h3>${esc(c.name)}</h3>
            <p>${esc(c.description)}</p>
            <span class="hint">${section ? `${esc(section)} · ` : ""}${esc(tags.join(" · "))}</span>
          </button>`;
        }).join("")}
      </div>
    </section>`;
}

function focusCard(id) {
  const card = [...document.querySelectorAll("[data-open-edit]")].find((el) => el.dataset.openEdit === id);
  (card ?? document.querySelector("[data-action='add-criterion']"))?.focus();
}

/** Open the criterion dialog for one criterion of the draft (or the applied version), or for a new one (id null). */
function openEditor(id) {
  const config = editingConfig(state);
  const criterion = id ? config.criteria.find((c) => c.id === id) : null;
  if (id && !criterion) return;
  const linked = state.checklistDraft ? !!state.checklistDraft.baseId : !!state.checklist.source;
  const baseVersion = state.checklistDraft ? state.checklistDraft.baseVersion : state.checklist.source?.version;
  const saveHint = linked
    ? t("cl.saveHintLinked", { title: state.checklist.title, version: (baseVersion ?? 0) + 1 })
    : t("cl.saveHintNew");
  const changed = () => {
    if (!checklistStatus.conflictVersion) checklistStatus.error = "";
    persist();
    render();
  };
  openCriterionEditor({
    criterion,
    config,
    saveHint,
    policy: config.scoring?.severe_error_policy ?? "flag_only",
    onSave: ({ criterion: next, section, originalId }) => {
      stageChange(state, (draft) => putCriterion(draft, originalId, next, section));
      changed();
      focusCard(next.id);
    },
    onRemove: (removedId) => {
      stageChange(state, (draft) => dropCriterion(draft, removedId));
      changed();
      focusCard(null);
    },
  });
}

let applyDialog = null;

function applyDialogHtml() {
  return `
    <div class="dialog-head">
      <div>
        <h2 id="apply-title" class="sheet-title">${esc(t("cl.applyTitle"))}</h2>
        <p class="hint" data-apply-hint></p>
      </div>
      <button type="button" class="dialog-close" data-apply-close aria-label="${esc(t("common.close"))}">
        <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <form class="dialog-panel" data-apply-form novalidate>
      ${Field(esc(t("cl.applyGroup")), `<span class="ui-select-wrap"><select class="ui-select" name="group_id"></select></span>`)}
      <div data-apply-status role="status" aria-live="polite"></div>
      <div class="dialog-actions">
        ${Button(esc(t("common.close")), { attrs: "data-apply-close" })}
        ${Button(esc(t("cl.apply")), { variant: "primary", type: "submit" })}
      </div>
    </form>`;
}

function openApplyAll() {
  const source = state.checklist.source;
  if (!source?.id) {
    checklistStatus.error = t("cl.applyNeedSave");
    render();
    return;
  }
  if (state.checklistDraft) {
    checklistStatus.error = t("cl.applyNeedSave");
    render();
    return;
  }
  if (!applyDialog) {
    applyDialog = document.createElement("dialog");
    applyDialog.className = "dialog";
    applyDialog.setAttribute("aria-labelledby", "apply-title");
    applyDialog.innerHTML = applyDialogHtml();
    document.body.append(applyDialog);
    const form = applyDialog.querySelector("[data-apply-form]");
    applyDialog.addEventListener("click", (e) => {
      if (e.target.closest("[data-apply-close]")) applyDialog.close();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      runApplyAll(form);
    });
  }
  const form = applyDialog.querySelector("[data-apply-form]");
  applyDialog.querySelector("[data-apply-hint]").textContent = t("cl.applyHint", {
    version: source.version, mode: modeLabel(evaluationUi.mode),
  });
  const status = form.querySelector("[data-apply-status]");
  status.replaceChildren();
  if (!applyDialog.open) applyDialog.showModal();
  loadApplyGroups(form);
}

async function loadApplyGroups(form) {
  const status = form.querySelector("[data-apply-status]");
  try {
    const overview = await cqaOverview();
    const groups = overview.by_group ?? [];
    form.group_id.innerHTML = groups.map((g) => `<option value="${esc(g.value)}">${esc(`${g.value} (${g.count})`)}</option>`).join("");
    if (!groups.length) setImportStatus(status, "warn", esc(t("cl.applyNone")));
  } catch (err) {
    setImportStatus(status, "error", esc(errorText(err)));
  }
}

async function runApplyAll(form) {
  const source = state.checklist.source;
  if (!source?.id || applyUi.busy) return;
  const group = form.group_id.value;
  if (!group) return;
  const mode = evaluationUi.mode;
  if (!window.confirm(t("cl.applyConfirm", { version: source.version, mode: modeLabel(mode), group }))) return;
  applyUi.busy = true;
  render();
  if (applyDialog?.open) applyDialog.close();
  try {
    const response = await startEvaluation({
      checklist_id: source.id,
      checklist_version: source.version,
      group_id: group,
      only_missing: true,
      mode_type: mode,
      explanation_language: uiLanguage(),
    });
    applyUi.busy = false;
    if (!applyDialog) return;
    applyDialog.showModal();
    const live = applyDialog.querySelector("[data-apply-status]");
    const counts = { queued: response.queued, done: 0, failed: 0 };
    setImportStatus(live, "info", esc(t("cl.applyProgress", counts)));
    for (let i = 0; i < 400 && applyDialog.open; i += 1) {
      const batch = await getBatch(response.batch_id);
      counts.done = batch.completed;
      counts.failed = batch.failed;
      counts.queued = batch.pending + batch.running;
      setImportStatus(live, batch.done ? (batch.failed ? "warn" : "ok") : "info",
        esc(t(batch.done ? "cl.applyDone" : "cl.applyProgress", counts)));
      if (batch.done) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    render();
  } catch (err) {
    applyUi.busy = false;
    if (applyDialog && !applyDialog.open) applyDialog.showModal();
    setImportStatus(applyDialog?.querySelector("[data-apply-status]"), "error", esc(t("cl.applyError", { error: errorText(err) })));
  }
}

/** Save the draft as the next version (or create the checklist in ATLAS). Evaluations run from a conversation. */
async function saveChecklist() {
  if (checklistStatus.saving) return;
  Object.assign(checklistStatus, { saving: true, error: "", conflictVersion: null });
  render();
  try {
    const draft = state.checklistDraft;
    let saved = null;
    if (draft?.baseId) {
      saved = await updateChecklist(draft.baseId, {
        base_version: draft.baseVersion,
        config: draft.config,
        note: changeNote(appliedConfig(state), draft.config),
      });
    } else if (draft || !state.checklist.source) {
      saved = await createChecklist({
        name: state.checklist.title || "Checklist",
        description: state.checklist.note ?? "",
        origin: "custom",
        config: editingConfig(state),
        note: "Created in the checklist editor",
      });
    }
    if (saved) adoptChecklist(state, saved);
    state.checklistDraft = null;
    checklistStatus.saving = false;
    forgetChecklists(saved?.id);
    persist();
    location.hash = "#/";
    render();
  } catch (err) {
    checklistStatus.saving = false;
    checklistStatus.error = t("cl.saveError", { error: errorText(err) });
    if (err.code === "stale_checklist") checklistStatus.conflictVersion = err.details?.latest_version ?? null;
    render();
  }
}

/** After a conflict: drop the draft and use the latest saved version. */
async function reloadChecklist() {
  const id = state.checklistDraft?.baseId ?? state.checklist.source?.id;
  if (!id) return;
  try {
    adoptChecklist(state, await getChecklist(id));
    state.checklistDraft = null;
    Object.assign(checklistStatus, { error: "", conflictVersion: null });
    forgetChecklists(id);
    persist();
  } catch (err) {
    checklistStatus.error = t("cl.loadError", { error: errorText(err) });
  }
  render();
}

/**
 * On start, use the checklist stored in ATLAS: the one used last, else the most recently updated one. Without
 * any, the browser's checklist stays and the first "Save checklist" creates it. An unsaved draft is kept.
 */
async function syncChecklist() {
  let list;
  try {
    list = await listChecklists();
  } catch {
    return; // The page keeps the applied checklist; saving reports an unreachable API.
  }
  const current = state.checklist.source?.id;
  if (current && !list.some((s) => s.id === current)) {
    // Deleted in ATLAS: keep its criteria unlinked, so the next save creates it again.
    state.checklist.source = null;
    if (state.checklistDraft?.baseId === current) state.checklistDraft.baseId = null;
  }
  const pick = list.find((s) => s.id === state.checklist.source?.id) ?? list.find((s) => !s.archived);
  const source = state.checklist.source;
  if (!pick || (source?.id === pick.id && source.version === pick.latest_version && state.checklistConfig)) {
    persist();
    return;
  }
  try {
    adoptChecklist(state, await getChecklist(pick.id));
  } catch {
    return;
  }
  persist();
  render();
}

/** After a checklist was saved or reloaded: the evaluation pane reloads the checklists and their versions. */
function forgetChecklists(savedId) {
  evaluationUi.checklists = null;
  evaluationUi.versions = {};
  if (savedId && evaluationUi.selection?.checklistId === savedId) evaluationUi.selection.version = null;
}

let heroLinkClose;

function bind() {
  heroLinkClose?.abort();
  heroLinkClose = null;
  try {
    mountMessageScroller(document.querySelector('[data-slot="message-scroller-provider"]'));
  } catch (err) {
    console.error(err);
  }
  bindOnboard();
  document.querySelector("[data-onboard='dismiss-coach']")?.addEventListener("click", () => {
    state.coachDone = true;
    persist();
    render();
  });
  document.querySelector("[data-chat-form]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = e.currentTarget.q;
    const text = input.value.trim();
    if (!text) return;
    pushTurn(state, text);
    persist();
    render();
    document.querySelector("[data-chat-form] input")?.focus();
  });
  const heroImport = document.querySelector("[data-hero-import]");
  if (heroImport) {
    const rememberModel = () => chooseMode(heroImport.model?.value === "openai" ? 2 : 1);
    heroImport.addEventListener("submit", (e) => {
      e.preventDefault();
      rememberModel();
      importFromHero(heroImport.q.value, heroImport.elements.namedItem("import_method")?.value);
    });
    const layoutMethodThumb = (animate) => {
      const track = heroImport.querySelector(".hero-method");
      const thumb = heroImport.querySelector("[data-hero-method-thumb]");
      const on = heroImport.querySelector("[data-hero-method].is-on");
      if (!track || !thumb || !on) return;
      const tr = track.getBoundingClientRect();
      const br = on.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(track).paddingLeft) || 0;
      thumb.style.transition = animate ? "" : "none";
      thumb.style.width = `${br.width}px`;
      thumb.style.transform = `translateX(${br.left - tr.left - pad}px)`;
      if (!animate) requestAnimationFrame(() => { thumb.style.transition = ""; });
    };
    const setHeroMethod = (method) => {
      heroMethod = method === "json" ? "json" : "api";
      const methodField = heroImport.elements.namedItem("import_method");
      if (methodField) methodField.value = heroMethod;
      heroImport.querySelectorAll("[data-hero-method]").forEach((btn) => {
        btn.classList.toggle("is-on", btn.dataset.heroMethod === heroMethod);
      });
      const track = heroImport.querySelector(".hero-method");
      track?.setAttribute("aria-checked", heroMethod === "json" ? "true" : "false");
      heroImport.q.placeholder = t(heroMethod === "json" ? "list.heroPlaceholderJson" : "list.heroPlaceholderApi");
      layoutMethodThumb(true);
    };
    const methodTrack = heroImport.querySelector(".hero-method");
    const flipMethod = () => setHeroMethod(heroMethod === "json" ? "api" : "json");
    methodTrack?.addEventListener("click", flipMethod);
    methodTrack?.addEventListener("keydown", (e) => {
      if (e.key !== " " && e.key !== "Enter") return;
      e.preventDefault();
      flipMethod();
    });
    layoutMethodThumb(false);
    const modelBtn = heroImport.querySelector("[data-hero-model-btn]");
    const modelMenu = heroImport.querySelector("[data-hero-model-menu]");
    const setModelMenu = (on) => {
      if (!modelMenu) return;
      modelMenu.hidden = !on;
      modelBtn?.setAttribute("aria-expanded", String(on));
    };
    const pickModel = (value) => {
      const openai = value === "openai";
      heroImport.model.value = openai ? "openai" : "gemma";
      const label = openai ? t("list.modelOpenai") : t("list.modelQwen");
      heroImport.querySelector("[data-hero-model-label]").textContent = label;
      modelMenu.querySelectorAll("[data-model]").forEach((item) => {
        const on = item.dataset.model === heroImport.model.value;
        item.classList.toggle("is-on", on);
        item.setAttribute("aria-selected", String(on));
        item.querySelector(".hero-model-check").innerHTML = on ? icon.check : "";
      });
      rememberModel();
      setModelMenu(false);
    };
    modelBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      setModelMenu(modelMenu.hidden);
    });
    modelMenu?.addEventListener("click", (e) => {
      const item = e.target.closest("[data-model]");
      if (item) pickModel(item.dataset.model);
    });
    heroImport.querySelector("[data-hero-file]")?.addEventListener("click", () => {
      rememberModel();
      setModelMenu(false);
      openUploadPanel();
    });
    heroLinkClose = new AbortController();
    document.addEventListener("pointerdown", (e) => {
      if (!modelMenu?.hidden && !heroImport.querySelector(".hero-model")?.contains(e.target)) setModelMenu(false);
    }, { signal: heroLinkClose.signal });
  }
  document.querySelector("[data-action='add-criterion']")?.addEventListener("click", () => openEditor(null));
  document.querySelector("[data-action='apply-checklist']")?.addEventListener("click", () => saveChecklist());
  document.querySelector("[data-action='apply-all']")?.addEventListener("click", () => openApplyAll());
  document.querySelector("[data-action='reload-checklist']")?.addEventListener("click", () => reloadChecklist());
  document.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => jumpToMessage(btn.dataset.jump, btn.dataset.offset));
  });
  const evaluateForm = document.querySelector("[data-evaluate-form]");
  if (evaluateForm) {
    const convId = currentDetailId();
    evaluateForm.addEventListener("submit", (e) => {
      e.preventDefault();
      runEvaluation(convId);
    });
    evaluateForm.elements.namedItem("checklist")?.addEventListener("change", (e) => {
      evaluationUi.selection = { checklistId: e.target.value, version: null };
      render();
    });
    evaluateForm.elements.namedItem("mode")?.addEventListener("change", (e) => {
      chooseMode(Number(e.target.value));
      render();
    });
    evaluateForm.elements.namedItem("version")?.addEventListener("change", (e) => {
      const selection = currentSelection();
      if (!selection) return;
      const chosen = Number(e.target.value);
      const latest = checklistSummary(selection.checklistId)?.latest_version;
      evaluationUi.selection = { checklistId: selection.checklistId, version: chosen === latest ? null : chosen };
      render();
    });
  }
  document.querySelector("[data-rerun]")?.addEventListener("click", (e) => retryEvaluation(currentDetailId(), e.currentTarget));
  document.querySelectorAll("[data-appeal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const form = btn.closest(".crit-card")?.querySelector("[data-appeal-form]");
      if (!form) return;
      const draft = (appealDrafts[`${form.dataset.evaluation}:${form.dataset.appealForm}`] ??= { text: "" });
      draft.open = form.hidden;
      form.hidden = !draft.open;
      btn.setAttribute("aria-expanded", String(draft.open));
      if (draft.open) form.comment.focus();
    });
  });
  document.querySelectorAll("[data-appeal-form]").forEach((form) => {
    const key = `${form.dataset.evaluation}:${form.dataset.appealForm}`;
    form.comment.addEventListener("input", () => {
      (appealDrafts[key] ??= { open: true }).text = form.comment.value;
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitAppeal(form);
    });
  });
  const decisionForm = document.querySelector("[data-decision-form]");
  if (decisionForm) {
    const id = decisionForm.dataset.decisionForm;
    const field = (name) => decisionForm.elements.namedItem(name);
    const sync = () => {
      const form = appealUi.forms[id];
      if (!form) return;
      form.decision = field("decision").value;
      if (field("answer")) form.value = field("answer").value;
      if (field("critical")) form.critical = field("critical").checked;
      form.explanation = field("explanation").value;
      form.reviewer = field("reviewer").value;
      decisionForm.querySelectorAll("[data-when='override']").forEach((el) => { el.hidden = form.decision !== "override"; });
    };
    decisionForm.addEventListener("input", sync);
    decisionForm.addEventListener("change", sync);
    decisionForm.addEventListener("submit", (e) => {
      e.preventDefault();
      sync();
      saveDecision(id);
    });
  }
}

function applyFilters() {
  const q = document.querySelector('[data-filter="q"]')?.value ?? "";
  const lang = document.querySelector('[data-filter="lang"]')?.value ?? "";
  const source = document.querySelector('[data-filter="source"]')?.value ?? "";
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (lang) params.set("lang", lang);
  if (source) params.set("source", source);
  const qs = params.toString();
  location.hash = qs ? `/?${qs}` : "/";
}

// ---- Import conversations ------------------------------------------------------------------------------
// One dialog, two methods. Both go to the backend, which validates, de-duplicates and stores the records with
// the same ingestion code; the list is then reloaded from the backend. The dialog lives outside #view, so
// re-rendering the page behind it never clears a pasted document.

const jsonPlaceholder = () => `${t("imp.jsonPlaceholder")}
{
  "error": "",
  "isSuccess": true,
  "data": {
    "dataset_group_id": "DEV",
    "total_records": 65,
    "records": [
      { "conversation_id": "…", "channel": "…", "language": "…", "transcript": [ … ], "audio_url": null }
    ]
  }
}`;

let importDialog = null;

function importDialogHtml() {
  const tab = (key, label, selected) => `<button type="button" class="tab" role="tab" id="import-tab-${key}"
    aria-controls="import-panel-${key}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}"
    data-import-tab="${key}">${esc(label)}</button>`;
  const actions = (label) => `<div class="dialog-actions">
      ${Button(esc(t("common.cancel")), { attrs: "data-import-close" })}
      ${Button(esc(label), { variant: "primary", type: "submit" })}
    </div>`;
  return `
    <div class="dialog-head">
      <div>
        <h2 id="import-title" class="sheet-title">${esc(t("imp.title"))}</h2>
        <p class="hint">${esc(t("imp.hint"))}</p>
      </div>
      <button type="button" class="dialog-close" data-import-close aria-label="${esc(t("common.close"))}">
        <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="tabs" role="tablist" aria-label="${esc(t("imp.method"))}">
      ${tab("api", t("imp.tabApi"), true)}
      ${tab("json", t("imp.tabJson"), false)}
    </div>
    <form class="dialog-panel" id="import-panel-api" role="tabpanel" aria-labelledby="import-tab-api" data-import-form="api" novalidate>
      ${Field(esc(t("imp.groupId")), `<input class="ui-input" name="group_id" type="text" placeholder="${esc(t("imp.groupPlaceholder"))}" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" />`)}
      <p class="hint" data-import-source>${esc(t("imp.sourceHint"))}</p>
      <div data-import-status role="status" aria-live="polite"></div>
      ${actions(t("imp.import"))}
    </form>
    <form class="dialog-panel" id="import-panel-json" role="tabpanel" aria-labelledby="import-tab-json" data-import-form="json" novalidate hidden>
      ${Field(esc(t("imp.jsonLabel")), `<textarea class="ui-textarea import-json" name="json" rows="14" wrap="off" autocomplete="off" spellcheck="false" placeholder="${esc(jsonPlaceholder())}"></textarea>`)}
      <div data-import-status role="status" aria-live="polite"></div>
      ${actions(t("imp.importJson"))}
    </form>`;
}

function selectImportTab(key, focus = false) {
  importDialog.querySelectorAll("[data-import-tab]").forEach((btn) => {
    const on = btn.dataset.importTab === key;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    if (on && focus) btn.focus();
  });
  importDialog.querySelectorAll("[data-import-form]").forEach((form) => {
    form.hidden = form.dataset.importForm !== key;
  });
}

function activeImportField() {
  return importDialog.querySelector("[data-import-form]:not([hidden]) input, [data-import-form]:not([hidden]) textarea");
}

function setImportStatus(el, tone, html) {
  el.className = tone === "info" ? "notice" : `notice notice-${tone}`;
  el.innerHTML = html;
}

function importSummary(run) {
  const counts = t("imp.counts", { created: run.created, updated: run.updated, unchanged: run.unchanged, rejected: run.rejected });
  const head = t(run.status === "failed" ? "imp.failedHead" : "imp.okHead", { group: run.group_id });
  const reported = run.reported_total != null && run.reported_total !== run.received ? t("imp.reported", { total: run.reported_total }) : "";
  let html = `<strong>${esc(head)}</strong> ${esc(counts)}.<br>${esc(tn("imp.received", run.received, { reported }))}`;
  const issues = run.issues ?? [];
  if (issues.length) {
    const where = (i) => i.conversation_id ?? (i.record_index != null ? t("imp.record", { n: i.record_index + 1 }) : t("imp.whereImport"));
    html += `<ul>${issues.slice(0, 6).map((i) => `<li>${esc(`${where(i)}: ${i.message}`)}</li>`).join("")}</ul>`;
    if (issues.length > 6) html += `<p class="hint">${esc(t("imp.more", { count: issues.length - 6 }))}</p>`;
  }
  return html;
}

/** JSON.parse's message, plus line and column when the engine only reports a character position. */
function jsonError(err, text) {
  const message = String(err?.message || t("imp.invalidJson"));
  const pos = message.match(/position (\d+)/);
  if (!pos || /line \d+/i.test(message)) return message;
  const before = text.slice(0, Number(pos[1]));
  return t("imp.lineCol", { message, line: before.split("\n").length, column: before.length - before.lastIndexOf("\n") });
}

const RAW_SPEAKERS = {
  client: "client", customer: "client", клиент: "client",
  operator: "operator", agent: "operator", оператор: "operator",
  bot: "bot", бот: "bot",
  system: "system", система: "system",
};

function conversationFromRaw(record) {
  let transcript = record.transcript ?? record.messages;
  if (typeof transcript === "string") {
    try { transcript = JSON.parse(transcript); } catch { transcript = []; }
  }
  const lines = Array.isArray(transcript) ? transcript : [];
  const channel = String(record.channel || "");
  return {
    id: String(record.conversation_id || record.id || ""),
    groupIds: [],
    language: String(record.language || "").toLowerCase(),
    source: /voice|call|звон/i.test(channel) ? "call" : "chat",
    channel,
    operator: "",
    audioUrl: record.audio_url ?? null,
    messages: lines.map((line, index) => ({
      id: String(line?.id || `m${index + 1}`),
      ts: line?.timestamp ?? line?.ts ?? "",
      speaker: RAW_SPEAKERS[String(line?.speaker || "").trim().toLowerCase()] || "unknown",
      text: line?.text == null ? "" : String(line.text),
    })),
  };
}

function payloadRecords(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload)) return payload;
  const records = payload?.data?.records ?? payload?.records;
  if (Array.isArray(records)) return records;
  if (payload.transcript || payload.messages || payload.conversation_id) return [payload];
  return [];
}

function conversationsFromPayload(payload) {
  return payloadRecords(payload).filter((record) => record && typeof record === "object").map(conversationFromRaw).filter((conv) => conv.id);
}

function payloadConversationId(payload) {
  return conversationsFromPayload(payload)[0]?.id || "";
}

/** Show the JSON as a chat at once, then import and score it behind that dialog. */
async function loadIntoDialog(task, hintedId, payload = null) {
  const locals = conversationsFromPayload(payload);
  if (locals.length) stageLocalConversations(locals);
  const id = hintedId || locals[0]?.id || "";
  pendingOpen = locals.length ? null : { id, error: "" };
  const href = id ? convHref(id) : "#/conversations/_loading";
  importDialog?.close();
  uploadDialog?.close();
  if (location.hash !== href) location.hash = href;
  else render();
  try {
    const run = await task();
    await reloadConversations();
    const here = currentDetailId();
    const stillHere = here === id || here === "_loading";
    if (!stillHere) {
      pendingOpen = null;
      return;
    }
    const landed = (id && state.conversations.find((c) => c.id === id)) || locals[0] || state.conversations[0];
    if (!landed) {
      pendingOpen = { id, error: run?.issues?.[0]?.message || t("detail.notFound") };
      render();
      return;
    }
    pendingOpen = null;
    const next = convHref(landed.id);
    if (location.hash !== next) location.hash = next;
    else render();
  } catch (err) {
    if (!locals.length) pendingOpen = { id, error: errorText(err) };
    if (currentDetailId() === id || currentDetailId() === "_loading") render();
  }
}

async function runImport(form) {
  const status = form.querySelector("[data-import-status]");
  let call;
  let hinted = "";
  let payload = null;
  if (form.dataset.importForm === "api") {
    const groupId = form.group_id.value.trim();
    if (!groupId) return setImportStatus(status, "error", esc(t("imp.needGroup")));
    if (!GROUP_ID_RE.test(groupId)) return setImportStatus(status, "error", esc(t("imp.badGroup")));
    call = () => importGroup(groupId);
  } else {
    const text = form.json.value;
    if (!text.trim()) return setImportStatus(status, "error", esc(t("imp.needJson")));
    try {
      payload = JSON.parse(text);
    } catch (err) {
      return setImportStatus(status, "error", esc(t("imp.notJson", { error: jsonError(err, text) })));
    }
    hinted = payloadConversationId(payload);
    call = () => importJson(payload);
  }
  await loadIntoDialog(call, hinted, payload);
}

async function refreshSourceHint() {
  const hint = importDialog.querySelector("[data-import-source]");
  try {
    const info = await cqaInfo();
    hint.textContent = t(info.source_configured ? "imp.sourceHint" : "imp.sourceMissing");
    hint.classList.toggle("hint-warn", !info.source_configured);
  } catch {
    // An unreachable API is reported by the import itself.
  }
}

function bindImportDialog(dialog) {
  dialog.addEventListener("click", (e) => {
    if (e.target.closest("[data-import-close]")) {
      dialog.close();
      return;
    }
    const tab = e.target.closest("[data-import-tab]");
    if (tab) {
      selectImportTab(tab.dataset.importTab);
      activeImportField()?.focus();
      return;
    }
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) dialog.close();
    }
  });
  dialog.querySelector("[role='tablist']").addEventListener("keydown", (e) => {
    const keys = ["api", "json"];
    const current = keys.indexOf(dialog.querySelector("[data-import-tab][aria-selected='true']").dataset.importTab);
    const next = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: keys.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    selectImportTab(keys[(next + keys.length) % keys.length], true);
  });
  dialog.querySelectorAll("[data-import-form]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      runImport(form);
    });
  });
}

let uploadDialog = null;

async function acceptDroppedFile(root, file, onText) {
  if (!file || !root) return;
  const err = jsonFileError(file);
  if (err) {
    setFileDropError(root, err);
    return;
  }
  setFileDropError(root, "");
  setFileDropBusy(root, file.name, 0, file.size);
  let text;
  try {
    text = await readDropFile(root, file, (loaded, total) => setFileDropBusy(root, file.name, loaded, total));
  } catch (err) {
    if (err?.message === "aborted") return;
    setFileDropError(root, t("list.dropReadError"));
    return;
  }
  setFileDropBusy(root, file.name, file.size, file.size);
  await onText(text, file);
  showFileName(root, file.name);
}

function uploadPanelHtml() {
  return `
    <div class="dialog-head">
      <div>
        <h2 id="upload-title" class="sheet-title">${esc(t("list.attachJson"))}</h2>
      </div>
      <button type="button" class="dialog-close" data-upload-close aria-label="${esc(t("common.close"))}">
        <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    ${fileDropHtml({
      title: t("list.dropTitle"),
      hint: t("list.dropHint"),
      choose: t("list.dropChoose"),
    })}`;
}

async function takeJsonFile(file) {
  const root = uploadDialog?.querySelector("[data-file-drop]");
  await acceptDroppedFile(root, file, async (text) => {
    if (!uploadDialog?.open) return;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      uploadDialog.close();
      openImport(text, "json");
      return;
    }
    await loadIntoDialog(() => importJson(payload), payloadConversationId(payload), payload);
  });
}

function bindUploadDialog(dialog) {
  const root = dialog.querySelector("[data-file-drop]");
  bindFileDrop(root, { onFile: (file) => takeJsonFile(file) });
  dialog.addEventListener("click", (e) => {
    if (e.target.closest("[data-upload-close]")) dialog.close();
  });
  dialog.addEventListener("close", () => resetFileDrop(root));
}

function openUploadPanel() {
  if (!uploadDialog) {
    uploadDialog = document.createElement("dialog");
    uploadDialog.className = "dialog dialog-upload";
    uploadDialog.setAttribute("aria-labelledby", "upload-title");
    uploadDialog.innerHTML = uploadPanelHtml();
    document.body.append(uploadDialog);
    bindUploadDialog(uploadDialog);
  } else {
    resetFileDrop(uploadDialog.querySelector("[data-file-drop]"));
  }
  if (!uploadDialog.open) uploadDialog.showModal();
}

function looksJson(text) {
  const s = String(text || "").trim();
  return s.startsWith("{") || s.startsWith("[");
}

async function importFromHero(raw, method = heroMethod) {
  const text = String(raw || "").trim();
  const asJson = method === "json";
  if (!text) {
    openImport("", asJson ? "json" : "api");
    return;
  }
  if (asJson || looksJson(text)) {
    openImport(text, "json");
    return;
  }
  if (/^https?:\/\//i.test(text)) {
    try {
      const res = await fetch(text, { signal: AbortSignal.timeout(8000) });
      const body = await res.text();
      if (res.ok && looksJson(body)) {
        openImport(body, "json");
        return;
      }
    } catch {
      // The file is opened in the dialog so the paste can be fixed by hand.
    }
    openImport(text, asJson ? "json" : "api");
    return;
  }
  openImport(text, asJson ? "json" : "api");
}

function openImport(seed = "", tab = "") {
  if (!importDialog) {
    importDialog = document.createElement("dialog");
    importDialog.className = "dialog";
    importDialog.setAttribute("aria-labelledby", "import-title");
    importDialog.innerHTML = importDialogHtml();
    document.body.append(importDialog);
    bindImportDialog(importDialog);
  }
  const text = String(seed || "").trim();
  const jsonTab = tab === "json" || (tab !== "api" && looksJson(text));
  if (jsonTab) {
    selectImportTab("json");
    const json = importDialog.querySelector('[data-import-form="json"] textarea');
    if (json) json.value = text;
  } else if (text) {
    selectImportTab("api");
    const group = importDialog.querySelector('[data-import-form="api"] [name="group_id"]');
    if (group) group.value = text;
  }
  if (!importDialog.open) importDialog.showModal();
  activeImportField()?.focus();
  refreshSourceHint();
}

// ---- Results export: the organizers' results.json (JSON 1.0), built by the backend from stored evaluations ----

let exportDialog = null;
let exportReport = null;

function exportDialogHtml() {
  const select = (name) => `<span class="ui-select-wrap"><select class="ui-select" name="${name}"></select></span>`;
  return `
    <div class="dialog-head">
      <div>
        <h2 id="export-title" class="sheet-title">${esc(t("exp.title"))}</h2>
        <p class="hint">${esc(t("exp.hint"))}</p>
      </div>
      <button type="button" class="dialog-close" data-export-close aria-label="${esc(t("common.close"))}">
        <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <form class="dialog-panel" data-export-form novalidate>
      ${Field(esc(t("exp.dataset")), select("group_id"))}
      ${Field(esc(t("exp.set")), `<span class="ui-select-wrap"><select class="ui-select" name="target">
        <option value="dev">DEV — results/dev/results.json (65)</option>
        <option value="prod">PROD — results/prod/results.json (10)</option>
        <option value="">${esc(t("exp.setOther"))}</option>
      </select></span>`)}
      ${Field(esc(t("eval.checklist")), select("checklist_id"))}
      ${Field(esc(t("exp.version")), select("checklist_version"))}
      ${Field(esc(t("exp.team")), `<input class="ui-input" name="team_name" type="text" maxlength="200" autocomplete="off" spellcheck="false" />`)}
      <div data-export-status role="status" aria-live="polite"></div>
      <div class="dialog-actions" style="flex-wrap: wrap">
        ${Button(esc(t("common.close")), { attrs: "data-export-close" })}
        ${Button(esc(t("exp.check")), { type: "submit" })}
        ${Button(esc(t("exp.download")), { variant: "primary", attrs: "data-export-download disabled" })}
      </div>
    </form>`;
}

function exportParams(form) {
  const params = { group_id: form.group_id.value, checklist_id: form.checklist_id.value };
  if (form.target.value) params.target = form.target.value;
  if (form.checklist_version.value) params.checklist_version = form.checklist_version.value;
  const team = form.team_name.value.trim();
  if (team) params.team_name = team; // empty: the server's ATLAS_CQA_TEAM_NAME
  return params;
}

function exportStatusHtml(report) {
  const s = report.summary;
  const missing = s.missing + s.mock_only + s.stale + s.incompatible;
  let html = `<strong>${esc(report.ready ? t("exp.ready", { count: s.exported }) : t("exp.notReady"))}</strong><br>`;
  html += esc(t("exp.counts", { total: s.conversations, chats: s.chats, calls: s.calls, ok: s.ok, error: s.error, missing, running: s.in_progress, appeals: s.with_accepted_appeals }));
  html += `<br>${esc(t("exp.model", { name: report.document.model.name || "—", mode: report.document.model.mode || "—" }))}`;
  const issues = report.issues;
  if (issues.length) {
    html += `<ul>${issues.slice(0, 6).map((i) => `<li>${esc(i.message)}</li>`).join("")}</ul>`;
    if (issues.length > 6) html += `<p class="hint">${esc(t("imp.more", { count: issues.length - 6 }))}</p>`;
  }
  if (s.missing + s.stale > 0 && !s.in_progress) {
    const mode = evaluationUi.mode;
    html += `<p class="hint">${esc(t("exp.evaluateHint", { mode: modeLabel(mode), hint: modeHint(mode) }))}</p>${Button(esc(t("exp.evaluate", { mode: modeLabel(mode) })), { attrs: "data-export-evaluate" })}`;
  }
  return html;
}

async function checkExport(form) {
  const status = form.querySelector("[data-export-status]");
  const download = form.querySelector("[data-export-download]");
  download.disabled = true;
  if (!form.group_id.value || !form.checklist_id.value) {
    setImportStatus(status, "warn", esc(t("exp.noDatasets")));
    return null;
  }
  setImportStatus(status, "info", esc(t("exp.checking")));
  try {
    exportReport = await resultsReport(exportParams(form));
    if (!form.team_name.value.trim() && exportReport.team_name) form.team_name.value = exportReport.team_name;
    setImportStatus(status, exportReport.ready ? "ok" : "warn", exportStatusHtml(exportReport));
    download.disabled = !exportReport.ready;
    return exportReport;
  } catch (err) {
    exportReport = null;
    setImportStatus(status, "error", esc(errorText(err)));
    return null;
  }
}

async function loadExportVersions(form) {
  const id = form.checklist_id.value;
  const versions = id ? await listChecklistVersions(id).catch(() => []) : [];
  form.checklist_version.innerHTML = `<option value="">${esc(t("exp.anyVersion"))}</option>`
    + versions.map((v) => `<option value="${v.version}">${esc(t("exp.versionOption", { version: v.version, count: v.evaluations }))}</option>`).join("");
}

async function loadExportOptions(form) {
  const status = form.querySelector("[data-export-status]");
  try {
    const [overview, checklists] = await Promise.all([cqaOverview(), listChecklists()]);
    const groups = overview.by_group ?? [];
    const previous = form.group_id.value;
    form.group_id.innerHTML = groups.map((g) => `<option value="${esc(g.value)}">${esc(`${g.value} (${g.count})`)}</option>`).join("");
    if (groups.some((g) => g.value === previous)) form.group_id.value = previous;
    const official = checklists.find((c) => c.template_id === "freedom-broker-official") ?? checklists.find((c) => c.official_format_compatible);
    form.checklist_id.innerHTML = checklists.map((c) => `<option value="${esc(c.id)}">${esc(c.official_format_compatible ? c.name : `${c.name} — ${t("exp.notOfficial")}`)}</option>`).join("");
    if (official) form.checklist_id.value = official.id;
    await loadExportVersions(form);
    await checkExport(form);
  } catch (err) {
    setImportStatus(status, "error", esc(errorText(err)));
  }
}

/** Queue GPT for the conversations that have no result yet (paid: asks first), then follow the status. */
async function evaluateMissing(form) {
  if (!exportReport || !window.confirm(t("exp.evaluateConfirm", { mode: modeLabel(evaluationUi.mode) }))) return;
  const status = form.querySelector("[data-export-status]");
  const body = { checklist_id: form.checklist_id.value, group_id: form.group_id.value, only_missing: true, explanation_language: uiLanguage(), mode_type: evaluationUi.mode };
  if (form.checklist_version.value) body.checklist_version = Number(form.checklist_version.value);
  try {
    const response = await startEvaluation(body);
    setImportStatus(status, "info", esc(t("exp.queued", { queued: response.queued, skipped: response.skipped })));
  } catch (err) {
    setImportStatus(status, "error", esc(t("eval.startError", { error: errorText(err) })));
    return;
  }
  for (let i = 0; i < 400 && exportDialog?.open; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (!exportDialog?.open) break;
    const report = await checkExport(form);
    if (!report || !report.summary.in_progress) break;
  }
}

async function downloadExport(form) {
  const status = form.querySelector("[data-export-status]");
  try {
    const text = await resultsFile(exportParams(form));
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "results.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    setImportStatus(status, "error", esc(errorText(err)));
  }
}

function bindExportDialog(dialog) {
  const form = dialog.querySelector("[data-export-form]");
  dialog.addEventListener("click", (e) => {
    if (e.target.closest("[data-export-close]")) {
      dialog.close();
      return;
    }
    if (e.target.closest("[data-export-download]")) {
      e.preventDefault();
      downloadExport(form);
      return;
    }
    if (e.target.closest("[data-export-evaluate]")) {
      e.preventDefault();
      evaluateMissing(form);
      return;
    }
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) dialog.close();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    checkExport(form);
  });
  form.checklist_id.addEventListener("change", async () => {
    await loadExportVersions(form);
    checkExport(form);
  });
  ["group_id", "target", "checklist_version"].forEach((name) => form[name].addEventListener("change", () => checkExport(form)));
}

function openExport() {
  if (!exportDialog) {
    exportDialog = document.createElement("dialog");
    exportDialog.className = "dialog";
    exportDialog.setAttribute("aria-labelledby", "export-title");
    exportDialog.innerHTML = exportDialogHtml();
    document.body.append(exportDialog);
    bindExportDialog(exportDialog);
  }
  if (!exportDialog.open) exportDialog.showModal();
  loadExportOptions(exportDialog.querySelector("[data-export-form]"));
}

document.querySelector('[data-filter="q"]')?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  applyFilters();
});

document.addEventListener(
  "click",
  (e) => {
    if (e.target.closest("[data-action='open-import']")) {
      e.preventDefault();
      openImport();
      return;
    }
    if (e.target.closest("[data-action='open-export']")) {
      e.preventDefault();
      openExport();
      return;
    }
    if (e.target.closest("[data-action='switch-lang']")) {
      e.preventDefault();
      switchLanguage();
      return;
    }
    if (e.target.closest("[data-action='reload-conversations']")) {
      e.preventDefault();
      reloadConversations();
      return;
    }
    if (e.target.closest("[data-action='reload-appeals']")) {
      e.preventDefault();
      appealsStatus.loading = true;
      appealsSignature = null;
      render();
      loadAppeals();
      return;
    }
    const reloadAppeal = e.target.closest("[data-action='reload-appeal']");
    if (reloadAppeal) {
      e.preventDefault();
      delete appealUi.errors[reloadAppeal.dataset.appealId];
      render();
      return;
    }
    const retry = e.target.closest("[data-action='retry-reassessment']");
    if (retry) {
      e.preventDefault();
      retryReassessment(retry.dataset.appealId);
      return;
    }
    const neu = e.target.closest("[data-action='new-chat']");
    if (neu) {
      e.preventDefault();
      const thread = startChat(state);
      persist();
      const next = `#/chat/${thread.id}`;
      if (location.hash === next) render();
      else location.hash = next;
      return;
    }
    const delChat = e.target.closest("[data-action='delete-chat']");
    if (delChat) {
      e.preventDefault();
      e.stopPropagation();
      removeChat(state, delChat.dataset.chatId);
      persist();
      const next = `#/chat/${state.chatId}`;
      if (location.hash === next) render();
      else location.hash = next;
      return;
    }
    const openEdit = e.target.closest("[data-open-edit]");
    if (openEdit) {
      openEditor(openEdit.getAttribute("data-open-edit"));
    }
  },
  true
);

window.addEventListener("hashchange", () => {
  // Back/forward while the criterion dialog is open: it closes, unless that would drop unsaved changes.
  if (isCriterionEditorOpen() && navKey() !== "checklist") {
    const dirty = isCriterionEditorDirty();
    closeCriterionEditor();
    if (dirty) {
      location.hash = "#/checklist";
      return;
    }
  }
  // An appeal page shows the stored state each time it is opened.
  const appealId = currentAppealId();
  if (appealId && appealUi.details[appealId] && !appealUi.polling.has(appealId)) loadAppeal(appealId);
  render();
});
window.addEventListener("beforeunload", (e) => {
  if (!isCriterionEditorDirty()) return;
  e.preventDefault();
  e.returnValue = "";
});
render();
reloadConversations();
loadScores();
loadAppeals();
syncChecklist();
