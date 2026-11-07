import { esc } from "./util.js";

export function Label(text) {
  return `<span class="ui-label">${esc(text)}</span>`;
}

export function Field(label, control) {
  return `<label class="ui-field">${Label(label)}${control}</label>`;
}

export function Input({ field, value = "", type = "text", placeholder = "" }) {
  return `<input class="ui-input" data-field="${esc(field)}" type="${esc(type)}" value="${esc(value)}" placeholder="${esc(placeholder)}" />`;
}

export function Select({ field, value, options }) {
  return `<span class="ui-select-wrap">
    <select class="ui-select" data-field="${esc(field)}">
      ${options
        .map(
          (o) =>
            `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? "selected" : ""}>${esc(o.label)}</option>`
        )
        .join("")}
    </select>
  </span>`;
}

export function Textarea({ field, value = "", placeholder = "" }) {
  return `<textarea class="ui-textarea" data-field="${esc(field)}" placeholder="${esc(placeholder)}" rows="3">${esc(value)}</textarea>`;
}

export function Checkbox({ field, checked, label }) {
  return `<label class="ui-check">
    <input type="checkbox" data-field="${esc(field)}" ${checked ? "checked" : ""} />
    ${esc(label)}
  </label>`;
}

export function Button(label, { variant = "outline", attrs = "", type = "button" } = {}) {
  return `<button class="ui-btn ui-btn-${variant}" type="${type}" ${attrs}>${label}</button>`;
}

export function Card(body, attrs = "") {
  return `<div class="ui-card" ${attrs}>${body}</div>`;
}

export function Alert(text, variant = "warn") {
  return `<div class="ui-alert ui-alert-${variant}" role="status">${esc(text)}</div>`;
}
