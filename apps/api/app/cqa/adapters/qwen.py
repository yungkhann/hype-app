"""Qwen evaluator: the team's checklist evaluator (v5) on qwen3.8:27b through Ollama's native API (/api/generate).

How it differs from the GPT adapter: the model is not asked for final values. It answers small checks for each
official criterion — a verbatim quote, then ok true/false — plus N/A and a one-sentence rationale, in a strict JSON
schema. Code then verifies every quote against the transcript and derives the values with one generic rule:
a quoted violation [−] -> No; every [+] proven by a quote -> Yes; otherwise the model's N/A -> N/A, else No.
Consultation takes the model's step on the official 0–20 scale; dialogue maps its checks onto 0/4/7/10. The only
computed fact is the operator's first response time (official threshold: 3 minutes).

The prompt is written for the eight official criteria (CQA_Chat_Quality_Checklist.pdf), so in evaluation mode 1
(app/cqa/routing.py) Qwen answers the official criteria whose definition is unchanged; GPT answers new or edited
criteria and reassesses appeals. Measured on the 60 DEV chats (v4, same structure): 92% of criterion values agree
with a manual review under the official rules; every critical case found.

Ollama: ATLAS_CQA_QWEN_BASE_URL (loopback or https; in Docker the ollama-forward sidecar maps localhost:11434 to the
host, where an SSH tunnel can lead to a GPU server). No key is sent.
"""

# ruff: noqa: E501  (the checklist prompt text is kept verbatim, one requirement per line)
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlsplit

from app.cqa.adapters.base import EvaluatorAdapter, EvaluatorError, register_adapter
from app.cqa.adapters.http import is_loopback
from app.cqa.contract import CONTRACT_VERSION, EvaluationRequest, RequestMessage, locate_quote

FIRST_RESPONSE_LIMIT_SEC = 180  # official: the first-reaction threshold is 3 minutes
ORDER = ["contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical"]
EXPLANATION_LANGUAGE = {"ru": "русском", "en": "английском", "kz": "казахском"}

