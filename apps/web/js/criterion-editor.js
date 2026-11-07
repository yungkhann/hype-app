// Add / Edit criterion dialog. A native modal <dialog> outside #view, so re-rendering the page behind it never
// clears what the manager typed. It edits one criterion in the backend's shape and hands the result to the
// caller (onSave / onRemove); the caller keeps it in the checklist draft, and "Save checklist" stores the
// draft as a new checklist version.

import { t } from "./i18n.js?v=tape6";
import { Button } from "./ui.js?v=tape6";
import { esc } from "./util.js";
import {
  CRITERION_ID_RE,
  canon,
  fmt,
  nextCriterionId,
  parseAllowedScores,
  scaleAsScores,
  scalePoints,
  sectionName,
  weightSum,
} from "./checklist.js?v=tape6";

const closeIcon = '<svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const typeLabel = (type) => t(`ce.type.${type}`);
const FIELDS = ["title", "id", "section", "scores", "weight", "wording", "naRule", "criticalRule"];

let dialog = null;
// The open editor: {isNew, original, config, ctx, form, initial, touched, submitted, onSave, onRemove, ...}.
let ed = null;

// ---- form model ----------------------------------------------------------------------------------------

function kindOf(criterion) {
  if (criterion.answer_type === "scale" && scaleAsScores(criterion)) return "numeric";
  return criterion.answer_type ?? "binary";
}

function formFrom(criterion, config) {
  const type = kindOf(criterion);
  const scores = criterion.answer_type === "numeric" ? criterion.allowed_scores : type === "numeric" ? scaleAsScores(criterion) : null;
  const indicator = !!criterion.severe_error_enabled && Number(criterion.weight) === 0 && type === "binary";
  return {
    title: criterion.name ?? "",
    id: criterion.id ?? "",
    section: sectionName(config, criterion.section_id),
    enabled: criterion.enabled !== false,
    type,
    scores: scores ? scores.map(fmt).join(", ") : "",
    weight: criterion.weight == null ? "" : fmt(criterion.weight),
    naAllowed: !!criterion.na_allowed,
    critical: !criterion.severe_error_enabled ? "off" : indicator ? "indicator" : "flag",
    wording: criterion.description ?? "",
    naRule: criterion.na_rule ?? "",
    criticalRule: criterion.severe_error_rule ?? "",
  };
}

function newForm(config) {
  const used = weightSum(config.criteria.filter((c) => c.enabled !== false).map((c) => c.weight));
  const remaining = Math.round((100 - used) * 1e6) / 1e6;
  return {
    title: "", id: nextCriterionId(config), section: "", enabled: true, type: "binary", scores: "",
    weight: remaining > 0 ? fmt(remaining) : "", naAllowed: false, critical: "off", wording: "", naRule: "",
    criticalRule: "",
  };
}

function parseWeight(text) {
  const raw = String(text ?? "").trim().replace(",", ".");
  if (!raw) return { error: t("ce.weight.empty") };
  if (raw.startsWith("-")) return { error: t("ce.weight.negative") };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { error: t("ce.weight.nan") };
  const value = Number(raw);
  if (value > 100) return { error: t("ce.weight.over") };
  if (value === 0) {
    return { error: t("ce.weight.zero") };
  }
  return { value };
}

function errorsFor(form) {
  const errors = {};
  const title = form.title.trim();
  if (!title) errors.title = t("ce.err.title");
  else if (title.length > 200) errors.title = t("ce.err.max", { max: 200 });
  const id = form.id.trim();
  if (!id) errors.id = t("ce.err.id");
  else if (!CRITERION_ID_RE.test(id)) {
    errors.id = t("ce.err.idFormat");
  } else if (ed.config.criteria.some((c) => c.id === id && c.id !== ed.original?.id)) {
    errors.id = t("ce.err.idTaken");
  }
  if (form.section.trim().length > 200) errors.section = t("ce.err.max", { max: 200 });
  if (form.critical !== "indicator") {
    const weight = parseWeight(form.weight);
    if (weight.error) errors.weight = weight.error;
  }
  if (form.type === "numeric" && form.critical !== "indicator") {
    const scores = parseAllowedScores(form.scores);
    if (scores.error) errors.scores = scores.error;
  }
  if (form.wording.length > 4000) errors.wording = t("ce.err.max", { max: 4000 });
  if (form.naRule.length > 2000) errors.naRule = t("ce.err.max", { max: 2000 });
  if (form.criticalRule.length > 2000) errors.criticalRule = t("ce.err.max", { max: 2000 });
  return errors;
}

