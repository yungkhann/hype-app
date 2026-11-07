import { parseApiPayload } from "./data.js";
import { evaluateConversation } from "./scoring.js";
import { decideAppeal, loadState, reevaluateAll, resetState, saveState, submitAppeal } from "./store.js";
import { Alert, Button, Card, Checkbox, Field, Input, Select, Textarea } from "./ui.js";
import { byId, esc, fmtTime, uid } from "./util.js";

const icon = {
  grid: '<svg viewBox="0 0 24 24"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
  languages: '<svg viewBox="0 0 24 24"><path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  messages: '<svg viewBox="0 0 24 24"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>',
  checks: '<svg viewBox="0 0 24 24"><path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>',
};

let state = loadState();

function persist() {
  saveState(state);
}

function navKey() {
  const h = location.hash.slice(1) || "/";
  if (h.startsWith("/checklist")) return "checklist";
  if (h.startsWith("/review")) return "review";
  if (h.startsWith("/c/")) return "";
  return "list";
}

function setNav() {
  const key = navKey();
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.nav === key);
  });
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
  const detail = h.match(/^\/c\/([^/]+)/);
  if (h.startsWith("/checklist")) view.innerHTML = viewChecklist();
  else if (h.startsWith("/review")) view.innerHTML = viewReview();
  else if (detail) view.innerHTML = viewDetail(detail[1]);
  else view.innerHTML = viewList();
  bind();
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
        ${chip("lang", "kz", "kz", "#/?lang=kz", icon.languages)}
        ${chip("lang", "en", "en", "#/?lang=en", icon.languages)}
        ${chip("lang", "ru", "ru", "#/?lang=ru", icon.languages)}
        ${chip("source", "call", "Calls", "#/?source=call", icon.phone)}
        ${chip("source", "synthetic", "Chats", "#/?source=synthetic", icon.messages)}
        <a class="tool" href="#/checklist"><span class="tool-ico">${icon.checks}</span>Checklist</a>
        <a class="tool" href="#/review"><span class="tool-ico">${icon.chat}</span>Appeals</a>
      </div>
      <article class="promo">
        <h2>Introducing operator scoring</h2>
        <p>Configure a checklist, inspect a transcript, jump to the supporting utterance, then appeal and recalculate.</p>
        <a class="btn btn-primary" href="#/c/conv-01">Try v1</a>
      </article>
      <div class="table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Lang</th><th>Source</th><th>Operator</th><th>Score</th><th>Flags</th></tr></thead>
          <tbody>
            ${rows.map((c) => {
              const ev = state.evaluations[c.id];
              const open = state.appeals.filter((a) => a.conversationId === c.id && a.status === "open").length;
              return `<tr>
                <td><a class="linkish" href="#/c/${esc(c.id)}">${esc(c.id)}</a></td>
                <td>${esc(c.language.toUpperCase())}</td>
                <td>${c.source === "call" ? `<span class="badge badge-info">call</span>` : `<span class="badge badge-muted">chat</span>`}</td>
                <td>${esc(c.operator)}</td>
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
  if (!conv) return `<section class="page"><p>Conversation not found.</p></section>`;
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
            ${conv.messages.map((m) => `
              <article class="msg" id="msg-${esc(m.id)}" data-msg="${esc(m.id)}">
                <div class="msg-meta"><span class="tape">${esc(fmtTime(m.ts))}</span><span class="role role-${esc(m.speaker)}">${esc(m.speaker)}</span></div>
                <p class="msg-text">${esc(m.text)}</p>
              </article>`).join("")}
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

function viewChecklist() {
  const cs = state.checklist.criteria;
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
      <div class="card-grid" style="margin-bottom:28px">
        ${cs.map((c) => `
          <article class="lib-card">
            <div class="lib-ico">${icon.checks}</div>
            <h3>${esc(c.title)}</h3>
            <p>${esc(c.wording)}</p>
            <span class="hint">${esc(c.section)} · weight ${esc(c.weight)}${c.naAllowed ? " · N/A" : ""}</span>
          </article>`).join("")}
      </div>
      ${Alert("Definitions are configuration. Replace a criterion here without a code change.")}
      <div class="editor">
        ${cs.map((c, i) => Card(`
            <div class="ui-card-head">
              <h3 class="ui-card-title">#${i + 1} ${esc(c.id)}</h3>
              ${Checkbox({ field: "enabled", checked: c.enabled, label: "enabled" })}
            </div>
            <div class="editor-row">
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
              <div class="ui-field ui-field-action">
                ${Button("Remove", { variant: "destructive", attrs: `data-action="remove-criterion" data-id="${esc(c.id)}"` })}
              </div>
            </div>
            ${Field("Wording", Textarea({ field: "wording", value: c.wording }))}
          `, `data-edit="${esc(c.id)}"`)).join("")}
      </div>
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
  document.querySelector("[data-hero-search]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = e.currentTarget.q.value.trim();
    location.hash = q ? `/?q=${encodeURIComponent(q)}` : "/";
  });
  document.querySelector("[data-action='add-criterion']")?.addEventListener("click", () => {
    collectChecklist();
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
    render();
  });
  document.querySelector("[data-action='apply-checklist']")?.addEventListener("click", () => {
    collectChecklist();
    state.checklist.id = `cqa-${Date.now().toString(36)}`;
    reevaluateAll(state);
    persist();
    location.hash = "#/";
    render();
  });
  document.querySelectorAll("[data-action='remove-criterion']").forEach((btn) => {
    btn.addEventListener("click", () => {
      collectChecklist();
      state.checklist.criteria = state.checklist.criteria.filter((c) => c.id !== btn.dataset.id);
      persist();
      render();
    });
  });
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

byId("btn-fetch").addEventListener("click", async () => {
  const groupId = byId("group-id").value.trim();
  const url = prompt("Organizer GET URL (group_id will be appended)", state.apiUrl || "https://example.invalid/api/data");
  if (!url) return;
  state.apiUrl = url;
  try {
    const sep = url.includes("?") ? "&" : "?";
    const res = await fetch(`${url}${sep}group_id=${encodeURIComponent(groupId)}`);
    const json = await res.json();
    const records = parseApiPayload(json, groupId);
    if (!records.length) throw new Error("No data.records in response");
    state.conversations = records;
    state.evaluations = {};
    for (const conv of records) state.evaluations[conv.id] = evaluateConversation(conv, state.checklist);
    persist();
    location.hash = "#/";
    render();
  } catch (err) {
    alert(`Could not load API: ${err.message}`);
  }
});

document.querySelector("[data-action='reset']")?.addEventListener("click", () => {
  state = resetState();
  location.hash = "#/";
  render();
});
document.querySelector('[data-filter="q"]')?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  applyFilters();
});

window.addEventListener("hashchange", render);
render();
