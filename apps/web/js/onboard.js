import { defaultChecklist } from "./data.js?v=tape2";
import { Field, Input, Select, Textarea } from "./ui.js?v=tape7";
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
  return Math.min(3, Math.max(1, n));
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
    wave: "img/mascot-wave.gif",
    look: "img/mascot-look.gif",
    think: "img/mascot-think.gif",
    idle: "img/mascot-default.gif",
  }[pose] || "img/mascot-default.gif";
  return `<img class="duo-mascot" src="${src}" width="220" height="220" alt="" />`;
}

function draftOf(state) {
  return state.onboardDraft || { pack: "", json: "", payload: "" };
}

export function continueEnabled(state, step) {
  const d = draftOf(state);
  const hasCriteria = state.checklist.criteria.some((c) => c.id);
  if (step <= 1) return true;
  if (step === 2) return Boolean(d.pack) && hasCriteria;
  if (d.json === "sample") return true;
  return d.json === "file" && Boolean((d.payload || "").trim());
}

function choice(id, group, title, hint, on) {
  return `<button type="button" class="duo-choice ${on ? "is-on" : ""}" data-choice-group="${esc(group)}" data-choice="${esc(id)}">
    <strong>${esc(title)}</strong>
    <span>${esc(hint)}</span>
  </button>`;
}

function stepCriteria(state) {
  const d = draftOf(state);
  const rows = state.checklist.criteria.filter((c) => c.id);
  const custom = d.pack === "custom";
  return `
    <div class="duo-choices">
      ${choice("official", "pack", "Official 8 criteria", "Contact through critical, ready to score", d.pack === "official")}
      ${choice("custom", "pack", "I'll add my own", "Write rules one by one", custom)}
    </div>
    <form class="duo-form" data-onboard-add ${custom ? "" : "hidden"}>
      <div class="duo-fields">
        ${Field("ID", Input({ field: "id", placeholder: "contact" }))}
        ${Field("Title", Input({ field: "title", placeholder: "Контакт" }))}
        ${Field("Weight", Input({ field: "weight", type: "number", value: "10" }))}
        ${Field("Type", Select({
          field: "answerType",
          value: "yes_no",
          options: [
            { value: "yes_no", label: "yes/no" },
            { value: "scale", label: "scale" },
          ],
        }))}
      </div>
      ${Field("Wording", Textarea({ field: "wording", rows: 4, placeholder: "What the operator must do, and how to score it." }))}
      <button class="duo-add" type="submit">Add this criterion</button>
      <div class="duo-chips">
        ${rows.map((c) => `<span class="duo-chip">${esc(c.title || c.id)} <button type="button" data-onboard-remove="${esc(c.id)}" aria-label="Remove">×</button></span>`).join("")}
      </div>
    </form>`;
}

function stepJson(state) {
  const d = draftOf(state);
  const file = d.json === "file";
  return `
    <div class="duo-choices">
      ${choice("sample", "json", "Try a sample chat", "One Freedom transfer, already scored", d.json === "sample")}
      ${choice("file", "json", "Upload JSON", "data.records with speaker and text", file)}
    </div>
    <div class="duo-upload" ${file ? "" : "hidden"}>
      <label class="duo-drop">
        <input type="file" accept="application/json,.json" data-onboard-file hidden />
        Drop a JSON file, or click to choose
      </label>
      ${Textarea({ field: "payload", value: d.payload || "", rows: 7, placeholder: '{ "data": { "records": [] } }' })}
      <p class="onboard-error" data-onboard-error hidden></p>
    </div>`;
}

const SCREENS = {
  1: {
    pose: "wave",
    say: "Hi! I'll get you to a real evaluation in three taps: rules, transcripts, score.",
    continue: "Continue",
  },
  2: {
    pose: "look",
    say: "How should we write the scoring rules?",
    continue: "Continue",
  },
  3: {
    pose: "think",
    say: "Now the chats. Sample, or your JSON?",
    continue: "See my first score",
  },
};

export function viewOnboard(state, step) {
  const screen = SCREENS[step] || SCREENS[1];
  const d = draftOf(state);
  const can = continueEnabled(state, step);
  const pct = step === 1 ? 18 : step === 2 ? 55 : 88;
  const body = step === 1 ? "" : step === 2 ? stepCriteria(state) : stepJson(state);
  return `
    <section class="duo" data-onboard-step="${step}" data-pack="${esc(d.pack || "")}" data-json="${esc(d.json || "")}">
      <header class="duo-top">
        <button type="button" class="duo-x" data-onboard="skip" aria-label="Skip setup">
          <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
        <div class="duo-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
      </header>
      <div class="duo-mid">
        <div class="duo-hero">
          ${mascot(screen.pose)}
          <div class="duo-say"><p>${esc(screen.say)}</p></div>
        </div>
        ${body}
      </div>
      <footer class="duo-foot">
        <button type="button" class="duo-continue" data-onboard="continue" ${can ? "" : "disabled"}>${esc(screen.continue)}</button>
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
  if (!id) return { ok: false, error: "Give it an ID, like contact." };
  if (state.checklist.criteria.some((c) => c.id === id)) return { ok: false, error: "That ID is already used." };
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
