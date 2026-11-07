import { t } from "./i18n.js?v=tape5";
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

const sendIcon =
  '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
const chevronDown =
  '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';

export function Bubble({ align = "start", variant = "secondary", children }) {
  return `<div class="bubble" data-slot="bubble" data-align="${esc(align)}" data-variant="${esc(variant)}">
    <div class="bubble-content" data-slot="bubble-content">${children}</div>
  </div>`;
}

export function Message({ align = "start", children }) {
  return `<div class="message" data-slot="message" data-align="${esc(align)}">
    <div class="message-content" data-slot="message-content">${children}</div>
  </div>`;
}

export function MessageScrollerItem({ id, scrollAnchor = false, children }) {
  return `<div class="ms-item" data-slot="message-scroller-item" data-message-id="${esc(id)}" ${
    scrollAnchor ? "data-scroll-anchor" : ""
  }>${children}</div>`;
}

export function MessageScroller(itemsHtml) {
  return `<div class="ms" data-slot="message-scroller-provider">
    <div class="ms-root" data-slot="message-scroller">
      <div class="ms-viewport" data-slot="message-scroller-viewport">
        <div class="ms-content" data-slot="message-scroller-content" aria-live="polite">${itemsHtml}</div>
      </div>
      <button type="button" class="ms-jump" data-slot="message-scroller-button" hidden>
        ${chevronDown}<span>${esc(t("chat.jumpLatest"))}</span>
      </button>
    </div>
  </div>`;
}

export function InputGroup({ children }) {
  return `<div class="ig" data-slot="input-group">${children}</div>`;
}

export function InputGroupInput({ name = "q", placeholder = "", value = "" }) {
  return `<input class="ig-input" data-slot="input-group-control" name="${esc(name)}" type="text" autocomplete="off" placeholder="${esc(placeholder)}" value="${esc(value)}" />`;
}

export function InputGroupAddon({ align = "inline-end", children }) {
  return `<div class="ig-addon" data-slot="input-group-addon" data-align="${esc(align)}">${children}</div>`;
}

export function InputGroupButton({ label, icon = sendIcon, variant = "default", type = "submit" }) {
  return `<button class="ig-btn ig-btn-${esc(variant)}" data-slot="input-group-button" type="${esc(type)}" aria-label="${esc(label)}">${icon}</button>`;
}

export function ChatPrompt() {
  return InputGroup({
    children:
      InputGroupInput({ placeholder: t("chat.placeholder") }) +
      InputGroupAddon({
        align: "inline-end",
        children: InputGroupButton({ label: t("chat.send") }),
      }),
  });
}
