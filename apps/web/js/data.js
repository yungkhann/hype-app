const SCRIPTS = {
  ru: {
    client: ["Здравствуйте, не проходит перевод на карту.", "Сумма списалась, но получатель ничего не видит.", "Хорошо, жду статус."],
    operator: [
      "Здравствуйте, меня зовут Айгерим, компания Freedom Broker. Чем могу помочь?",
      "Уточните, пожалуйста, номер заявки и сумму перевода.",
      "Проверила операцию: перевод в обработке, статус обновится в течение часа. Подтвердите, пожалуйста, ИИН.",
      "Извините за ожидание. Дальше придёт SMS. Если не обновится — напишите нам снова. Всего доброго.",
    ],
    bot: "Бот: диалог переведён на оператора.",
    system: "system: language=ru",
  },
  kz: {
    client: ["Сәлеметсіз бе, картаға аударым өтпей жатыр.", "Ақша шешілді, алушыда жоқ.", "Жақсы, күтемін."],
    operator: [
      "Сәлеметсіз бе, менің атым Айгерим, Freedom Broker. Қалай көмектесе аламын?",
      "Өтініш нөмірін және соманы нақтылаңызшы.",
      "Операцияны тексердім: өңделіп жатыр, бір сағат ішінде жаңартылады. ЖСН-ді растаңыз.",
      "Күткеніңіз үшін кешіріңіз. SMS келеді. Жаңармаса, қайта жазыңыз. Сау болыңыз.",
    ],
    bot: "Бот: операторға қосылды.",
    system: "system: language=kz",
  },
  en: {
    client: ["Hi, my card transfer is stuck.", "The amount left my account but the recipient sees nothing.", "Okay, I will wait."],
    operator: [
      "Hello, my name is Aigerim from Freedom Broker. How can I help you?",
      "Please confirm the request number and the transfer amount.",
      "I checked the operation: it is processing and should update within an hour. Please confirm your ID number.",
      "Sorry for the wait. You will get an SMS. If it does not update, write us again. Have a good day.",
    ],
    bot: "Bot: handed off to operator.",
    system: "system: language=en",
  },
};

