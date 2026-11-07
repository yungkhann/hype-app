import {
  GROUP_ID_RE,
  cqaInfo,
  createChecklist,
  errorText,
  getChecklist,
  getEvaluation,
  importGroup,
  importJson,
  listChecklistVersions,
  listChecklists,
  listConversationRecords,
  listEvaluations,
  startEvaluation,
  updateChecklist,
} from "./api.js?v=tape4";
import { activeChat, openChat, pushTurn, removeChat, startChat } from "./chat.js?v=tape4";
import {
  adoptChecklist,
  appliedConfig,
  changeNote,
  dropCriterion,
  editingConfig,
  fmt,
  putCriterion,
  sectionName,
  stageChange,
} from "./checklist.js?v=tape3";
import {
  closeCriterionEditor,
  isCriterionEditorDirty,
  isCriterionEditorOpen,
  openCriterionEditor,
} from "./criterion-editor.js?v=tape3";
import { loadState, saveState, setConversations, setScores } from "./store.js?v=tape4";
import { mountMessageScroller } from "./message-scroller.js?v=tape1";
import { Bubble, Button, ChatPrompt, Field, Message, MessageScroller, MessageScrollerItem } from "./ui.js?v=tape1";
import { byId, esc } from "./util.js";

const icon = {
  grid: '<svg viewBox="0 0 24 24"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
  languages: '<svg viewBox="0 0 24 24"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  messages: '<svg viewBox="0 0 24 24"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>',
  checks: '<svg viewBox="0 0 24 24"><path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
};

let state = loadState();
// Conversations come from the backend; until the first answer the list shows that it is loading.
const conversationsStatus = { loading: true, error: "" };
// Saving the checklist as a version; conflictVersion is set when someone else saved a newer version first.
const checklistStatus = { saving: false, error: "", conflictVersion: null };

function persist() {
  saveState(state);
}

async function reloadConversations() {
  conversationsStatus.loading = true;
  conversationsStatus.error = "";
  try {
    setConversations(state, await listConversationRecords());
    persist();
  } catch (err) {
    conversationsStatus.error = err.message;
  } finally {
    conversationsStatus.loading = false;
  }
  render();
}

/** Show a timestamp as the source wrote it: MM:SS as is, ISO 8601 by its own clock time (no time-zone shift). */
function clock(ts) {
  const text = String(ts ?? "");
  return text.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? text;
}

function navKey() {
  const h = location.hash.slice(1) || "/";
  if (h.startsWith("/checklist")) return "checklist";
  if (h.startsWith("/review")) return "review";
  if (h.startsWith("/chat")) return "chat";
  if (h.startsWith("/c/")) return "";
  return "list";
}

function setNav() {
  const key = navKey();
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.nav === key);
  });
  const demo = document.querySelector("[data-demo-link]");
  if (demo) demo.setAttribute("href", state.conversations[0] ? `#/c/${encodeURIComponent(state.conversations[0].id)}` : "#/");
  const search = document.querySelector('[data-filter="q"]');
  if (search && document.activeElement !== search) {
    const q = new URLSearchParams(location.hash.split("?")[1] || "");
    search.value = q.get("q") || "";
  }
}

function criterion(id) {
  return state.checklist.criteria.find((c) => c.id === id);
}

function render() {
  setNav();
  const view = byId("view");
  const h = location.hash.slice(1) || "/";
  const chatMatch = h.match(/^\/chat\/([^/]+)/);
  if (chatMatch) openChat(state, chatMatch[1]);
  const detail = h.match(/^\/c\/([^/]+)/);
  if (h.startsWith("/checklist")) view.innerHTML = viewChecklist();
  else if (h.startsWith("/review")) view.innerHTML = viewReview();
  else if (h.startsWith("/chat")) view.innerHTML = viewChat();
  else if (detail) view.innerHTML = viewDetail(detail[1]);
  else view.innerHTML = viewList();
  bind();
  // Older links open the editor with #/checklist?edit=<id>.
  const editId = h.startsWith("/checklist") ? new URLSearchParams(h.split("?")[1] || "").get("edit") : null;
  if (editId) {
    history.replaceState(null, "", "#/checklist");
    openEditor(editId);
  }
}

