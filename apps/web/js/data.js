// Conversations are not generated here: they come from the ATLAS backend (see api.js and store.js).

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

/** A stored backend conversation record → the shape the views use. The record keeps every original field
 *  (conversation_id, channel, language, transcript speaker/timestamp/text, audio_url); nothing is translated. */
export function fromRecord(record) {
  return {
    id: record.id,
    groupIds: record.group_ids ?? [],
    language: String(record.language ?? "").toLowerCase(),
    source: record.channel === "voice" ? "call" : "chat",
    channel: record.channel_raw,
    operator: "",
    audioUrl: record.audio_url ?? null,
    hash: record.transcript_hash,
    revision: record.revision,
    messages: (record.messages ?? []).map((m) => ({ id: m.id, ts: m.timestamp, speaker: m.speaker, text: m.text })),
  };
}
