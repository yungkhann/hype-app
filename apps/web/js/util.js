export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

export function round(value, digits = 2) {
  const f = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * f) / f;
}

export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19);
}

export function uid(prefix = "id") {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export function byId(id) {
  return document.getElementById(id);
}