# Checklist as data. Requirement kinds: "+" must be proven by a quote; "-" is a violation (quote required).
# "speakers": whose turn may prove a "+" requirement (default: operator).
CHECKLIST = {
    "contact": {
        "name": "Установление контакта",
        "rule": "Да — оператор поздоровался на языке клиента и представился в первом ответе.",
        "reqs": {
            "greeting": ("+", "В первом ответе оператора есть приветствие на языке клиента."),
            "introduced": ("+", "В первом ответе оператор назвал своё имя ([Имя скрыто] = назвал)."),
        }},
    "discovery": {
        "name": "Выявление потребности",
        "rule": "Да — оператор учёл известные детали и уточнил недостающее до ответа. N/A — данных для ответа хватало с самого начала.",
        "na": "Данных для ответа хватало с самого начала (клиент или бот уже дали всё нужное)? Если оператор не задавал уточняющих вопросов, ничего не переспрашивал, не угадывал и при этом дал верный ответ — значит, данных хватало: na = true.",
        "reqs": {
            "clarified": ("+", "Оператор задал уточняющий вопрос о недостающей детали до ответа."),
            "reask": ("-", "Оператор переспросил то, что клиент уже сообщил (в том числе боту)."),
            "answered_blind": ("-", "Оператор дал ответ или совет, не выяснив недостающие детали, и ошибся в предположении."),
        }},
    "identification": {
        "name": "Идентификация",
        "rule": "Да — проверка личности подтверждена до раскрытия данных или защищённого действия. N/A — запрос не требовал идентификации. Если проверка требовалась и не подтверждена в чате — Нет.",
        "na": "Запрос не требовал идентификации (общий вопрос, навигация по приложению или сайту, ничего по счёту не раскрывалось и не выполнялось)? Если оператор не раскрыл данных счёта и не выполнял защищённых действий, а подтверждения личности в чате нет — na = true (это не «Нет»).",
        "reqs": {
            "confirmed": ("+", "Личность клиента подтверждена в чате (системное сообщение или явная проверка оператором) до раскрытия данных или защищённого действия.", ("operator", "system")),
            "disclosed": ("-", "Оператор раскрыл данные счёта или выполнил защищённое действие без подтверждённой личности."),
        }},
    "empathy": {
        "name": "Эмпатия и клиентоориентированность",
        "rule": "Да — оператор вежлив и, если клиент выразил недовольство или описал неудобство, отреагировал на конкретную проблему.",
        "reqs": {
            "impolite": ("-", "Оператор невежлив: грубость, пренебрежительный или отмахивающийся ответ."),
            "ignored_problem": ("-", "Клиент выразил недовольство или описал неудобство, а оператор не отреагировал на эту конкретную проблему."),
        }},
    "dialogue": {
        "name": "Управление диалогом, скорость и грамотность",
        "rule": "Шкала: 10 — ответы ясные и связные, если было явное ожидание — оператор предупредил; 7 — один заметный сбой, но клиент может понять и продолжить; 4 — клиенту приходится переспрашивать из-за формулировок или порядка ответов; 0 — из-за бессвязных или противоречивых реплик ход диалога непонятен.",
        "reqs": {
            "incoherent": ("-", "Реплики оператора бессвязные или противоречат друг другу так, что ход диалога непонятен."),
            "caused_reask": ("-", "Клиенту пришлось переспрашивать из-за неясной формулировки или порядка ответов оператора."),
            "glitch": ("-", "Один заметный сбой в общении: неточная, сбивающая с толку или не относящаяся к делу реплика оператора."),
            "no_wait_warning": ("-", "Было явное ожидание (оператор уходил проверять, долгая пауза в середине), а оператор не предупредил."),
        }},
    "closure": {
        "name": "Завершение",
        "rule": "Да — оператор подвёл итог или предложил дальнейшую помощь и попрощался. N/A — чат оборвался до возможности его завершить.",
        "na": "Чат оборвался (клиент ушёл, связь прервалась) до того, как оператор мог его завершить? Если чат заканчивается системным сообщением о том, что клиент покинул чат или связь прервалась, и оператор не успел попрощаться — na = true. «Оператор закрыл чат» — это не обрыв: na = false.",
        "reqs": {
            "summary_or_help": ("+", "В конце оператор подвёл итог по сути запроса (что сделано, что клиенту делать, что будет дальше) или прямо предложил ещё помощь вопросом («Могу ещё чем-то помочь?», «Есть ли ещё вопросы?»). НЕ считается: вежливость и благодарность — «пожалуйста», «рада помочь», «обращайтесь», «спасибо за обращение», «оқасы жоқ», «you're welcome», «glad to help», «thanks for reaching out», «glad you got in», «отлично», «жақсы». Если есть только такие фразы — ok = false."),
            "goodbye": ("+", "Оператор попрощался."),
        }},
    "critical": {
        "name": "Грубые ошибки",
        "rule": "Да — выявлено оскорбление клиента, предложение платной услуги в обход компании или раскрытие конфиденциальной информации. Нет — ни одно из трёх не выявлено.",
        "reqs": {
            "insult": ("-", "Оскорбление клиента."),
            "bypass_paid": ("-", "Предложение платной услуги в обход компании: просьба перевести деньги оператору лично или просьба личного номера клиента для платной частной консультации. Достаточно самого предложения."),
            "confidential": ("-", "Раскрытие конфиденциальной информации (данные счёта без подтверждённой личности, данные третьих лиц). Если в identification нарушение disclosed — это тоже раскрытие конфиденциальной информации: отметь и здесь."),
        }},
}