export function defaultChecklist() {
  return {
    id: "cqa-v1",
    title: "Operator quality — draft 8 criteria",
    rounding: 2,
    note: "Placeholder until the organizer checklist PDF is loaded. Weights/scales are editable.",
    criteria: [
      { id: "c1", section: "Opening", title: "Greeting & identification", wording: "Operator greets and states name/company.", weight: 10, answerType: "yes_no", scale: { yes: 1, no: 0 }, naAllowed: false, enabled: true, severe: false, signals: { positive: ["Freedom Broker", "Айгерим", "Aigerim", "менің атым"], negative: [] } },
      { id: "c2", section: "Service", title: "Needs clarification", wording: "Operator asks for the facts needed to diagnose the issue.", weight: 15, answerType: "scale", scale: { min: 0, max: 2, step: 1 }, naAllowed: false, enabled: true, severe: false, signals: { positive: ["номер", "сома", "amount", "request number", "нақтыла"], negative: [] } },
      { id: "c3", section: "Service", title: "Solution completeness", wording: "Operator explains status and next step.", weight: 20, answerType: "scale", scale: { min: 0, max: 2, step: 1 }, naAllowed: false, enabled: true, severe: false, signals: { positive: ["обработ", "processing", "өңделіп", "SMS", "сағат", "hour"], negative: [] } },
      { id: "c4", section: "Service", title: "Empathy / tone", wording: "Operator acknowledges inconvenience.", weight: 10, answerType: "scale", scale: { min: 0, max: 2, step: 1 }, naAllowed: false, enabled: true, severe: false, signals: { positive: ["Извините", "кешіріңіз", "Sorry"], negative: [] } },
      { id: "c5", section: "Compliance", title: "Identity confirmation", wording: "Operator confirms a client identifier before account details.", weight: 15, answerType: "yes_no", scale: { yes: 1, no: 0 }, naAllowed: false, enabled: true, severe: true, signals: { positive: ["ИИН", "ЖСН", "ID number"], negative: [] } },
      { id: "c6", section: "Service", title: "Hold / wait handling", wording: "If the client waited, operator addresses the wait.", weight: 5, answerType: "yes_no", scale: { yes: 1, no: 0 }, naAllowed: true, enabled: true, severe: false, signals: { positive: ["ожидан", "күт", "wait"], negative: [] } },
      { id: "c7", section: "Compliance", title: "No prohibited promises", wording: "Operator does not guarantee outcomes they cannot control.", weight: 10, answerType: "yes_no", scale: { yes: 1, no: 0 }, naAllowed: false, enabled: true, severe: true, signals: { positive: ["если не", "If it does not", "Жаңармаса"], negative: ["гарантирую", "I guarantee", "кепіл"] } },
      { id: "c8", section: "Closing", title: "Closing & next steps", wording: "Operator closes with a clear follow-up.", weight: 15, answerType: "yes_no", scale: { yes: 1, no: 0 }, naAllowed: false, enabled: true, severe: false, signals: { positive: ["Всего доброго", "Сау болыңыз", "Have a good day"], negative: [] } },
    ],
  };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function transcript(lang, index, isCall, broken) {
  const s = SCRIPTS[lang];
  const start = new Date(Date.UTC(2026, 10, 7, 6, index % 60, 0));
  const msgs = [];
  const push = (speaker, text, sec) => {
    msgs.push({
      id: `m-${index}-${msgs.length}`,
      ts: new Date(start.getTime() + sec * 1000).toISOString(),
      speaker,
      text,
    });
  };
  push("system", s.system, 0);
  push("bot", s.bot, 2);
  push("client", s.client[0], 5);
  if (!broken?.skipGreeting) push("operator", s.operator[0], 12);
  push("client", s.client[1], 20);
  if (!broken?.skipClarify) push("operator", s.operator[1], 28);
  if (!broken?.skipId) push("operator", s.operator[2], 40);
  push("client", s.client[2], 48);
  if (broken?.injectHold) push("client", lang === "en" ? "I have been on hold for five minutes." : lang === "kz" ? "Бес минут күтіп тұрмын." : "Я уже пять минут на ожидании.", 50);
  if (!broken?.skipClose) push("operator", s.operator[3], 58);
  return msgs;
}

export function buildConversations() {
  const langs = [...Array(35).fill("ru"), ...Array(15).fill("kz"), ...Array(15).fill("en")];
  const callAt = new Set([3, 18, 36, 48, 62]);
  return langs.map((language, i) => {
    const isCall = callAt.has(i);
    const broken = {
      skipGreeting: i > 0 && i % 11 === 0,
      skipClarify: i > 0 && i % 13 === 0,
      skipId: i > 0 && i % 17 === 0,
      skipClose: i > 0 && i % 19 === 0,
      injectHold: i > 0 && i % 7 === 0,
    };
    return {
      id: `conv-${pad(i + 1)}`,
      group_id: "dev",
      language,
      source: isCall ? "call" : "synthetic",
      operator: "Aigerim K.",
      startedAt: new Date(Date.UTC(2026, 10, 7, 6, i, 0)).toISOString(),
      audioUrl: isCall ? "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3" : null,
      messages: transcript(language, i, isCall, broken),
    };
  });
}

export function parseApiPayload(json, groupId) {
  const records = json?.data?.records ?? json?.records ?? [];
  return records.map((rec, i) => ({
    id: rec.id ?? rec.conversation_id ?? `api-${i + 1}`,
    group_id: groupId,
    language: rec.language ?? rec.lang ?? "ru",
    source: rec.source ?? (rec.audio_url || rec.audioUrl ? "call" : "synthetic"),
    operator: rec.operator ?? rec.operator_name ?? "operator",
    startedAt: rec.started_at ?? rec.startedAt ?? rec.messages?.[0]?.ts ?? new Date().toISOString(),
    audioUrl: rec.audio_url ?? rec.audioUrl ?? null,
    messages: (rec.transcript ?? rec.messages ?? []).map((m, j) => ({
      id: m.id ?? `m-${i}-${j}`,
      ts: m.ts ?? m.timestamp ?? m.time,
      speaker: m.speaker ?? m.role ?? "system",
      text: m.text ?? m.content ?? "",
    })),
  }));
}