/** The edited criterion in the backend's shape. Fields the dialog does not show are kept from the original. */
function criterionFrom(form) {
  const original = ed.original ?? {};
  const indicator = form.critical === "indicator";
  const type = indicator ? "binary" : form.type;
  return {
    id: form.id.trim(),
    name: form.title.trim(),
    description: form.wording.trim(),
    section_id: null,
    weight: indicator ? 0 : parseWeight(form.weight).value,
    answer_type: type,
    allowed_scores: type === "numeric" ? parseAllowedScores(form.scores).scores : null,
    scale: type === "scale" ? original.scale : null,
    options: type === "options" ? original.options : null,
    na_allowed: form.naAllowed,
    na_rule: form.naRule.trim(),
    severe_error_enabled: form.critical !== "off",
    severe_error_rule: form.criticalRule.trim(),
    enabled: form.enabled,
  };
}

function isDirty() {
  return !!ed && canon(ed.form) !== ed.initial;
}

// ---- markup --------------------------------------------------------------------------------------------

function textField(key, label, value, { hint = "", placeholder = "", attrs = "" } = {}) {
  return `<div class="ce-field">
    <label class="ui-label" for="ce-${key}">${label}</label>
    <input class="ui-input" id="ce-${key}" data-f="${key}" type="text" value="${esc(value)}"
      placeholder="${esc(placeholder)}" autocomplete="off" ${attrs} />
    <p class="ce-error" id="ce-${key}-error" hidden></p>
    ${hint ? `<p class="hint" id="ce-${key}-hint">${hint}</p>` : ""}
  </div>`;
}

function areaField(key, label, value, { hint = "", placeholder = "", rows = 3, when = "" } = {}) {
  return `<div class="ce-field" ${when ? `data-ce-when="${when}"` : ""}>
    <label class="ui-label" for="ce-${key}">${label}</label>
    <textarea class="ui-textarea" id="ce-${key}" data-f="${key}" rows="${rows}"
      placeholder="${esc(placeholder)}">${esc(value)}</textarea>
    <p class="ce-error" id="ce-${key}-error" hidden></p>
    ${hint ? `<p class="hint" id="ce-${key}-hint">${hint}</p>` : ""}
  </div>`;
}

function segment(name, value, label, checked) {
  return `<label class="ce-seg-item">
    <input type="radio" name="ce-${name}" data-f="${name}" value="${value}" ${checked ? "checked" : ""} />
    <span>${label}</span>
  </label>`;
}

function checkRow(key, label, hint, checked) {
  return `<label class="ui-check ce-check">
    <input type="checkbox" data-f="${key}" aria-describedby="ce-${key}-hint" ${checked ? "checked" : ""} />
    <span class="ce-check-text"><span>${label}</span><span class="hint" id="ce-${key}-hint">${hint}</span></span>
  </label>`;
}