CONSULTATION_TEXT = """[consultation] Корректная и полная консультация
  N/A — только если чат закончился до того, как клиент сформулировал запрос (например, клиент покинул чат сразу после приветствия оператора, так и не сказав, что нужно). Тогда step = "0" и na = true.
  Выбери step по шкале:
  20 — все существенные вопросы закрыты или дан корректный следующий шаг;
  15 — основной вопрос решён, пропущена второстепенная деталь;
  10 — часть запроса закрыта, существенный вопрос остался открытым;
  5 — есть общая подсказка, но клиенту всё ещё непонятно, как действовать;
  0 — ответа по существу нет или ключевая рекомендация ошибочна.
  Консультация оценивает, правильно и полно ли решён запрос (не стиль общения).
  Перед step перечисли в open_questions вопросы клиента, оставшиеся без ответа ("" если таких нет)."""

SYSTEM = """Ты — специалист контроля качества брокерской компании Freedom Broker. Оцени ОПЕРАТОРА (OPERATOR) по официальному чек-листу. CLIENT, BOT, SYSTEM — контекст; системные сообщения можно использовать как доказательство (например, подтверждение личности, закрытие чата).

ПОРЯДОК: для каждого критерия сначала проверь требования (quote дословно, не больше 8 слов → turn → ok), потом na (если есть), потом rationale — одно предложение.

ПРАВИЛА ПРОВЕРОК:
- [+] — должно быть сделано. ok = true только если quote прямо показывает это действие. Иначе ok = false, quote = "".
- [−] — нарушение. Нашёл — ok = false и quote нарушения. Не нашёл — ok = true, quote = "", turn = 0.
- «Нет» — действие было нужно, но оператор его пропустил или выполнил неправильно. N/A — критерий неприменим по условию. Повод был, а действия нет — это не N/A.
- Не засчитывай чужое действие: реплика клиента или бота — не действие оператора.

Языки: русский, казахский, английский — правила одинаковые. Теги и вложения не оцениваются. Порог первой реакции оператора — 3 минуты (считается отдельно).

ЧЕК-ЛИСТ:
{checklist}

Ответ — только JSON по схеме."""


def checklist_text() -> str:
    out = []
    for cid in ORDER:
        if cid == "consultation":
            out.append("\n" + CONSULTATION_TEXT)
            continue
        c = CHECKLIST[cid]
        out.append(f"\n[{cid}] {c['name']}\n  Правило: {c['rule']}")
        if c.get("na"):
            out.append(f"  na: {c['na']}")
        for rid, r in c["reqs"].items():
            out.append(f"  - {rid} [{'+' if r[0] == '+' else '−'}]: {r[1]}")
    return "\n".join(out)


SYSTEM_PROMPT = SYSTEM.replace("{checklist}", checklist_text())


def response_schema() -> dict[str, Any]:
    check = {"type": "object", "properties": {"quote": {"type": "string"}, "turn": {"type": "integer"},
                                              "ok": {"type": "boolean"}}, "required": ["quote", "turn", "ok"]}
    props: dict[str, Any] = {}
    for cid in ORDER:
        if cid == "consultation":
            p: dict[str, Any] = {
                "evidence": {"type": "object", "properties": {"quote": {"type": "string"}, "turn": {"type": "integer"}},
                             "required": ["quote", "turn"]},
                "open_questions": {"type": "string"},
                "step": {"type": "string", "enum": ["0", "5", "10", "15", "20"]},
                "na": {"type": "boolean"}, "rationale": {"type": "string"}}
        else:
            c = CHECKLIST[cid]
            p = {"checks": {"type": "object", "properties": {rid: check for rid in c["reqs"]},
                            "required": list(c["reqs"])}}
            if c.get("na"):
                p["na"] = {"type": "boolean"}
            p["rationale"] = {"type": "string"}
        props[cid] = {"type": "object", "properties": p, "required": list(p)}
    return {"type": "object", "properties": props, "required": list(props)}


# ---- transcript -------------------------------------------------------------------------------------------