function viewChat() {
  const thread = activeChat(state);
  const history = [...state.chats].sort((a, b) => b.updatedAt - a.updatedAt);
  const items = thread.messages
    .map((m) => {
      const user = m.role === "user";
      const body = esc(m.text).replace(/\n/g, "<br>");
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
      <aside class="chat-history" aria-label="Chat history">
        <button type="button" class="chat-new" data-action="new-chat">
          <svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
          New chat
        </button>
        <p class="chat-history-label">Chats</p>
        <nav class="chat-history-list">
          ${history.map((c) => `
            <div class="chat-history-row ${c.id === thread.id ? "is-on" : ""}">
              <a class="chat-history-item" href="#/chat/${esc(c.id)}" data-chat-id="${esc(c.id)}">${esc(c.title)}</a>
              <button type="button" class="chat-history-del" data-action="delete-chat" data-chat-id="${esc(c.id)}" aria-label="Delete chat">
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
  const first = state.conversations[0];
  const countText = conversationsStatus.loading && !all ? "Loading conversations…"
    : rows.length === all ? `${all} conversation${all === 1 ? "" : "s"}` : `${rows.length} of ${all} conversations`;
  const chip = (key, value, label, href, ico) => {
    const on = (key === "lang" && lang === value) || (key === "source" && source === value) || (!value && !lang && !source && key === "all");
    return `<a class="tool ${on ? "is-on" : ""}" href="${href}"><span class="tool-ico">${ico}</span>${label}</a>`;
  };
  return `
    <section class="home">
      <div class="home-hero">
        <h1>What would you like to score?</h1>
        <form class="hero-search" data-hero-search>
          <input name="q" type="search" placeholder="Create a quality review from a transcript…" value="${esc(search)}" />
          <button class="hero-go" type="submit" aria-label="Search">${icon.arrow}</button>
        </form>
      </div>
      <div class="tool-row">
        ${chip("all", "", "All", "#/", icon.grid)}
        ${chip("lang", "kz", "Kazakh", "#/?lang=kz", '<span class="tool-mark">kz</span>')}
        ${chip("lang", "ru", "Russian", "#/?lang=ru", '<span class="tool-mark">ru</span>')}
        ${chip("lang", "en", "English", "#/?lang=en", '<span class="tool-mark">en</span>')}
        ${chip("source", "call", "Calls", "#/?source=call", icon.phone)}
        ${chip("source", "chat", "Chats", "#/?source=chat", icon.messages)}
        <a class="tool" href="#/checklist"><span class="tool-ico">${icon.checks}</span>Checklist</a>
        <a class="tool" href="#/review"><span class="tool-ico">${icon.file}</span>Appeals</a>
      </div>
      <article class="promo">
        <h2>Introducing operator scoring</h2>
        <p>Configure a checklist, inspect a transcript, jump to the supporting utterance, then appeal and recalculate.</p>
        ${first ? `<a class="btn btn-primary" href="#/c/${esc(encodeURIComponent(first.id))}">Try v1</a>` : ""}
      </article>
      <div class="list-head">
        <p class="hint" role="status">${esc(countText)}</p>
        ${Button("Import conversations", { variant: "primary", attrs: 'data-action="open-import"' })}
      </div>
      ${conversationsStatus.error ? `<div class="notice notice-error list-notice" role="alert">Could not load conversations: ${esc(conversationsStatus.error)} ${Button("Retry", { attrs: 'data-action="reload-conversations"' })}</div>` : ""}
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Lang</th><th>Source</th><th>Operator</th><th>Score</th><th>Flags</th></tr></thead>
          <tbody>
            ${!rows.length ? `<tr><td colspan="6" class="hint">${conversationsStatus.loading ? "Loading conversations…" : all ? "No conversations match these filters." : "No conversations yet. Choose Import conversations to load a group from the organizers' API or paste its JSON."}</td></tr>` : ""}
            ${rows.map((c) => {
              const ev = state.scores[c.id];
              const open = state.appeals.filter((a) => a.conversationId === c.id && a.status === "open").length;
              return `<tr>
                <td><a class="linkish" href="#/c/${esc(c.id)}">${esc(c.id)}</a></td>
                <td>${esc(c.language.toUpperCase())}</td>
                <td>${c.source === "call" ? `<span class="badge badge-info">call</span>` : `<span class="badge badge-muted">chat</span>`}</td>
                <td>${esc(c.operator || "—")}</td>
                <td class="num">${esc(pct(ev?.final_percent))}</td>
                <td>${ev?.severe_errors ? `<span class="badge badge-crit">critical</span>` : ""} ${open ? `<span class="badge badge-warn">${open} appeal</span>` : ""}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </section>`;
}

function viewDetail(id) {
  const conv = state.conversations.find((c) => c.id === id);
  if (!conv) return `<section class="page"><p>${conversationsStatus.loading ? "Loading conversation…" : "Conversation not found."}</p></section>`;
  if (needsEvaluationSync(id)) {
    syncEvaluationPane(id).then(() => {
      if (currentDetailId() === id) render();
    });
  }
  const shown = shownEvaluation(id);
  return `
    <section class="page-wide">
      <div class="pane-head">
        <div>
          <a href="#/">Home</a>
          <h2 style="margin-top:4px">${esc(conv.id)} · ${esc(conv.language.toUpperCase())} · ${esc(conv.source)}</h2>
        </div>
        ${scoreHero(id, shown)}
      </div>
      <div class="split">
        <div class="pane">
          <div class="pane-head"><h2>Transcript</h2><span class="badge badge-muted">${conv.messages.length} turns</span></div>
          ${conv.audioUrl ? `<div style="padding:12px 16px 0"><audio class="audio" controls src="${esc(conv.audioUrl)}"></audio></div>` : ""}
          <div class="transcript">
            ${conv.messages.map((m) => {
              const align = m.speaker === "operator" ? "end" : m.speaker === "client" ? "start" : "center";
              const variant = m.speaker === "operator" ? "brand" : m.speaker === "client" ? "secondary" : "muted";
              const bubbleAlign = align === "center" ? "start" : align;
              return `
              <article class="msg" id="msg-${esc(m.id)}" data-msg="${esc(m.id)}" data-align="${align}">
                <div class="msg-meta"><span class="role role-${esc(m.speaker)}">${esc(m.speaker)}</span><span class="tape" title="${esc(m.ts)}">${esc(clock(m.ts))}</span></div>
                ${Bubble({ align: bubbleAlign, variant, children: esc(m.text) })}
              </article>`;
            }).join("")}
          </div>
        </div>
        <div class="pane">
          ${evaluationPane(id, shown)}
        </div>
      </div>
    </section>`;
}

// ---- Evaluation --------------------------------------------------------------------------------------------
// The backend evaluates: it sends the transcript and the selected checklist version to GPT, validates the answer
// and computes the score. This page only asks for an evaluation, follows its status, and shows what was stored.

const OFFICIAL_TEMPLATE = "freedom-broker-official";
const POLL_MS = 1500;
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
};

function pct(value) {
  return value == null ? "—" : `${Number(value).toFixed(2)}%`;
}

function num(value) {
  return value == null ? "—" : String(Math.round(Number(value) * 100) / 100);
}

function currentDetailId() {
  return (location.hash.slice(1) || "/").match(/^\/c\/([^/]+)/)?.[1] ?? null;
}

/** Explanations follow the interface language (RU, KZ or EN); transcripts are never translated. */
function uiLanguage() {
  const lang = (document.documentElement.lang || "en").toLowerCase().slice(0, 2);
  return lang === "ru" ? "ru" : lang === "kk" || lang === "kz" ? "kz" : "en";
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
        evaluationUi.checklistsError = `Could not load checklists. ${errorText(err)}`;
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
          evaluationUi.errors[convId] = `Could not load evaluations. ${errorText(err)}`;
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
        evaluationUi.errors[convId] = `Could not follow the evaluation. ${errorText(err)}`;
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
    });
    const queued = response.evaluations[0];
    evaluationUi.history[convId] = [queued, ...(evaluationUi.history[convId] ?? [])];
    pollEvaluation(queued.id, convId);
  } catch (err) {
    evaluationUi.errors[convId] = `The evaluation was not started. ${errorText(err)}`;
  } finally {
    evaluationUi.starting[convId] = false;
    if (currentDetailId() === convId) render();
  }
}

/** The latest completed evaluation per conversation, for the list's Score column and the chat. */
async function loadScores() {
  try {
    const items = [];
    for (let page = 1; page <= 25; page += 1) {
      const data = await listEvaluations({ status: "completed", page, page_size: 200 });
      items.push(...data.items);
      if (page * data.page_size >= data.total) break;
    }
    setScores(state, items);
  } catch {
    return; // The list keeps showing "—"; the detail page reports API errors itself.
  }
  if (navKey() === "list") render();
}

function scoreHero(convId, shown) {
  const { record, status } = shown;
  const score = record?.status === "completed" ? record.final_score : null;
  let big = "—";
  let sub = "Not evaluated";
  let badge = "";
  if (score) {
    big = pct(score.percent);
    const original = record.original_score?.percent;
    sub = score.percent == null ? "No score: every criterion is N/A"
      : original != null && original !== score.percent ? `Original ${pct(original)} → final ${pct(score.percent)}` : "";
    badge = score.severe_errors.length ? `<span class="badge badge-crit">critical error</span>` : `<span class="badge badge-good">no critical flag</span>`;
  } else if (evaluationUi.starting[convId] || status === "pending" || status === "running") {
    sub = "Evaluating…";
  } else if (status === "failed") {
    sub = "Evaluation failed";
  }
  return `
        <div class="score-hero">
          <div>
            <div class="score-big">${esc(big)}</div>
            ${sub ? `<div class="hint">${esc(sub)}</div>` : ""}
          </div>
          ${badge}
        </div>`;
}

function evaluationMeta(shown) {
  const { record, selection, version } = shown;
  if (record) {
    const model = record.model_info?.name || record.evaluator.version;
    const when = record.completed_at ? ` · ${new Date(record.completed_at).toLocaleString()}` : "";
    return `${record.evaluator.label}${model ? ` · ${model}` : ""} · ${record.checklist_name} v${record.checklist_version}${when}`;
  }
  const checklist = checklistSummary(selection?.checklistId);
  return checklist ? `checklist ${checklist.name} v${version}` : "";
}

function evaluationControls(convId, shown) {
  const list = evaluationUi.checklists;
  const { selection, version, status } = shown;
  const versions = selection ? evaluationUi.versions[selection.checklistId] ?? [] : [];
  const checklistOptions = (list ?? []).map((c) => `<option value="${esc(c.id)}" ${c.id === selection?.checklistId ? "selected" : ""}>${esc(c.name)}</option>`).join("")
    || `<option>${list === null ? "Loading checklists…" : "No checklist saved in ATLAS"}</option>`;
  const versionOptions = versions.length
    ? versions.map((v) => `<option value="${v.version}" ${v.version === version ? "selected" : ""}>Version ${v.version}${v.is_latest ? " (latest)" : ""}</option>`).join("")
    : version ? `<option value="${version}">Version ${version}</option>` : "";
  const busy = evaluationUi.starting[convId] || status === "pending" || status === "running";
  const progress = evaluationUi.starting[convId] ? "Starting…" : status === "pending" ? "Queued…" : status === "running" ? "GPT is evaluating every criterion…" : "";
  const label = busy ? "Evaluating…" : shown.summary ? "Evaluate again" : "Evaluate";
  return `
          <form class="crit-card form-grid" data-evaluate-form novalidate>
            <div>
              <label class="field-label" for="eval-checklist">Checklist</label>
              <select class="input" id="eval-checklist" name="checklist" ${list?.length ? "" : "disabled"}>${checklistOptions}</select>
            </div>
            <div>
              <label class="field-label" for="eval-version">Version</label>
              <select class="input" id="eval-version" name="version" ${versionOptions ? "" : "disabled"}>${versionOptions}</select>
            </div>
            <div class="ui-btn-row">
              ${Button(label, { variant: "primary", type: "submit", attrs: busy || !version ? "disabled" : "" })}
              <span class="hint" role="status" aria-live="polite">${esc(progress)}</span>
            </div>
          </form>`;
}

function evaluationNotices(convId, shown) {
  const { record, detail, summary, selection } = shown;
  const notice = (tone, html, role = "status") => `<div class="notice ${tone}" role="${role}" style="margin:0 16px 12px">${html}</div>`;
  const parts = [];
  if (evaluationUi.checklistsError) parts.push(notice("notice-error", esc(evaluationUi.checklistsError), "alert"));
  if (evaluationUi.errors[convId]) parts.push(notice("notice-error", esc(evaluationUi.errors[convId]), "alert"));
  if (detail?.error) parts.push(notice("notice-error", esc(`Could not load the evaluation. ${detail.error}`), "alert"));
  if (record?.status === "failed") {
    const issues = record.error?.issues ?? [];
    parts.push(notice("notice-error", `<strong>Evaluation failed.</strong> ${esc(record.error?.message ?? "")}
      ${issues.length ? `<ul>${issues.slice(0, 5).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}
      <p class="hint">No score was recorded for this attempt.</p>`, "alert"));
  }
  if (record?.evaluator?.is_mock) parts.push(notice("notice-warn", "Development mock evaluator: placeholder answers, not a GPT evaluation."));
  if (detail?.stale) parts.push(notice("notice-warn", "The transcript changed after this evaluation ran. Evaluate again for a current result."));
  if (selection && !summary && evaluationUi.history[convId] && !evaluationUi.starting[convId]) {
    parts.push(`<p class="hint" style="padding:0 16px 12px">Not evaluated with this checklist version yet. Evaluate sends the whole conversation and every enabled criterion to GPT.</p>`);
  }
  if (!evaluationUi.history[convId] && !parts.length) parts.push(`<p class="hint" style="padding:0 16px 12px">Loading evaluations…</p>`);
  return parts.join("");
}

function answerText(criterion, result, score) {
  if (result.is_na) return "n/a";
  if (Number(criterion.weight) === 0) return result.value === true ? "critical error" : "no critical error";
  if (criterion.answer_type === "binary") return result.value ? "yes" : "no";
  if (criterion.answer_type === "options") {
    const option = (criterion.options ?? []).find((o) => o.id === result.value);
    return `${option?.label ?? result.value} · ${num(score?.raw_score)}/${num(score?.raw_max)}`;
  }
  return `${num(result.value)}/${num(score?.raw_max)}`;
}

function criterionCard(view, sectionNames) {
  const c = view.criterion;
  const r = view.final;
  const s = view.final_score;
  if (!r || !s) return "";
  const indicator = Number(c.weight) === 0;
  const tone = r.is_na ? "badge-info" : indicator ? (r.value === true ? "badge-crit" : "badge-good") : s.normalized === 0 ? "badge-crit" : "badge-good";
  const meta = indicator ? "critical-error indicator · not scored"
    : r.is_na ? `weight ${num(c.weight)} → applied 0 (N/A, shared by the other criteria)`
    : `weight ${num(c.weight)} → applied ${num(s.max_points)} · ${num(s.points)} points`;
  const section = c.section_id ? sectionNames[c.section_id] ?? c.section_id : "";
  const evidence = (r.evidence ?? []).map((e) =>
    `<button class="btn btn-ghost" type="button" data-jump="${esc(e.message_id)}">Turn ${e.message_index + 1} · ${esc(e.speaker)}</button>`).join("");
  return `<article class="crit-card ${s.severe_error ? "severe" : ""}" id="crit-${esc(c.id)}">
              <div class="crit-top">
                <h3>${esc(c.name)}</h3>
                <span class="badge ${tone}">${esc(answerText(c, r, s))}</span>
              </div>
              <p class="crit-meta">${esc(meta)}${section ? ` · ${esc(section)}` : ""}</p>
              <p>${esc(r.explanation)}</p>
              ${r.is_na && r.na_reason && r.na_reason !== r.explanation ? `<p class="hint">${esc(r.na_reason)}</p>` : ""}
              ${r.severe_error && !indicator ? `<p class="hint">Critical error flagged${r.severe_error_reason && r.severe_error_reason !== r.explanation ? `: ${esc(r.severe_error_reason)}` : "."}</p>` : ""}
              ${(r.inspected_spans ?? []).map((span) => `<p class="hint">Checked span: turn ${span.start_index + 1} → ${span.end_index + 1}</p>`).join("")}
              ${evidence ? `<div class="crit-actions">${evidence}</div>` : ""}
            </article>`;
}

function evaluationPane(convId, shown) {
  const { record } = shown;
  const completed = record?.status === "completed" ? shown.detail : null;
  const sectionNames = Object.fromEntries((record?.checklist?.sections ?? []).map((s) => [s.id, s.name]));
  const sections = completed ? record.final_score?.sections ?? [] : [];
  return `
          <div class="pane-head"><h2>Evaluation</h2><span class="hint">${esc(evaluationMeta(shown))}</span></div>
          ${evaluationControls(convId, shown)}
          ${evaluationNotices(convId, shown)}
          ${sections.length ? `<div class="sections">
            ${sections.map((s) => `<span class="section-chip">${esc(s.name)} ${s.points == null ? "n/a" : `${num(s.points)}/${num(s.max_points)}`}</span>`).join("")}
          </div>` : ""}
          ${completed ? completed.criteria.map((view) => criterionCard(view, sectionNames)).join("") : ""}`;
}

// ---- Checklist -----------------------------------------------------------------------------------------
// The page shows the unsaved draft when there is one, else the applied version. The criterion dialog changes
// the draft; "Save checklist" stores it in ATLAS as the next checklist version (or creates the checklist).

function checklistSubtitle() {
  const source = state.checklist.source;
  const parts = [source ? `${source.name} · version ${source.version}` : String(state.checklist.note ?? "").replace(/\.$/, "")];
  if (state.checklistDraft) parts.push("unsaved changes");
  return parts.join(" · ");
}

function checklistNotice() {
  if (!checklistStatus.error) return "";
  const reload = checklistStatus.conflictVersion
    ? Button(`Discard my changes and load version ${esc(checklistStatus.conflictVersion)}`, { attrs: 'data-action="reload-checklist"' })
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
          <h1 class="studio-title">Checklist</h1>
          <p>${esc(checklistSubtitle())}</p>
        </div>
        <div class="ui-btn-row">
          ${Button("Add criterion", { attrs: 'data-action="add-criterion"' })}
          ${Button(checklistStatus.saving ? "Saving…" : "Save checklist", { variant: "primary", attrs: `data-action="apply-checklist"${checklistStatus.saving ? " disabled" : ""}` })}
        </div>
      </div>
      ${checklistNotice()}
      <div class="card-grid">
        ${config.criteria.map((c) => {
          const section = sectionName(config, c.section_id);
          return `
          <button type="button" class="lib-card ${c.enabled !== false ? "" : "is-off"}" data-open-edit="${esc(c.id)}">
            <h3>${esc(c.name)}</h3>
            <p>${esc(c.description)}</p>
            <span class="hint">${section ? `${esc(section)} · ` : ""}weight ${esc(fmt(c.weight))}${c.na_allowed ? " · N/A" : ""}${c.severe_error_enabled ? " · severe" : ""}</span>
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
    ? `Changes stay on the checklist page until you choose Save checklist, which saves “${state.checklist.title}” as version ${(baseVersion ?? 0) + 1}.`
    : "Changes stay on the checklist page until you choose Save checklist, which saves this checklist in ATLAS as version 1.";
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
    checklistStatus.error = `The checklist was not saved. ${errorText(err)}`;
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
    checklistStatus.error = `Could not load the checklist. ${errorText(err)}`;
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

function viewReview() {
  const items = state.appeals;
  if (!items.length) {
    return `<section class="empty"><h1>Appeals</h1><p>No appeals yet. Open a conversation and dispute a criterion.</p><a class="btn btn-primary" href="#/">Go to Home</a></section>`;
  }
  return `
    <section class="library">
      <div class="page-head"><div><h1 class="studio-title">Appeals</h1><p>${items.filter((a) => a.status === "open").length} open · ${items.length} total</p></div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Case</th><th>Criterion</th><th>Original</th><th>Comment</th><th>Decision</th><th>Final</th></tr></thead>
          <tbody>
            ${items.map((a) => {
              const c = criterion(a.criterionId);
              return `<tr>
                <td><a class="linkish" href="#/c/${esc(a.conversationId)}">${esc(a.conversationId)}</a></td>
                <td>${esc(c?.title ?? a.criterionId)}</td>
                <td class="num">${esc(a.originalAnswer)} (${esc(a.originalScore)})</td>
                <td>${esc(a.comment)}</td>
                <td>${a.status === "reviewed" ? esc(a.reviewerReason) : `<span class="badge badge-warn">open</span>`}</td>
                <td class="num">${a.finalTotal != null ? esc(a.finalTotal) : "—"}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </section>`;
}

function bind() {
  try {
    mountMessageScroller(document.querySelector('[data-slot="message-scroller-provider"]'));
  } catch (err) {
    console.error(err);
  }
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
  document.querySelector("[data-hero-search]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = e.currentTarget.q.value.trim();
    location.hash = q ? `/?q=${encodeURIComponent(q)}` : "/";
  });
  document.querySelector("[data-action='add-criterion']")?.addEventListener("click", () => openEditor(null));
  document.querySelector("[data-action='apply-checklist']")?.addEventListener("click", () => saveChecklist());
  document.querySelector("[data-action='reload-checklist']")?.addEventListener("click", () => reloadChecklist());
  document.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const node = document.getElementById(`msg-${btn.dataset.jump}`);
      document.querySelectorAll(".msg.is-hit").forEach((el) => el.classList.remove("is-hit"));
      if (!node) return;
      node.classList.add("is-hit");
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    });
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
    evaluateForm.elements.namedItem("version")?.addEventListener("change", (e) => {
      const selection = currentSelection();
      if (!selection) return;
      const chosen = Number(e.target.value);
      const latest = checklistSummary(selection.checklistId)?.latest_version;
      evaluationUi.selection = { checklistId: selection.checklistId, version: chosen === latest ? null : chosen };
      render();
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

const SOURCE_HINT = "ATLAS requests this group from the organizers' API on the server.";
const JSON_PLACEHOLDER = `Paste the organizers' API response here, exactly as the API returned it:
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
    data-import-tab="${key}">${label}</button>`;
  const actions = (label) => `<div class="dialog-actions">
      ${Button("Cancel", { attrs: "data-import-close" })}
      ${Button(label, { variant: "primary", type: "submit" })}
    </div>`;
  return `
    <div class="dialog-head">
      <div>
        <h2 id="import-title" class="sheet-title">Import conversations</h2>
        <p class="hint">ATLAS validates and stores them. Importing the same conversations again does not create duplicates.</p>
      </div>
      <button type="button" class="dialog-close" data-import-close aria-label="Close">
        <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="tabs" role="tablist" aria-label="Import method">
      ${tab("api", "Import via API", true)}
      ${tab("json", "Paste JSON", false)}
    </div>
    <form class="dialog-panel" id="import-panel-api" role="tabpanel" aria-labelledby="import-tab-api" data-import-form="api" novalidate>
      ${Field("Group ID", '<input class="ui-input" name="group_id" type="text" placeholder="e.g. DEV" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" />')}
      <p class="hint" data-import-source>${esc(SOURCE_HINT)}</p>
      <div data-import-status role="status" aria-live="polite"></div>
      ${actions("Import")}
    </form>
    <form class="dialog-panel" id="import-panel-json" role="tabpanel" aria-labelledby="import-tab-json" data-import-form="json" novalidate hidden>
      ${Field("Organizers' API response (JSON)", `<textarea class="ui-textarea import-json" name="json" rows="14" wrap="off" autocomplete="off" spellcheck="false" placeholder="${esc(JSON_PLACEHOLDER)}"></textarea>`)}
      <div data-import-status role="status" aria-live="polite"></div>
      ${actions("Import JSON")}
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
  const counts = `${run.created} new · ${run.updated} updated · ${run.unchanged} already imported · ${run.rejected} rejected`;
  const head = run.status === "failed" ? `Nothing was imported from group ${run.group_id}.` : `Imported group ${run.group_id}.`;
  const reported = run.reported_total != null && run.reported_total !== run.received ? ` (total_records says ${run.reported_total})` : "";
  let html = `<strong>${esc(head)}</strong> ${esc(counts)}.<br>${esc(`Received ${run.received} record${run.received === 1 ? "" : "s"}${reported}.`)}`;
  const issues = run.issues ?? [];
  if (issues.length) {
    const where = (i) => i.conversation_id ?? (i.record_index != null ? `record ${i.record_index + 1}` : "import");
    html += `<ul>${issues.slice(0, 6).map((i) => `<li>${esc(`${where(i)}: ${i.message}`)}</li>`).join("")}</ul>`;
    if (issues.length > 6) html += `<p class="hint">…and ${issues.length - 6} more.</p>`;
  }
  return html;
}

/** JSON.parse's message, plus line and column when the engine only reports a character position. */
function jsonError(err, text) {
  const message = String(err?.message || "Invalid JSON.");
  const pos = message.match(/position (\d+)/);
  if (!pos || /line \d+/i.test(message)) return message;
  const before = text.slice(0, Number(pos[1]));
  return `${message} (line ${before.split("\n").length}, column ${before.length - before.lastIndexOf("\n")})`;
}

async function runImport(form) {
  const status = form.querySelector("[data-import-status]");
  const submit = form.querySelector('button[type="submit"]');
  let call;
  let pending;
  if (form.dataset.importForm === "api") {
    const groupId = form.group_id.value.trim();
    if (!groupId) return setImportStatus(status, "error", "Enter a group_id, for example DEV.");
    if (!GROUP_ID_RE.test(groupId)) {
      return setImportStatus(status, "error", esc("A group_id starts with a letter or digit and contains only letters, digits, '.', '_' and '-' (at most 64 characters)."));
    }
    call = () => importGroup(groupId);
    pending = `Requesting group ${groupId} from the organizers' API…`;
  } else {
    const text = form.json.value;
    if (!text.trim()) return setImportStatus(status, "error", esc("Paste the organizers' API response first."));
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      return setImportStatus(status, "error", esc(`This is not valid JSON. ${jsonError(err, text)}`));
    }
    call = () => importJson(payload);
    pending = "Validating and importing…";
  }
  const label = submit.textContent;
  submit.disabled = true;
  submit.textContent = "Importing…";
  setImportStatus(status, "info", esc(pending));
  try {
    const run = await call();
    setImportStatus(status, run.status === "failed" ? "error" : run.status === "partial" ? "warn" : "ok", importSummary(run));
    if (navKey() !== "list") location.hash = "#/";
    await reloadConversations();
  } catch (err) {
    setImportStatus(status, "error", esc(err.message));
  } finally {
    submit.disabled = false;
    submit.textContent = label;
  }
}

async function refreshSourceHint() {
  const hint = importDialog.querySelector("[data-import-source]");
  try {
    const info = await cqaInfo();
    hint.textContent = info.source_configured ? SOURCE_HINT
      : "The organizers' API is not configured on this server (ATLAS_CQA_SOURCE_URL), so an API import will fail. Use Paste JSON instead.";
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

function openImport() {
  if (!importDialog) {
    importDialog = document.createElement("dialog");
    importDialog.className = "dialog";
    importDialog.setAttribute("aria-labelledby", "import-title");
    importDialog.innerHTML = importDialogHtml();
    document.body.append(importDialog);
    bindImportDialog(importDialog);
  }
  if (!importDialog.open) importDialog.showModal();
  activeImportField()?.focus();
  refreshSourceHint();
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
    if (e.target.closest("[data-action='reload-conversations']")) {
      e.preventDefault();
      reloadConversations();
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
syncChecklist();