function html() {
  const f = ed.form;
  const kept = ["scale", "options"].includes(f.type) ? f.type : null;
  const sections = [...new Set((ed.config.sections ?? []).map((s) => s.name))];
  return `
  <form class="ce-form" data-ce-form novalidate>
    <header class="ce-head">
      <div>
        <h2 id="ce-dialog-title" class="sheet-title">${esc(t(ed.isNew ? "ce.add" : "ce.edit"))}</h2>
        <p class="hint">${esc(ed.ctx.saveHint)}</p>
      </div>
      <button type="button" class="dialog-close" data-ce-close aria-label="${esc(t("common.close"))}">${closeIcon}</button>
    </header>

    <div class="ce-body">
      <section class="ce-group" aria-labelledby="ce-g-basic">
        <h3 class="ce-group-title" id="ce-g-basic">${esc(t("ce.basic"))}</h3>
        ${textField("title", esc(t("ce.title")), f.title, { attrs: 'maxlength="200"' })}
        <div class="ce-row">
          ${textField("id", esc(t("ce.id")), f.id, {
            hint: esc(t("ce.idHint")),
            attrs: 'maxlength="48" spellcheck="false" autocapitalize="off"',
          })}
          ${textField("section", esc(t("ce.section")), f.section, {
            hint: esc(t("ce.sectionHint")),
            placeholder: t("ce.noSection"),
            attrs: 'maxlength="200" list="ce-sections"',
          })}
        </div>
        <datalist id="ce-sections">${sections.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
        ${checkRow("enabled", esc(t("ce.enabled")), esc(t("ce.enabledHint")), f.enabled)}
      </section>

      <section class="ce-group" aria-labelledby="ce-g-eval">
        <h3 class="ce-group-title" id="ce-g-eval">${esc(t("ce.evalSettings"))}</h3>
        <fieldset class="ce-fieldset" aria-describedby="ce-type-hint">
          <legend class="ui-label">${esc(t("ce.answerType"))}</legend>
          <div class="ce-seg">
            ${segment("type", "binary", esc(typeLabel("binary")), f.type === "binary")}
            ${segment("type", "numeric", esc(typeLabel("numeric")), f.type === "numeric")}
            ${kept ? segment("type", kept, esc(typeLabel(kept)), true) : ""}
          </div>
          <p class="hint" id="ce-type-hint" data-ce-text="type"></p>
        </fieldset>
        <div class="ce-field" data-ce-when="numeric">
          <label class="ui-label" for="ce-scores">${esc(t("ce.allowedScores"))}</label>
          <input class="ui-input" id="ce-scores" data-f="scores" type="text" inputmode="decimal" value="${esc(f.scores)}"
            placeholder="0, 5, 10, 15, 20" autocomplete="off" spellcheck="false" />
          <p class="ce-error" id="ce-scores-error" hidden></p>
          <p class="hint" id="ce-scores-hint" data-ce-text="scores"></p>
        </div>
        <div class="ce-field">
          <label class="ui-label" for="ce-weight">${esc(t("ce.weight"))}</label>
          <div class="ce-suffix">
            <input class="ui-input" id="ce-weight" data-f="weight" type="text" inputmode="decimal" maxlength="12"
              value="${esc(f.weight)}" autocomplete="off" />
            <span aria-hidden="true">%</span>
          </div>
          <p class="ce-error" id="ce-weight-error" hidden></p>
          <p class="hint" id="ce-weight-hint" data-ce-text="weight"></p>
          <p class="ce-total" data-ce-total aria-live="polite"></p>
        </div>
        <div class="ce-field">
          ${checkRow("naAllowed", esc(t("ce.allowNa")), esc(t("ce.allowNaHint")), f.naAllowed)}
        </div>
        <div class="ce-field">
          <span class="ui-label" id="ce-answers-label">${esc(t("ce.allowedAnswers"))}</span>
          <div class="ce-chips" role="list" aria-labelledby="ce-answers-label" data-ce-answers></div>
        </div>
        <fieldset class="ce-fieldset" aria-describedby="ce-critical-hint">
          <legend class="ui-label">${esc(t("ce.critical"))}</legend>
          <div class="ce-seg">
            ${segment("critical", "off", esc(t("ce.crit.off")), f.critical === "off")}
            ${segment("critical", "flag", esc(t("ce.crit.flag")), f.critical === "flag")}
            ${segment("critical", "indicator", esc(t("ce.crit.indicator")), f.critical === "indicator")}
          </div>
          <p class="hint" id="ce-critical-hint" data-ce-text="critical"></p>
        </fieldset>
      </section>

      <section class="ce-group" aria-labelledby="ce-g-ai">
        <h3 class="ce-group-title" id="ce-g-ai">${esc(t("ce.aiInstructions"))}</h3>
        ${areaField("wording", esc(t("ce.wording")), f.wording, {
          rows: 4,
          hint: esc(t("ce.wordingHint")),
        })}
        ${areaField("naRule", esc(t("ce.naRule")), f.naRule, { rows: 2, hint: esc(t("ce.optional")), when: "na" })}
        ${areaField("criticalRule", esc(t("ce.criticalRule")), f.criticalRule, { rows: 2, hint: esc(t("ce.optional")), when: "critical" })}
      </section>
    </div>

    <footer class="ce-actions">
      <div class="ce-actions-row" data-ce-main>
        ${ed.isNew ? "<span></span>" : Button(esc(t("ce.remove")), { variant: "destructive", attrs: "data-ce-remove" })}
        <div class="ui-btn-row">
          ${Button(esc(t("common.cancel")), { attrs: "data-ce-cancel" })}
          ${Button(esc(t("common.save")), { variant: "primary", type: "submit" })}
        </div>
      </div>
      <div class="ce-confirm" data-ce-confirm hidden></div>
    </footer>
  </form>`;
}

