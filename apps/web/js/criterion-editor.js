// Add / Edit criterion dialog. A native modal <dialog> outside #view, so re-rendering the page behind it never
// clears what the manager typed. It edits one criterion in the backend's shape and hands the result to the
// caller (onSave / onRemove); the caller keeps it in the checklist draft, and "Save & re-evaluate" stores the
// draft as a new checklist version.

import { Button } from "./ui.js?v=tape1";
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
} from "./checklist.js?v=tape3";

const closeIcon = '<svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const TYPE_LABELS = { binary: "Yes / No", numeric: "Numeric", scale: "Scale", options: "Options" };
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
  if (!raw) return { error: "Enter the weight as a percentage, for example 20." };
  if (raw.startsWith("-")) return { error: "The weight can't be negative." };
  if (!/^\d+(\.\d+)?$/.test(raw)) return { error: "Enter a number, for example 20 or 12.5." };
  const value = Number(raw);
  if (value > 100) return { error: "The weight is a share of 100%, so it can't be above 100." };
  if (value === 0) {
    return { error: "Weight 0 is only for an unweighted critical-error indicator. Enter a weight above 0, or set Critical error to Indicator." };
  }
  return { value };
}

function errorsFor(form) {
  const errors = {};
  const title = form.title.trim();
  if (!title) errors.title = "Enter a title.";
  else if (title.length > 200) errors.title = "Use at most 200 characters.";
  const id = form.id.trim();
  if (!id) errors.id = "Enter an ID.";
  else if (!CRITERION_ID_RE.test(id)) {
    errors.id = "Use lowercase letters, digits, “-” or “_”, starting with a letter or digit (at most 48 characters).";
  } else if (ed.config.criteria.some((c) => c.id === id && c.id !== ed.original?.id)) {
    errors.id = "Another criterion already uses this ID.";
  }
  if (form.section.trim().length > 200) errors.section = "Use at most 200 characters.";
  if (form.critical !== "indicator") {
    const weight = parseWeight(form.weight);
    if (weight.error) errors.weight = weight.error;
  }
  if (form.type === "numeric" && form.critical !== "indicator") {
    const scores = parseAllowedScores(form.scores);
    if (scores.error) errors.scores = scores.error;
  }
  if (form.wording.length > 4000) errors.wording = "Use at most 4000 characters.";
  if (form.naRule.length > 2000) errors.naRule = "Use at most 2000 characters.";
  if (form.criticalRule.length > 2000) errors.criticalRule = "Use at most 2000 characters.";
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
        <h2 id="ce-dialog-title" class="sheet-title">${ed.isNew ? "Add criterion" : "Edit criterion"}</h2>
        <p class="hint">${esc(ed.ctx.saveHint)}</p>
      </div>
      <button type="button" class="dialog-close" data-ce-close aria-label="Close">${closeIcon}</button>
    </header>

    <div class="ce-body">
      <section class="ce-group" aria-labelledby="ce-g-basic">
        <h3 class="ce-group-title" id="ce-g-basic">Basic information</h3>
        ${textField("title", "Title", f.title, { attrs: 'maxlength="200"' })}
        <div class="ce-row">
          ${textField("id", "ID", f.id, {
            hint: "Lowercase letters, digits, - or _. Evaluations and appeals refer to it.",
            attrs: 'maxlength="48" spellcheck="false" autocapitalize="off"',
          })}
          ${textField("section", "Section", f.section, {
            hint: "Optional. Groups criteria in results.",
            placeholder: "No section",
            attrs: 'maxlength="200" list="ce-sections"',
          })}
        </div>
        <datalist id="ce-sections">${sections.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
        ${checkRow("enabled", "Enabled", "Disabled criteria stay in the checklist but are not evaluated or scored.", f.enabled)}
      </section>

      <section class="ce-group" aria-labelledby="ce-g-eval">
        <h3 class="ce-group-title" id="ce-g-eval">Evaluation settings</h3>
        <fieldset class="ce-fieldset" aria-describedby="ce-type-hint">
          <legend class="ui-label">Answer type</legend>
          <div class="ce-seg">
            ${segment("type", "binary", TYPE_LABELS.binary, f.type === "binary")}
            ${segment("type", "numeric", TYPE_LABELS.numeric, f.type === "numeric")}
            ${kept ? segment("type", kept, TYPE_LABELS[kept], true) : ""}
          </div>
          <p class="hint" id="ce-type-hint" data-ce-text="type"></p>
        </fieldset>
        <div class="ce-field" data-ce-when="numeric">
          <label class="ui-label" for="ce-scores">Allowed scores</label>
          <input class="ui-input" id="ce-scores" data-f="scores" type="text" inputmode="decimal" value="${esc(f.scores)}"
            placeholder="0, 5, 10, 15, 20" autocomplete="off" spellcheck="false" />
          <p class="ce-error" id="ce-scores-error" hidden></p>
          <p class="hint" id="ce-scores-hint" data-ce-text="scores"></p>
        </div>
        <div class="ce-field">
          <label class="ui-label" for="ce-weight">Weight (%)</label>
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
          ${checkRow("naAllowed", "Allow N/A", "The evaluator may answer N/A (null) when the situation did not happen. N/A is not 0: the criterion is left out and its weight is shared by the others.", f.naAllowed)}
        </div>
        <div class="ce-field">
          <span class="ui-label" id="ce-answers-label">Allowed answers</span>
          <div class="ce-chips" role="list" aria-labelledby="ce-answers-label" data-ce-answers></div>
        </div>
        <fieldset class="ce-fieldset" aria-describedby="ce-critical-hint">
          <legend class="ui-label">Critical error</legend>
          <div class="ce-seg">
            ${segment("critical", "off", "Off", f.critical === "off")}
            ${segment("critical", "flag", "Can flag", f.critical === "flag")}
            ${segment("critical", "indicator", "Indicator", f.critical === "indicator")}
          </div>
          <p class="hint" id="ce-critical-hint" data-ce-text="critical"></p>
        </fieldset>
      </section>

      <section class="ce-group" aria-labelledby="ce-g-ai">
        <h3 class="ce-group-title" id="ce-g-ai">AI evaluation instructions</h3>
        ${areaField("wording", "Wording", f.wording, {
          rows: 4,
          hint: "What the evaluator checks in the transcript. Copy it from the official checklist; when it is empty, the evaluator sees only the title.",
        })}
        ${areaField("naRule", "When N/A applies", f.naRule, { rows: 2, hint: "Optional.", when: "na" })}
        ${areaField("criticalRule", "What counts as a critical error", f.criticalRule, { rows: 2, hint: "Optional.", when: "critical" })}
      </section>
    </div>

    <footer class="ce-actions">
      <div class="ce-actions-row" data-ce-main>
        ${ed.isNew ? "<span></span>" : Button("Remove", { variant: "destructive", attrs: "data-ce-remove" })}
        <div class="ui-btn-row">
          ${Button("Cancel", { attrs: "data-ce-cancel" })}
          ${Button("Save", { variant: "primary", type: "submit" })}
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
  if (f.critical === "indicator") return "Indicators are always Yes / No.";
  if (f.type === "binary") return "Boolean. Yes earns the full weight, No earns 0.";
  if (f.type === "numeric") return "The evaluator gives one of the allowed scores.";
  if (f.type === "scale") {
    const s = ed.original.scale;
    return `Scale ${fmt(s.min)}–${fmt(s.max)} (step ${fmt(s.step)}), kept as configured. Choose Yes / No or Numeric to replace it.`;
  }
  return `${ed.original.options.length} labelled options, kept as configured. Choose Yes / No or Numeric to replace them.`;
}

function scoresHint(f) {
  const base = "Separate with commas, from lowest to highest.";
  const parsed = parseAllowedScores(f.scores);
  if (parsed.error) return base;
  const max = parsed.scores.at(-1);
  const example = parsed.scores.filter((s) => s > 0).at(-2) ?? parsed.scores[0];
  const weight = parseWeight(f.weight).value;
  const share = weight ? ` = ${fmt(Math.round((example / max) * weight * 100) / 100)}%` : "";
  return `${base} ${fmt(max)} earns the full weight; ${fmt(example)} earns ${fmt(example)} ÷ ${fmt(max)} of it${share}.`;
}

function weightHint(f) {
  if (f.critical === "indicator") return "Indicators are not scored, so their weight is 0.";
  const weight = parseWeight(f.weight).value;
  return weight
    ? `This criterion is worth ${fmt(weight)}% of the overall score.`
    : "A share of the overall score: 20 means 20%.";
}

function totalLine(f) {
  const others = weightSum(ed.config.criteria.filter((c) => c.id !== ed.original?.id && c.enabled !== false).map((c) => c.weight));
  if (!f.enabled) return { text: `Disabled criteria don't count. The other enabled criteria add up to ${fmt(others)}%.`, tone: "" };
  const weight = f.critical === "indicator" ? 0 : parseWeight(f.weight).value;
  if (weight === undefined) return { text: `The other enabled criteria add up to ${fmt(others)}%.`, tone: "" };
  const total = weightSum([others, weight]);
  if (total === 100) return { text: "Enabled criteria add up to 100%.", tone: "ok" };
  return { text: `Enabled criteria would add up to ${fmt(total)}%. A checklist version needs exactly 100%.`, tone: "warn" };
}

function answerChips(f) {
  let values = null;
  if (f.critical === "indicator" || f.type === "binary") values = ["Yes (true)", "No (false)"];
  else if (f.type === "numeric") {
    const parsed = parseAllowedScores(f.scores);
    if (!parsed.error) values = parsed.scores.map(fmt);
  } else if (f.type === "scale") {
    const s = ed.original.scale;
    const points = scalePoints(s);
    values = points && points.length <= 12 ? points.map(fmt) : [`${fmt(s.min)} to ${fmt(s.max)}, step ${fmt(s.step)}`];
  } else if (f.type === "options") {
    values = ed.original.options.map((o) => `${o.label} (${fmt(o.points)})`);
  }
  if (!values) return '<span class="hint">Enter valid allowed scores to see the answers.</span>';
  const chips = values.map((v) => `<span class="badge" role="listitem">${esc(v)}</span>`);
  if (f.naAllowed) chips.push('<span class="badge badge-info" role="listitem">N/A (null)</span>');
  return chips.join("");
}

function criticalHint(f) {
  const policy = ed.ctx.policy === "zero_total"
    ? "This checklist's scoring rules set the total to 0 when a critical error is found."
    : "A critical error is reported next to the score; it does not change the total.";
  if (f.critical === "flag") return `Scored as usual; the evaluator can also flag a critical error on it. ${policy}`;
  if (f.critical === "indicator") return `Not scored (weight 0). The evaluator answers Yes when a critical error was found. ${policy}`;
  return "This criterion never reports a critical error.";
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
    text = ed.isNew ? "Discard this new criterion?" : "Discard your changes to this criterion?";
    buttons = Button("Keep editing", { attrs: "data-ce-keep" }) + Button("Discard", { variant: "destructive", attrs: "data-ce-discard" });
  } else if (ed.config.criteria.length <= 1) {
    text = "A checklist needs at least one criterion, so this one can't be removed.";
    buttons = Button("OK", { attrs: "data-ce-keep" });
  } else {
    text = `Remove “${title}” from the checklist? Earlier versions keep it. To leave it out of scoring instead, turn off Enabled.`;
    buttons = Button("Keep", { attrs: "data-ce-keep" }) + Button("Remove", { variant: "destructive", attrs: "data-ce-confirm-remove" });
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