def _clock(timestamp: str) -> str:
    return timestamp[11:19] if "T" in timestamp else timestamp


def user_prompt(request: EvaluationRequest) -> str:
    conv = request.conversation
    lines = [f"[{i}] ({_clock(m.timestamp)}) {m.speaker.upper()}: {m.text}" for i, m in enumerate(conv.messages, 1)]
    language = EXPLANATION_LANGUAGE.get(request.rules.explanation_language, "русском")
    return (f"Канал: {conv.channel_raw}. Язык: {conv.language}.\n\nТРАНСКРИПТ:\n" + "\n".join(lines)
            + f"\n\nПиши rationale на {language} языке.")


def _norm(text: str) -> str:
    return re.sub(r"[^\w]+", " ", text.lower()).strip()


def locate(quote: str, messages: list[RequestMessage], prefer: tuple[str, ...] = ("operator",)) -> int | None:
    """1-based turn whose text contains the quote (fragments split on "..." must all occur, in order, in one turn).
    Preferred speakers are searched first. The model's own turn numbers are not trusted."""
    parts = [p for p in (_norm(x) for x in re.split(r"\.\.\.|…", quote)) if p]
    if not parts:
        return None

    def matches(text: str) -> bool:
        text, pos = _norm(text), 0
        for part in parts:
            pos = text.find(part, pos)
            if pos < 0:
                return False
            pos += len(part)
        return True

    hits = [i for i, m in enumerate(messages, 1) if matches(m.text)]
    for i in hits:
        if messages[i - 1].speaker in prefer:
            return i
    return hits[0] if hits else None


def first_response_delay(messages: list[RequestMessage]) -> float | None:
    """Seconds from the hand-over (the last system event before the operator joins) to the first operator reply."""
    start = None
    for m in messages:
        if m.offset_seconds is None:
            return None
        if m.speaker == "operator":
            return (m.offset_seconds - start) if start is not None else 0.0
        if m.speaker == "system":
            start = m.offset_seconds
    return None


# ---- from checks to values --------------------------------------------------------------------------------


def guarded_checks(cid: str, item: dict[str, Any], messages: list[RequestMessage]) -> tuple[dict, dict, list[str]]:
    """Verify one criterion's checks against the transcript. Returns ({rid: ok}, {rid: (turn, quote) counted},
    notes). A [+] counts only with a quote found in an allowed speaker's turn; a [−] violation needs a findable
    quote, otherwise it is ignored."""
    oks: dict[str, bool] = {}
    turns: dict[str, tuple[int, str]] = {}
    notes: list[str] = []
    for rid, r in CHECKLIST[cid]["reqs"].items():
        kind, speakers = r[0], (r[2] if len(r) > 2 else ("operator",))
        check = item["checks"][rid]
        ok, quote = bool(check["ok"]), str(check["quote"]).strip()
        if kind == "+":
            if ok and quote:
                turn = locate(quote, messages, speakers)
                if turn is None or messages[turn - 1].speaker not in speakers:
                    ok = False
                    notes.append(f"{rid}: quote not found in an allowed turn")
                else:
                    turns[rid] = (turn, quote)
            elif ok:
                ok = False  # claimed but not proven
        elif not ok:
            turn = locate(quote, messages) if quote else None
            if turn is None:
                ok = True
                notes.append(f"{rid}: violation without a findable quote ignored")
            else:
                turns[rid] = (turn, quote)
        oks[rid] = ok
    return oks, turns, notes


