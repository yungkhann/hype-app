// JSON drop target, same shape as the mittens upload panel: dashed box, drag
// highlight, then a filename and a bar while the file is read.
import { t } from "./i18n.js?v=tape37";
import { esc } from "./util.js";

const MAX_BYTES = 20 * 1024 * 1024;

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function jsonFileError(file) {
  if (!file) return "";
  const name = file.name || "";
  if (!/\.json$/i.test(name) && file.type !== "application/json") return t("list.dropBadType");
  if (file.size > MAX_BYTES) return t("list.dropTooBig", { max: formatBytes(MAX_BYTES) });
  return "";
}

export function fileDropHtml({ title, hint, choose, done = false, name = "" } = {}) {
  return `
    <div class="file-drop" data-file-drop data-drop-label="${esc(title)}">
      <input type="file" accept="application/json,.json" hidden data-drop-input />
      <div data-drop-idle>
        <svg class="file-drop-ico" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>
        </svg>
        <p class="file-drop-title" data-drop-title>${esc(done && name ? name : title)}</p>
        <p class="file-drop-hint">${esc(hint || "")}</p>
        <button type="button" class="ui-btn ui-btn-primary" data-drop-pick>${esc(choose)}</button>
        <p class="file-drop-error" data-drop-error hidden role="alert"></p>
      </div>
      <div data-drop-busy hidden>
        <p class="file-drop-title" data-drop-name></p>
        <p class="file-drop-hint" data-drop-progress></p>
        <div class="file-drop-bar" aria-hidden="true"><span data-drop-bar></span></div>
      </div>
    </div>`;
}

export function setFileDropError(root, message) {
  if (!root) return;
  showIdle(root);
  const el = root.querySelector("[data-drop-error]");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

export function setFileDropBusy(root, name, loaded, total) {
  if (!root) return;
  root.classList.remove("is-drag");
  root.querySelector("[data-drop-idle]").hidden = true;
  const busy = root.querySelector("[data-drop-busy]");
  busy.hidden = false;
  busy.querySelector("[data-drop-name]").textContent = name || "";
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  busy.querySelector("[data-drop-progress]").textContent = t("list.dropReading", {
    size: `${formatBytes(loaded)} / ${formatBytes(total)}`,
  });
  busy.querySelector("[data-drop-bar]").style.width = `${pct}%`;
}

export function resetFileDrop(root) {
  if (!root) return;
  root.dataset.dropGen = String(Number(root.dataset.dropGen || 0) + 1);
  showIdle(root);
  const title = root.querySelector("[data-drop-title]");
  if (title) title.textContent = root.getAttribute("data-drop-label") || "";
  setFileDropError(root, "");
  const bar = root.querySelector("[data-drop-bar]");
  if (bar) bar.style.width = "0";
}

export function showFileName(root, name) {
  if (!root?.isConnected) return;
  showIdle(root);
  const title = root.querySelector("[data-drop-title]");
  if (title) title.textContent = name || root.getAttribute("data-drop-label") || "";
  setFileDropError(root, "");
}

export function readDropFile(root, file, onProgress) {
  const gen = root.dataset.dropGen || "0";
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const aborted = () => (root.dataset.dropGen || "0") !== gen;
    reader.onprogress = (e) => {
      if (aborted()) {
        reader.abort();
        return;
      }
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    reader.onload = () => (aborted() ? reject(new Error("aborted")) : resolve(String(reader.result || "")));
    reader.onabort = () => reject(new Error("aborted"));
    reader.onerror = () => reject(reader.error || new Error("read"));
    reader.readAsText(file);
  });
}

export function bindFileDrop(root, { onFile } = {}) {
  if (!root || root.dataset.dropBound) return;
  root.dataset.dropBound = "1";
  const input = root.querySelector("[data-drop-input]");
  const busy = () => !root.querySelector("[data-drop-busy]").hidden;
  root.querySelector("[data-drop-pick]")?.addEventListener("click", () => {
    if (!busy()) input?.click();
  });
  input?.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) onFile?.(file);
  });
  root.addEventListener("dragover", (e) => {
    if (!hasFiles(e) || busy()) return;
    e.preventDefault();
    root.classList.add("is-drag");
  });
  root.addEventListener("dragleave", (e) => {
    if (e.relatedTarget && root.contains(e.relatedTarget)) return;
    root.classList.remove("is-drag");
  });
  root.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    root.classList.remove("is-drag");
    const file = e.dataTransfer.files?.[0];
    if (file && !busy()) onFile?.(file);
  });
}

function showIdle(root) {
  root.classList.remove("is-drag");
  const idle = root.querySelector("[data-drop-idle]");
  const busy = root.querySelector("[data-drop-busy]");
  if (idle) idle.hidden = false;
  if (busy) busy.hidden = true;
}

function hasFiles(e) {
  const types = e.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes("Files"));
}
