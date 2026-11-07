import { GROUP_ID_RE, cqaInfo, importGroup, importJson, listConversationRecords } from "./api.js?v=tape2";
import { activeChat, openChat, pushTurn, removeChat, startChat } from "./chat.js?v=tape2";
import { decideAppeal, loadState, reevaluateAll, saveState, setConversations, submitAppeal } from "./store.js?v=tape2";
import { mountMessageScroller } from "./message-scroller.js?v=tape1";
import {
  Bubble,
  Button,
  ChatPrompt,
  Checkbox,
  Field,
  Input,
  Message,
  MessageScroller,
  MessageScrollerItem,
  Select,
  Textarea,
} from "./ui.js?v=tape1";
import { byId, esc, uid } from "./util.js";

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
              const ev = state.evaluations[c.id];
              const open = state.appeals.filter((a) => a.conversationId === c.id && a.status === "open").length;
              return `<tr>
                <td><a class="linkish" href="#/c/${esc(c.id)}">${esc(c.id)}</a></td>
                <td>${esc(c.language.toUpperCase())}</td>
                <td>${c.source === "call" ? `<span class="badge badge-info">call</span>` : `<span class="badge badge-muted">chat</span>`}</td>
                <td>${esc(c.operator || "—")}</td>
                <td class="num">${ev ? `${ev.total} / ${ev.maxTotal}` : "—"}</td>
                <td>${ev?.severe?.length ? `<span class="badge badge-crit">severe</span>` : ""} ${open ? `<span class="badge badge-warn">${open} appeal</span>` : ""}</td>
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
  const ev = state.evaluations[id];
  const openAppeals = state.appeals.filter((a) => a.conversationId === id);
  return `
    <section class="page-wide">
      <div class="pane-head">
        <div>
          <a href="#/">Home</a>
          <h2 style="margin-top:4px">${esc(conv.id)} · ${esc(conv.language.toUpperCase())} · ${esc(conv.source)}</h2>
        </div>
        <div class="score-hero">
          <div>
            <div class="score-big">${esc(ev.total)} <span>/ ${esc(ev.maxTotal)}</span></div>
            ${ev.originalTotal != null && ev.originalTotal !== ev.total ? `<div class="hint">Original ${esc(ev.originalTotal)} → final ${esc(ev.total)}</div>` : ""}
          </div>
          ${ev.severe.length ? `<span class="badge badge-crit">severe error</span>` : `<span class="badge badge-good">no severe flag</span>`}
        </div>
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
          <div class="pane-head"><h2>Evaluation</h2><span class="hint">checklist ${esc(state.checklist.id)}</span></div>
          <div class="sections">
            ${Object.entries(ev.sectionTotals).map(([name, v]) => `<span class="section-chip">${esc(name)} ${v.score}/${v.weight}</span>`).join("")}
          </div>
          ${ev.rows.map((row) => {
            const c = criterion(row.criterionId);
            const appeal = openAppeals.find((a) => a.criterionId === row.criterionId);
            return `<article class="crit-card ${ev.severe.includes(row.criterionId) ? "severe" : ""}" id="crit-${esc(row.criterionId)}">
              <div class="crit-top">
                <h3>${esc(c.title)}</h3>
                <span class="badge ${row.answer === "na" ? "badge-info" : row.answer === "no" || Number(row.score) === 0 ? "badge-crit" : "badge-good"}">${esc(row.answer)} · ${esc(row.score)}/${esc(row.max)}</span>
              </div>
              <p class="crit-meta">weight ${esc(c.weight)} → applied ${esc(row.weightApplied)} · ${esc(c.section)}</p>
              <p>${esc(row.explanation)}</p>
              ${row.naReason ? `<p class="hint">${esc(row.naReason)}</p>` : ""}
              ${row.examinedSpan ? `<p class="hint">Checked span: ${esc(row.examinedSpan.from)} → ${esc(row.examinedSpan.to)}</p>` : ""}
              <div class="crit-actions">
                ${row.evidenceMessageId ? `<button class="btn btn-ghost" data-jump="${esc(row.evidenceMessageId)}">Jump to evidence</button>` : ""}
                ${appeal?.status === "open" ? `<span class="badge badge-warn">appeal open</span>` : `<button class="btn" data-appeal="${esc(row.criterionId)}">Appeal</button>`}
              </div>
              ${appeal?.status === "open" ? `
                <form class="form-grid" data-review-form="${esc(appeal.id)}">
                  <p class="hint">Disputed ${esc(appeal.originalAnswer)} (${esc(appeal.originalScore)}). ${esc(appeal.comment)}</p>
                  <label class="field-label">Reviewer answer</label>
                  ${answerControl(c, appeal.originalAnswer)}
                  <textarea class="input" name="reason" required placeholder="Reviewer reason"></textarea>
                  <button class="btn btn-primary" type="submit">Confirm decision</button>
                </form>` : ""}
              ${appeal?.status === "reviewed" ? `<p class="notice notice-ok">Reviewed: ${esc(appeal.originalScore)} → ${esc(appeal.finalScore)}. ${esc(appeal.reviewerReason)}</p>` : ""}
              <form class="form-grid appeal-form" hidden data-appeal-form="${esc(row.criterionId)}">
                <textarea class="input" name="comment" required placeholder="Why this score should change"></textarea>
                <button class="btn btn-primary" type="submit">Submit appeal</button>
              </form>
            </article>`;
          }).join("")}
        </div>
      </div>
    </section>`;
}

function answerControl(c, current) {
  if (c.answerType === "yes_no") {
    const opts = ["yes", "no"].concat(c.naAllowed ? ["na"] : []);
    return `<select class="input" name="answer">${opts.map((o) => `<option ${o === current ? "selected" : ""}>${o}</option>`).join("")}</select>`;
  }
  const min = c.scale.min ?? 0;
  const max = c.scale.max ?? 2;
  const extras = c.naAllowed ? `<option value="na" ${current === "na" ? "selected" : ""}>na</option>` : "";
  return `<select class="input" name="answer">${extras}${Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => `<option ${String(n) === String(current) ? "selected" : ""}>${n}</option>`).join("")}</select>`;
}

function checklistEditId() {
  const h = location.hash.slice(1) || "/";
  if (!h.startsWith("/checklist")) return "";
  const q = h.includes("?") ? h.slice(h.indexOf("?") + 1) : "";
  return new URLSearchParams(q).get("edit") || "";
}

function criterionSheet(c) {
  return `
    <div class="sheet-root">
      <button type="button" class="sheet-dim" data-action="close-edit" aria-label="Close"></button>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" data-sheet>
        <form data-edit="${esc(c.id)}" data-edit-form>
          <div class="sheet-head">
            <div>
              <h2 id="sheet-title" class="sheet-title">${esc(c.title)}</h2>
              <p class="hint">${esc(c.id)}</p>
            </div>
            ${Checkbox({ field: "enabled", checked: c.enabled, label: "enabled" })}
          </div>
          <div class="sheet-grid">
            ${Field("ID", Input({ field: "id", value: c.id }))}
            ${Field("Title", Input({ field: "title", value: c.title }))}
            ${Field("Section", Input({ field: "section", value: c.section }))}
            ${Field("Weight", Input({ field: "weight", value: c.weight, type: "number" }))}
            ${Field("Type", Select({ field: "answerType", value: c.answerType, options: [
              { value: "yes_no", label: "yes/no" },
              { value: "scale", label: "scale" },
            ] }))}
            ${Field("N/A", Select({ field: "naAllowed", value: String(c.naAllowed), options: [
              { value: "true", label: "allowed" },
              { value: "false", label: "off" },
            ] }))}
            ${Field("Severe", Select({ field: "severe", value: String(c.severe), options: [
              { value: "true", label: "yes" },
              { value: "false", label: "no" },
            ] }))}
          </div>
          ${Field("Wording", Textarea({ field: "wording", value: c.wording }))}
          <div class="sheet-actions">
            ${Button("Remove", { variant: "destructive", attrs: `data-action="remove-criterion" data-id="${esc(c.id)}"` })}
            <div class="ui-btn-row">
              ${Button("Cancel", { attrs: 'data-action="close-edit"' })}
              ${Button("Save", { variant: "primary", type: "submit" })}
            </div>
          </div>
        </form>
      </div>
    </div>`;
}

function viewChecklist() {
  const cs = state.checklist.criteria;
  const editing = cs.find((c) => c.id === checklistEditId());
  return `
    <section class="library library-wide">
      <div class="page-head">
        <div>
          <h1 class="studio-title">Checklist</h1>
          <p>${esc(state.checklist.note.replace(/\.$/, ""))}</p>
        </div>
        <div class="ui-btn-row">
          ${Button("Add criterion", { attrs: 'data-action="add-criterion"' })}
          ${Button("Save & re-evaluate", { variant: "primary", attrs: 'data-action="apply-checklist"' })}
        </div>
      </div>
      <div class="card-grid">
        ${cs.map((c) => `
          <button type="button" class="lib-card ${c.enabled ? "" : "is-off"} ${c.id === editing?.id ? "is-on" : ""}" data-open-edit="${esc(c.id)}">
            <h3>${esc(c.title)}</h3>
            <p>${esc(c.wording)}</p>
            <span class="hint">${esc(c.section)} · weight ${esc(c.weight)}${c.naAllowed ? " · N/A" : ""}${c.severe ? " · severe" : ""}</span>
          </button>`).join("")}
      </div>
      ${editing ? criterionSheet(editing) : ""}
    </section>`;
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

function collectChecklist() {
  document.querySelectorAll("[data-edit]").forEach((card) => {
    const id = card.getAttribute("data-edit");
    const c = criterion(id);
    if (!c) return;
    const val = (field) => card.querySelector(`[data-field="${field}"]`);
    c.id = val("id").value.trim() || c.id;
    c.title = val("title").value.trim();
    c.section = val("section").value.trim();
    c.weight = Number(val("weight").value);
    c.answerType = val("answerType").value;
    c.naAllowed = val("naAllowed").value === "true";
    c.severe = val("severe").value === "true";
    c.enabled = val("enabled").checked;
    c.wording = val("wording").value;
    if (c.answerType === "yes_no") c.scale = { yes: 1, no: 0 };
    else c.scale = { min: 0, max: 2, step: 1 };
    card.setAttribute("data-edit", c.id);
  });
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
  document.querySelector("[data-action='add-criterion']")?.addEventListener("click", () => {
    const id = uid("c");
    state.checklist.criteria.push({
      id,
      section: "Custom",
      title: "New criterion",
      wording: "Replace this wording from the organizer checklist.",
      weight: 5,
      answerType: "yes_no",
      scale: { yes: 1, no: 0 },
      naAllowed: true,
      enabled: true,
      severe: false,
      signals: { positive: [], negative: [] },
    });
    persist();
    location.hash = `#/checklist?edit=${id}`;
    render();
  });
  document.querySelector("[data-action='apply-checklist']")?.addEventListener("click", () => {
    state.checklist.id = `cqa-${Date.now().toString(36)}`;
    reevaluateAll(state);
    persist();
    location.hash = "#/";
    render();
  });
  document.querySelector("[data-edit-form]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    collectChecklist();
    persist();
    location.hash = "#/checklist";
    render();
  });
  const titleField = document.querySelector("[data-edit] [data-field='title']");
  titleField?.focus();
  if (titleField) titleField.select();
  document.body.style.overflow = document.querySelector(".sheet-root") ? "hidden" : "";
  document.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const node = document.getElementById(`msg-${btn.dataset.jump}`);
      document.querySelectorAll(".msg.is-hit").forEach((el) => el.classList.remove("is-hit"));
      if (!node) return;
      node.classList.add("is-hit");
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
  document.querySelectorAll("[data-appeal]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const form = document.querySelector(`[data-appeal-form="${btn.dataset.appeal}"]`);
      if (form) form.hidden = !form.hidden;
    });
  });
  document.querySelectorAll("[data-appeal-form]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const id = location.hash.split("/c/")[1];
      submitAppeal(state, id, form.getAttribute("data-appeal-form"), form.comment.value.trim());
      persist();
      render();
    });
  });
  document.querySelectorAll("[data-review-form]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      decideAppeal(state, form.getAttribute("data-review-form"), form.answer.value, form.reason.value.trim());
      persist();
      render();
    });
  });
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
    if (openEdit && !e.target.closest("[data-sheet]")) {
      location.hash = `#/checklist?edit=${openEdit.getAttribute("data-open-edit")}`;
      return;
    }
    if (e.target.closest("[data-action='close-edit']")) {
      location.hash = "#/checklist";
      return;
    }
    const removeCrit = e.target.closest("[data-action='remove-criterion']");
    if (removeCrit) {
      e.preventDefault();
      state.checklist.criteria = state.checklist.criteria.filter((c) => c.id !== removeCrit.dataset.id);
      persist();
      location.hash = "#/checklist";
      if (!location.hash.includes("edit=")) render();
    }
  },
  true
);

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !checklistEditId()) return;
  location.hash = "#/checklist";
});

window.addEventListener("hashchange", render);
render();
reloadConversations();
