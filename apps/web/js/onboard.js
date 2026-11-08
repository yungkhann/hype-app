import { defaultChecklist } from "./data.js?v=tape3";
import { fileDropHtml } from "./file-drop.js?v=tape44";
import { getLang, t } from "./i18n.js?v=tape54";
import { Field, Input, Select, Textarea } from "./ui.js?v=tape23";
import { esc } from "./util.js";

export function emptyCriterion() {
  return {
    id: "",
    section: "",
    title: "",
    wording: "",
    weight: 10,
    answerType: "yes_no",
    scale: { yes: 1, no: 0 },
    naAllowed: false,
    enabled: true,
    severe: false,
    signals: { positive: [], negative: [] },
  };
}

export function onboardStep(hash) {
  const m = (hash || "").match(/^\/onboard(?:\/(\d+))?/);
  if (!m) return 0;
  const n = Number(m[1] || 1);
  return Math.min(4, Math.max(1, n));
}

export function sampleTranscriptJson() {
  return `{
  "error": "",
  "isSuccess": true,
  "data": {
    "dataset_group_id": "ONB",
    "total_records": 1,
    "records": [
      {
        "conversation_id": "onb-01",
        "channel": "chat",
        "language": "RU",
        "audio_url": null,
        "transcript": [
          { "speaker": "client", "timestamp": "00:00", "text": "Здравствуйте, не проходит перевод на карту." },
          { "speaker": "operator", "timestamp": "00:06", "text": "Здравствуйте, меня зовут Айгерим, компания Freedom Broker. Чем могу помочь?" },
          { "speaker": "client", "timestamp": "00:14", "text": "Сумма списалась, но получатель ничего не видит." },
          { "speaker": "operator", "timestamp": "00:20", "text": "Уточните, пожалуйста, номер заявки и сумму перевода." },
          { "speaker": "operator", "timestamp": "00:32", "text": "Проверила операцию: перевод в обработке, статус обновится в течение часа. Подтвердите, пожалуйста, ИИН." },
          { "speaker": "client", "timestamp": "00:40", "text": "Хорошо, жду статус." },
          { "speaker": "operator", "timestamp": "00:48", "text": "Извините за ожидание. Дальше придёт SMS. Если не обновится — напишите нам снова. Всего доброго." }
        ]
      }
    ]
  }
}`;
}

function mascot(pose) {
  const src = {
    wave: "img/mascot-wave.gif?v=3",
    look: "img/mascot-look.gif?v=3",
    think: "img/mascot-think.gif?v=3",
    idle: "img/mascot-default.gif?v=3",
  }[pose] || "img/mascot-default.gif?v=3";
  return `<img class="duo-mascot" src="${src}" width="260" height="260" alt="" />`;
}

function draftOf(state) {
  return state.onboardDraft || { pack: "", json: "", payload: "" };
}

export function continueEnabled(state, step) {
  const d = draftOf(state);
  const hasCriteria = state.checklist.criteria.some((c) => c.id);
  if (step <= 2) return true;
  if (step === 3) return Boolean(d.pack) && hasCriteria;
  if (d.json === "sample") return true;
  return d.json === "file" && Boolean((d.payload || "").trim());
}

function choice(id, group, title, hint, on) {
  return `<button type="button" class="duo-choice ${on ? "is-on" : ""}" data-choice-group="${esc(group)}" data-choice="${esc(id)}" aria-pressed="${on ? "true" : "false"}">
    <span class="duo-choice-copy">
      <strong>${esc(title)}</strong>
      <span>${esc(hint)}</span>
    </span>
    <span class="duo-radio" aria-hidden="true"></span>
  </button>`;
}

function stepLanguage() {
  const current = getLang();
  return `
    <div class="duo-choices">
      ${choice("en", "lang", "English", "The app, in English", current === "en")}
      ${choice("ru", "lang", "Русский", "Приложение на русском", current === "ru")}
      ${choice("kz", "lang", "Қазақша", "Қосымша қазақша", current === "kz")}
    </div>`;
}

function stepCriteria(state) {
  const d = draftOf(state);
  const rows = state.checklist.criteria.filter((c) => c.id);
  const custom = d.pack === "custom";
  return `
    <div class="duo-choices">
      ${choice("official", "pack", t("onboard.rules.official"), t("onboard.rules.officialHint"), d.pack === "official")}
      ${choice("custom", "pack", t("onboard.rules.custom"), t("onboard.rules.customHint"), custom)}
    </div>
    <form class="duo-form" data-onboard-add ${custom ? "" : "hidden"}>
      <div class="duo-fields">
        ${Field(t("onboard.rules.id"), Input({ field: "id", placeholder: "contact" }))}
        ${Field(t("onboard.rules.title"), Input({ field: "title", placeholder: "Контакт" }))}
        ${Field(t("onboard.rules.weight"), Input({ field: "weight", type: "number", value: "10" }))}
        ${Field(t("onboard.rules.type"), Select({
          field: "answerType",
          value: "yes_no",
          options: [
            { value: "yes_no", label: t("onboard.rules.yesno") },
            { value: "scale", label: t("onboard.rules.scale") },
          ],
        }))}
      </div>
      ${Field(t("onboard.rules.wording"), Textarea({ field: "wording", rows: 4, placeholder: t("onboard.rules.wordingPh") }))}
      <button class="duo-add" type="submit">${esc(t("onboard.rules.add"))}</button>
      <div class="duo-chips">
        ${rows.map((c) => `<span class="duo-chip">${esc(c.title || c.id)} <button type="button" data-onboard-remove="${esc(c.id)}" aria-label="${esc(t("onboard.rules.remove"))}">×</button></span>`).join("")}
      </div>
    </form>`;
}