// ---- live state ----------------------------------------------------------------------------------------

const $ = (selector) => dialog.querySelector(selector);

function readForm() {
  const value = (key) => $(`[data-f="${key}"]`).value;
  const checked = (key) => $(`[data-f="${key}"]`).checked;
  const radio = (key) => $(`[data-f="${key}"]:checked`)?.value;
  ed.form = {
    title: value("title"), id: value("id"), section: value("section"), enabled: checked("enabled"),
    type: radio("type") ?? "binary", scores: value("scores"), weight: value("weight"), naAllowed: checked("naAllowed"),
    critical: radio("critical") ?? "off", wording: value("wording"), naRule: value("naRule"),
    criticalRule: value("criticalRule"),
  };
}

function typeHint(f) {
  if (f.critical === "indicator") return t("ce.typeHint.indicator");
  if (f.type === "binary") return t("ce.typeHint.binary");
  if (f.type === "numeric") return t("ce.typeHint.numeric");
  if (f.type === "scale") {
    const s = ed.original.scale;
    return t("ce.typeHint.scale", { min: fmt(s.min), max: fmt(s.max), step: fmt(s.step) });
  }
  return t("ce.typeHint.options", { count: ed.original.options.length });
}

function scoresHint(f) {
  const base = t("ce.scoresHint");
  const parsed = parseAllowedScores(f.scores);
  if (parsed.error) return base;
  const max = parsed.scores.at(-1);
  const example = parsed.scores.filter((s) => s > 0).at(-2) ?? parsed.scores[0];
  const weight = parseWeight(f.weight).value;
  const share = weight ? ` = ${fmt(Math.round((example / max) * weight * 100) / 100)}%` : "";
  return `${base} ${t("ce.scoresShare", { max: fmt(max), example: fmt(example), share })}`;
}

function weightHint(f) {
  if (f.critical === "indicator") return t("ce.weightHint.indicator");
  const weight = parseWeight(f.weight).value;
  return weight
    ? t("ce.weightHint.value", { weight: fmt(weight) })
    : t("ce.weightHint.empty");
}

function totalLine(f) {
  const others = weightSum(ed.config.criteria.filter((c) => c.id !== ed.original?.id && c.enabled !== false).map((c) => c.weight));
  if (!f.enabled) return { text: t("ce.total.disabled", { others: fmt(others) }), tone: "" };
  const weight = f.critical === "indicator" ? 0 : parseWeight(f.weight).value;
  if (weight === undefined) return { text: t("ce.total.others", { others: fmt(others) }), tone: "" };
  const total = weightSum([others, weight]);
  if (total === 100) return { text: t("ce.total.ok"), tone: "ok" };
  return { text: t("ce.total.warn", { total: fmt(total) }), tone: "warn" };
}

function answerChips(f) {
  let values = null;
  if (f.critical === "indicator" || f.type === "binary") values = [t("ce.answers.yes"), t("ce.answers.no")];
  else if (f.type === "numeric") {
    const parsed = parseAllowedScores(f.scores);
    if (!parsed.error) values = parsed.scores.map(fmt);
  } else if (f.type === "scale") {
    const s = ed.original.scale;
    const points = scalePoints(s);
    values = points && points.length <= 12 ? points.map(fmt) : [t("ce.answers.range", { min: fmt(s.min), max: fmt(s.max), step: fmt(s.step) })];
  } else if (f.type === "options") {
    values = ed.original.options.map((o) => `${o.label} (${fmt(o.points)})`);
  }
  if (!values) return `<span class="hint">${esc(t("ce.answers.invalid"))}</span>`;
  const chips = values.map((v) => `<span class="badge" role="listitem">${esc(v)}</span>`);
  if (f.naAllowed) chips.push(`<span class="badge badge-info" role="listitem">${esc(t("ce.answers.na"))}</span>`);
  return chips.join("");
}