def derive(answer: dict[str, Any], messages: list[RequestMessage]) -> dict[str, dict[str, Any]]:
    """{criterion_id: {value, na, rationale, turns, notes}} for the eight official criteria."""
    out: dict[str, dict[str, Any]] = {}
    checks = {cid: guarded_checks(cid, answer[cid], messages) for cid in CHECKLIST}

    def yes_no(cid: str) -> bool | None:
        oks, reqs = checks[cid][0], CHECKLIST[cid]["reqs"]
        if not all(oks[r] for r, req in reqs.items() if req[0] == "-"):
            return False
        if all(oks[r] for r, req in reqs.items() if req[0] == "+"):
            return True
        return None if answer[cid].get("na") else False

    for cid in ("contact", "discovery", "identification", "empathy", "closure", "critical"):
        oks, turns, notes = checks[cid]
        value = yes_no(cid)
        if cid == "critical":  # a violation of any of the three types = critical error found
            value = not all(oks.values())
        out[cid] = {"value": value, "rationale": str(answer[cid].get("rationale", "")).strip(),
                    "quotes": sorted(set(turns.values())), "notes": notes}

    dialogue_oks, dialogue_turns, dialogue_notes = checks["dialogue"]
    delay = first_response_delay(messages)
    slow = delay is not None and delay > FIRST_RESPONSE_LIMIT_SEC
    if not dialogue_oks["incoherent"]:
        dialogue = 0
    elif not dialogue_oks["caused_reask"]:
        dialogue = 4
    elif not dialogue_oks["glitch"] or not dialogue_oks["no_wait_warning"] or slow:
        dialogue = 7
    else:
        dialogue = 10
    rationale = str(answer["dialogue"].get("rationale", "")).strip()
    if slow:
        rationale = (rationale + " " if rationale else "") + (
            f"Первый ответ оператора через {delay:.0f} с после передачи чата (порог — 180 с).")
    out["dialogue"] = {"value": dialogue, "rationale": rationale, "quotes": sorted(set(dialogue_turns.values())),
                       "notes": dialogue_notes, "first_response_seconds": delay}

    cons = answer["consultation"]
    evidence_quote = str(cons.get("evidence", {}).get("quote", "")).strip()
    turn = locate(evidence_quote, messages) if evidence_quote else None
    out["consultation"] = {"value": None if cons.get("na") else int(cons["step"]),
                           "rationale": str(cons.get("rationale", "")).strip(),
                           "quotes": [(turn, evidence_quote)] if turn else [],
                           "notes": [], "open_questions": str(cons.get("open_questions", "")).strip()}
    return out


# ---- the adapter ------------------------------------------------------------------------------------------