function stepJson(state) {
  const d = draftOf(state);
  const file = d.json === "file";
  return `
    <div class="duo-choices">
      ${choice("sample", "json", t("onboard.chats.sample"), t("onboard.chats.sampleHint"), d.json === "sample")}
      ${choice("file", "json", t("onboard.chats.file"), t("onboard.chats.fileHint"), file)}
    </div>
    <div class="duo-upload" ${file ? "" : "hidden"}>
      ${fileDropHtml({
        title: t("onboard.chats.drop"),
        hint: t("list.dropHint"),
        choose: t("list.dropChoose"),
        done: Boolean((d.payload || "").trim()),
        name: d.fileName || "",
      })}
      ${Textarea({ field: "payload", value: d.payload || "", rows: 7, placeholder: '{ "data": { "records": [] } }' })}
      <p class="onboard-error" data-onboard-error hidden></p>
    </div>`;
}

const STEPS = 4;
let barStep = 0;

function progress(step) {
  const prev = barStep;
  const changed = prev !== step;
  const back = prev > step;
  barStep = step;
  return Array.from({ length: STEPS }, (_, i) => {
    const n = i + 1;
    const cls = back && n === prev ? "is-out" : n < step || (n === step && (!changed || back)) ? "is-done" : n === step ? "is-on" : "";
    return `<span class="${cls}"></span>`;
  }).join("");
}

const SCREENS = {
  1: { pose: "wave", say: () => t("onboard.lang.say"), continue: () => t("onboard.continue"), body: () => stepLanguage() },
  2: { pose: "wave", say: () => t("onboard.welcome.say"), continue: () => t("onboard.continue"), body: () => "" },
  3: { pose: "look", say: () => t("onboard.rules.say"), continue: () => t("onboard.continue"), body: stepCriteria },
  4: { pose: "idle", say: () => t("onboard.chats.say"), continue: () => t("onboard.chats.score"), body: stepJson },
};

export function viewOnboard(state, step) {
  const screen = SCREENS[step] || SCREENS[1];
  const d = draftOf(state);
  const can = continueEnabled(state, step);
  const body = screen.body(state);
  return `
    <section class="duo" data-onboard-step="${step}" data-pack="${esc(d.pack || "")}" data-json="${esc(d.json || "")}">
      <header class="duo-top">
        <button type="button" class="duo-x" data-onboard="skip" aria-label="${esc(t("onboard.skip"))}">
          <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
        <div class="duo-bar" aria-hidden="true">${progress(step)}</div>
      </header>
      <div class="duo-mid">
        <div class="duo-hero">
          ${mascot(screen.pose)}
          <div class="duo-say"><p>${esc(screen.say())}</p></div>
        </div>
        ${body}
      </div>
      <footer class="duo-foot">
        <div class="duo-actions">
          ${step > 1 ? `<button type="button" class="duo-back" data-onboard="back">${esc(t("onboard.back"))}</button>` : ""}
          <button type="button" class="duo-continue" data-onboard="continue" ${can ? "" : "disabled"}>${esc(screen.continue())}</button>
        </div>
      </footer>
    </section>`;
}

export function viewCoach(text) {
  return `
    <aside class="eval-coach" data-eval-coach>
      <div class="eval-coach-face">${mascot("idle")}</div>
      <p>${esc(text)}</p>
      <button type="button" class="duo-continue duo-continue-sm" data-onboard="dismiss-coach">Got it</button>
    </aside>`;
}

export function applyOfficialChecklist(state) {
  state.checklist = defaultChecklist();
  return state;
}

export function addOnboardCriterion(state, form) {
  const val = (name) => form.querySelector(`[data-field="${name}"]`)?.value.trim() ?? "";
  const id = val("id").replace(/\s+/g, "_");
  if (!id) return { ok: false, error: t("onboard.rules.needId") };
  if (state.checklist.criteria.some((c) => c.id === id)) return { ok: false, error: t("onboard.rules.dupId") };
  const row = emptyCriterion();
  row.id = id;
  row.title = val("title") || id;
  row.weight = Number(val("weight") || 0);
  row.answerType = val("answerType") || "yes_no";
  row.wording = val("wording");
  row.scale = row.answerType === "yes_no" ? { yes: 1, no: 0 } : { values: [0, 5, 10] };
  state.checklist.criteria.push(row);
  return { ok: true };
}