function criticalHint(f) {
  const policy = ed.ctx.policy === "zero_total"
    ? t("ce.policy.zero")
    : t("ce.policy.flag");
  if (f.critical === "flag") return t("ce.critHint.flag", { policy });
  if (f.critical === "indicator") return t("ce.critHint.indicator", { policy });
  return t("ce.critHint.off");
}

function refresh() {
  const f = ed.form;
  const indicator = f.critical === "indicator";
  ed.errors = errorsFor(f);
  dialog.querySelectorAll('[data-f="type"]').forEach((radio) => { radio.disabled = indicator && radio.value !== "binary"; });
  $('[data-ce-text="type"]').textContent = typeHint(f);
  $('[data-ce-when="numeric"]').hidden = f.type !== "numeric" || indicator;
  $('[data-ce-text="scores"]').textContent = scoresHint(f);
  $('[data-f="weight"]').disabled = indicator;
  $('[data-ce-text="weight"]').textContent = weightHint(f);
  const total = totalLine(f);
  const totalEl = $("[data-ce-total]");
  totalEl.textContent = total.text;
  totalEl.className = `ce-total${total.tone ? ` is-${total.tone}` : ""}`;
  $('[data-ce-when="na"]').hidden = !f.naAllowed;
  $('[data-ce-when="critical"]').hidden = f.critical === "off";
  $("[data-ce-answers]").innerHTML = answerChips(f);
  $('[data-ce-text="critical"]').textContent = criticalHint(f);
  for (const key of FIELDS) {
    const input = $(`[data-f="${key}"]`);
    const box = $(`#ce-${key}-error`);
    const message = ed.submitted || ed.touched.has(key) ? ed.errors[key] ?? "" : "";
    box.hidden = !message;
    box.textContent = message;
    input.setAttribute("aria-invalid", message ? "true" : "false");
    const hint = $(`#ce-${key}-hint`);
    const described = [message ? box.id : "", hint ? hint.id : ""].filter(Boolean).join(" ");
    if (described) input.setAttribute("aria-describedby", described);
    else input.removeAttribute("aria-describedby");
  }
}

// ---- actions -------------------------------------------------------------------------------------------

function showConfirm(kind) {
  ed.confirm = kind;
  const box = $("[data-ce-confirm]");
  const title = ed.form.title.trim() || ed.original?.name || "this criterion";
  let text;
  let buttons;
  if (kind === "discard") {
    text = t(ed.isNew ? "ce.discardNew" : "ce.discardChanges");
    buttons = Button(esc(t("ce.keepEditing")), { attrs: "data-ce-keep" }) + Button(esc(t("ce.discard")), { variant: "destructive", attrs: "data-ce-discard" });
  } else if (ed.config.criteria.length <= 1) {
    text = t("ce.lastOne");
    buttons = Button(esc(t("ce.ok")), { attrs: "data-ce-keep" });
  } else {
    text = t("ce.removeConfirm", { title });
    buttons = Button(esc(t("ce.keep")), { attrs: "data-ce-keep" }) + Button(esc(t("ce.remove")), { variant: "destructive", attrs: "data-ce-confirm-remove" });
  }
  box.innerHTML = `<p role="alert">${esc(text)}</p><div class="ui-btn-row">${buttons}</div>`;
  box.hidden = false;
  $("[data-ce-main]").hidden = true;
  box.querySelector("[data-ce-keep]").focus();
}

function hideConfirm() {
  ed.confirm = null;
  $("[data-ce-confirm]").hidden = true;
  $("[data-ce-main]").hidden = false;
  $('[data-ce-main] [type="submit"]').focus();
}

function close() {
  ed = null;
  document.body.style.overflow = "";
  if (dialog?.open) dialog.close();
}

function requestClose() {
  if (!ed) return;
  readForm();
  if (isDirty()) showConfirm("discard");
  else close();
}

function save() {
  readForm();
  ed.submitted = true;
  refresh();
  const first = FIELDS.find((key) => ed.errors[key]);
  if (first) {
    $(`[data-f="${first}"]`).focus();
    return;
  }
  if (!ed.isNew && !isDirty()) {
    close();
    return;
  }
  const { onSave, original } = ed;
  const payload = { criterion: criterionFrom(ed.form), section: ed.form.section.trim(), originalId: original?.id ?? null };
  close();
  onSave(payload);
}