@register_adapter("qwen")
class QwenEvaluator(EvaluatorAdapter):
    label = "Qwen (v5 checklist evaluator)"
    description = ("Evaluates the eight official criteria with Qwen through Ollama: quoted checks, code-derived "
                   "values (ATLAS_CQA_QWEN_MODEL).")
    provider = "qwen"
    supports_reassessment = False  # appeals are reassessed by GPT

    @property
    def version(self) -> str:  # type: ignore[override]
        return self.settings.cqa_qwen_model

    def availability(self) -> tuple[bool, str]:
        if not self.settings.cqa_qwen_model.strip():
            return False, "ATLAS_CQA_QWEN_MODEL is empty."
        parts = urlsplit(self.settings.cqa_qwen_base_url)
        if not parts.hostname or (parts.scheme != "https" and not is_loopback(parts.hostname)):
            return False, "ATLAS_CQA_QWEN_BASE_URL must be a loopback (local) or https URL."
        return True, ""

    def _generate(self, request: EvaluationRequest) -> tuple[dict[str, Any], dict[str, Any]]:
        body = {"model": self.settings.cqa_qwen_model, "system": SYSTEM_PROMPT, "prompt": user_prompt(request),
                "stream": False, "format": response_schema(), "think": False,
                "options": {"temperature": 0, "num_ctx": self.settings.cqa_qwen_num_ctx}}
        url = self.settings.cqa_qwen_base_url.rstrip("/") + "/api/generate"
        http = urllib.request.Request(url, data=json.dumps(body).encode(),
                                      headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(http, timeout=self.settings.cqa_qwen_timeout_s) as response:
                envelope = json.load(response)
        except urllib.error.HTTPError as error:
            raise EvaluatorError(f"Ollama answered HTTP {error.code}.", code="evaluator_http_error") from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            reason = getattr(error, "reason", error)
            raise EvaluatorError(f"Could not reach Ollama at {self.settings.cqa_qwen_base_url}: {reason}.",
                                 code="evaluator_unreachable") from None
        except ValueError:
            raise EvaluatorError("Ollama returned a body that is not JSON.", code="invalid_model_answer") from None
        try:
            answer = json.loads(envelope.get("response", ""))
            for cid in ORDER:
                answer[cid]["rationale"]  # noqa: B018 — shape check
        except (ValueError, KeyError, TypeError):
            raise EvaluatorError("Qwen's answer does not follow the response schema.", code="invalid_model_answer",
                                 raw={"response": str(envelope.get("response", ""))[:20000]}) from None
        return answer, envelope

    def evaluate(self, request: EvaluationRequest) -> dict[str, Any]:
        ready, reason = self.availability()
        if not ready:
            raise EvaluatorError(reason, code="evaluator_not_configured")
        wanted = [c.id for c in request.checklist.criteria]
        unknown = [cid for cid in wanted if cid not in ORDER]
        if unknown:
            raise EvaluatorError(f"Qwen evaluates only the official criteria; not {', '.join(unknown)}.",
                                 code="unsupported_criteria")
        messages = request.conversation.messages
        if not messages:
            raise EvaluatorError("The conversation has no messages.", code="empty_conversation")
        answer, envelope = self._generate(request)
        derived = derive(answer, messages)
        results = [self._result(cid, derived[cid], messages) for cid in wanted]
        return {
            "contract_version": CONTRACT_VERSION, "evaluation_id": request.evaluation_id,
            "conversation_id": request.conversation.conversation_id,
            "checklist_id": request.checklist.checklist_id, "checklist_version": request.checklist.version,
            "model": {"name": envelope.get("model") or self.settings.cqa_qwen_model, "version": "v5"},
            "results": results,
            "meta": {"answer": answer, "eval_count": envelope.get("eval_count"),
                     "prompt_eval_count": envelope.get("prompt_eval_count"),
                     "total_duration_s": round((envelope.get("total_duration") or 0) / 1e9, 2),
                     "notes": {cid: d["notes"] for cid, d in derived.items() if d["notes"]},
                     "first_response_seconds": derived["dialogue"].get("first_response_seconds")},
        }

    @staticmethod
    def _anchor(cid: str, messages: list[RequestMessage]) -> list[int]:
        """Where an expected action was looked for when no quote supports the value (1-based turns)."""
        operator = [i for i, m in enumerate(messages, 1) if m.speaker == "operator"]
        if not operator:
            return [len(messages)]
        if cid == "contact":
            return [operator[0]]
        if cid == "closure":
            return [operator[-1]] if messages[-1].speaker == "operator" else [operator[-1], len(messages)]
        return [operator[0], operator[-1]] if len(operator) > 1 else operator

    def _result(self, cid: str, item: dict[str, Any], messages: list[RequestMessage]) -> dict[str, Any]:
        value = item["value"]
        rationale = item["rationale"] or ("Критерий неприменим." if value is None else "Оценка по проверкам чек-листа.")
        evidence = []
        for turn, quote in item["quotes"][:20]:
            ref: dict[str, Any] = {"message_id": messages[turn - 1].id}
            if locate_quote(messages[turn - 1].text, quote) is not None:
                ref["quote"] = quote  # highlighted in the UI; the backend re-checks it
            evidence.append(ref)
        if not evidence:  # a missing action: cite where it was expected
            evidence = [{"message_id": messages[turn - 1].id} for turn in self._anchor(cid, messages)]
        result: dict[str, Any] = {"criterion_id": cid, "value": value, "is_na": value is None,
                                  "na_reason": rationale if value is None else None, "explanation": rationale,
                                  "evidence": evidence}
        return result
