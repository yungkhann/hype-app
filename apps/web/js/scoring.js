import { round } from "./util.js";

/** An unweighted critical-error indicator: answered yes/no ("yes" = critical error found), never scored. */
export function isIndicator(criterion) {
  return criterion.answerType === "yes_no" && !!criterion.severe && Number(criterion.weight) === 0;
}

function scoreRange(criterion) {
  const scores = criterion.allowedScores;
  if (scores?.length) return { min: Number(scores[0]), max: Number(scores.at(-1)) };
  return { min: Number(criterion.scale?.min ?? 0), max: Number(criterion.scale?.max ?? 1) };
}

export function maxScore(criterion) {
  if (criterion.answerType === "yes_no") return Number(criterion.scale?.yes ?? 1);
  return scoreRange(criterion).max;
}

export function scoreFromAnswer(criterion, answer) {
  if (answer === "na") return 0;
  if (criterion.answerType === "yes_no") {
    return answer === "yes" ? Number(criterion.scale?.yes ?? 1) : Number(criterion.scale?.no ?? 0);
  }
  const n = Number(answer);
  const { min, max } = scoreRange(criterion);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** N/A items drop out; their weights are redistributed across applicable criteria. */
export function applyWeights(checklist, answers) {
  const enabled = checklist.criteria.filter((c) => c.enabled);
  const applicable = enabled.filter((c) => answers[c.id] !== "na");
  const dropped = enabled.filter((c) => answers[c.id] === "na");
  const base = applicable.reduce((sum, c) => sum + Number(c.weight), 0) || 1;
  const pool = enabled.reduce((sum, c) => sum + Number(c.weight), 0);
  const applied = {};
  for (const c of applicable) applied[c.id] = (Number(c.weight) / base) * pool;
  for (const c of dropped) applied[c.id] = 0;
  return { applied, pool };
}

export function computeResult(checklist, rows) {
  const answers = Object.fromEntries(rows.map((r) => [r.criterionId, r.answer]));
  const { applied, pool } = applyWeights(checklist, answers);
  const byId = Object.fromEntries(checklist.criteria.map((c) => [c.id, c]));
  const sections = {};
  let total = 0;
  let severe = [];
  const scored = rows.map((row) => {
    const c = byId[row.criterionId];
    const max = maxScore(c);
    const raw = scoreFromAnswer(c, row.answer);
    const weight = applied[c.id] ?? 0;
    const weighted = max ? (raw / max) * weight : 0;
    total += weighted;
    if (c.section) {
      if (!sections[c.section]) sections[c.section] = { score: 0, weight: 0 };
      sections[c.section].score += weighted;
      sections[c.section].weight += weight;
    }
    if (c.severe && row.answer === (isIndicator(c) ? "yes" : "no")) severe.push(c.id);
    return { ...row, score: round(raw), max, weightApplied: round(weight), weighted: round(weighted) };
  });
  const rounding = checklist.rounding ?? 2;
  return {
    rows: scored,
    sectionTotals: Object.fromEntries(
      Object.entries(sections).map(([k, v]) => [k, { score: round(v.score, rounding), weight: round(v.weight, rounding) }]),
    ),
    total: round(total, rounding),
    maxTotal: round(pool, rounding),
    severe,
  };
}

export function seedAnswers(conversation, checklist) {
  const text = conversation.messages
    .filter((m) => m.speaker === "operator")
    .map((m) => m.text.toLowerCase())
    .join("\n");
  const all = conversation.messages.map((m) => m.text.toLowerCase()).join("\n");
  const operatorMsgs = conversation.messages.filter((m) => m.speaker === "operator");
  const findMsg = (re) => conversation.messages.find((m) => re.test(m.text))?.id ?? operatorMsgs[0]?.id ?? conversation.messages[0]?.id;
  const hasHold = conversation.messages.some(
    (m) => m.speaker === "client" && /hold|ожидан|күт|минут/i.test(m.text),
  );
  const answers = {};
  for (const c of checklist.criteria) {
    if (!c.enabled) continue;
    const hit = (c.signals?.positive ?? []).some((s) => text.includes(s.toLowerCase()));
    const miss = (c.signals?.negative ?? []).some((s) => all.includes(s.toLowerCase()));
    if (c.naAllowed && c.id === "c6" && !hasHold) {
      answers[c.id] = "na";
      continue;
    }
    if (isIndicator(c)) answers[c.id] = miss ? "yes" : "no";
    else if (c.answerType === "yes_no") answers[c.id] = hit && !miss ? "yes" : "no";
    else if (c.allowedScores?.length) {
      const s = c.allowedScores;
      answers[c.id] = String(hit && !miss ? s.at(-1) : miss ? s[0] : s[Math.floor((s.length - 1) / 2)]);
    } else answers[c.id] = hit && !miss ? String(c.scale.max) : miss ? String(c.scale.min) : String(Math.ceil(((c.scale.min ?? 0) + (c.scale.max ?? 2)) / 2));
  }
  return { answers, findMsg };
}

export function evaluateConversation(conversation, checklist) {
  const { answers, findMsg } = seedAnswers(conversation, checklist);
  const rows = checklist.criteria.filter((c) => c.enabled).map((c) => {
    const answer = answers[c.id] ?? "no";
    const evidenceRe = (c.signals?.positive ?? [])[0] ? new RegExp(c.signals.positive[0], "i") : /./;
    const evidenceId = answer === "na" ? null : findMsg(evidenceRe);
    const spanStart = conversation.messages[0]?.id;
    const spanEnd = conversation.messages.at(-1)?.id;
    return {
      criterionId: c.id,
      answer,
      explanation: explanationFor(c, answer, conversation.language),
      evidenceMessageId: evidenceId,
      examinedSpan: answer === "no" || answer === "na" ? { from: spanStart, to: spanEnd } : null,
      naReason: answer === "na" ? "No hold or wait occurred in this conversation, so the criterion is not applicable." : "",
    };
  });
  const computed = computeResult(checklist, rows);
  return {
    conversationId: conversation.id,
    checklistId: checklist.id,
    ...computed,
  };
}

function explanationFor(criterion, answer, language) {
  if (answer === "na") return "Not applicable: the situation required by this criterion did not occur.";
  if (isIndicator(criterion)) {
    return answer === "yes"
      ? `Critical error found: “${criterion.title}”. Evidence is the cited utterance (${language}).`
      : `No critical error found for “${criterion.title}”.`;
  }
  if (answer === "yes" || Number(answer) === Number(criterion.scale?.max)) {
    return `Operator met “${criterion.title}”. Evidence is the cited utterance (${language}).`;
  }
  if (answer === "no" || Number(answer) === Number(criterion.scale?.min)) {
    return `Missing or incomplete: “${criterion.title}” was checked across the conversation and was not satisfied.`;
  }
  return `Partial credit on “${criterion.title}”.`;
}

export function applyAppeal(evaluation, checklist, criterionId, newAnswer) {
  const rows = evaluation.rows.map((row) =>
    row.criterionId === criterionId ? { ...row, answer: newAnswer, explanation: `${row.explanation} Reviewer updated the answer to ${newAnswer}.` } : row,
  );
  const computed = computeResult(checklist, rows);
  return { ...evaluation, ...computed, originalTotal: evaluation.originalTotal ?? evaluation.total };
}