function onFieldChange(e) {
  const key = e.target.dataset?.f;
  if (!key || !ed) return;
  const before = ed.form;
  readForm();
  if (key === "critical" && ed.form.critical !== before.critical) {
    const weightInput = $('[data-f="weight"]');
    if (ed.form.critical === "indicator") {
      // An indicator is an unweighted yes/no answer; remember what it was in case the manager switches back.
      ed.restore = { weight: before.weight, type: before.type };
      weightInput.value = "0";
      $('[data-f="type"][value="binary"]').checked = true;
    } else if (before.critical === "indicator") {
      weightInput.value = ed.restore?.weight && ed.restore.weight !== "0" ? ed.restore.weight : "";
      const type = $(`[data-f="type"][value="${ed.restore?.type ?? "binary"}"]`);
      if (type) type.checked = true;
    }
    readForm();
  }
  if (e.type === "change") ed.touched.add(key);
  refresh();
}

function onClick(e) {
  if (!ed) return;
  if (e.target.closest("[data-ce-close], [data-ce-cancel]")) return requestClose();
  if (e.target.closest("[data-ce-remove]")) return showConfirm("remove");
  if (e.target.closest("[data-ce-keep]")) return hideConfirm();
  if (e.target.closest("[data-ce-discard]")) return close();
  if (e.target.closest("[data-ce-confirm-remove]")) {
    const { onRemove, original } = ed;
    close();
    return onRemove(original.id);
  }
  if (e.target === dialog) {
    // A click on the backdrop (outside the dialog box) closes, unless there are unsaved changes.
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) requestClose();
  }
}

function create() {
  dialog = document.createElement("dialog");
  dialog.className = "dialog ce-dialog";
  dialog.setAttribute("aria-labelledby", "ce-dialog-title");
  document.body.append(dialog);
  dialog.addEventListener("input", onFieldChange);
  dialog.addEventListener("change", onFieldChange);
  dialog.addEventListener("focusout", (e) => {
    const key = e.target.dataset?.f;
    if (!ed || !key || !FIELDS.includes(key)) return;
    ed.touched.add(key);
    refresh();
  });
  dialog.addEventListener("submit", (e) => {
    e.preventDefault();
    if (ed && !ed.confirm) save();
  });
  dialog.addEventListener("click", onClick);
  dialog.addEventListener("cancel", (e) => {
    // Escape: close a confirmation first, and never drop unsaved changes without asking.
    e.preventDefault();
    if (!ed) return;
    if (ed.confirm) hideConfirm();
    else requestClose();
  });
  dialog.addEventListener("close", () => {
    document.body.style.overflow = "";
  });
}

// ---- public --------------------------------------------------------------------------------------------

/**
 * Open the editor. criterion: a criterion of `config` in the backend's shape, or null to add one.
 * onSave({criterion, section, originalId}) and onRemove(id) are called after the dialog closes.
 */
export function openCriterionEditor({ criterion, config, saveHint, policy, onSave, onRemove }) {
  if (!dialog) create();
  const form = criterion ? formFrom(criterion, config) : newForm(config);
  ed = {
    isNew: !criterion,
    original: criterion ? structuredClone(criterion) : null,
    config,
    ctx: { saveHint, policy },
    form,
    initial: canon(form),
    touched: new Set(),
    submitted: false,
    confirm: null,
    restore: null,
    errors: {},
    onSave,
    onRemove,
  };
  dialog.innerHTML = html();
  refresh();
  if (!dialog.open) dialog.showModal();
  document.body.style.overflow = "hidden";
  dialog.scrollTop = 0;
  const title = $('[data-f="title"]');
  title.focus();
  if (criterion) title.select();
}

export function isCriterionEditorOpen() {
  return !!(dialog?.open && ed);
}

export function isCriterionEditorDirty() {
  if (!isCriterionEditorOpen()) return false;
  readForm();
  return isDirty();
}

/** Close the editor, asking first when it has unsaved changes. */
export function closeCriterionEditor() {
  requestClose();
}
