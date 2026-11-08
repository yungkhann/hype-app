"""Qwen evaluator (app/cqa/adapters/qwen.py): mode 1 sends the unchanged official criteria to Qwen through Ollama's
native API, and code derives every value from Qwen's quoted checks.

Ollama is a fake ``urlopen`` (no network) that replays a recorded Qwen answer for a synthetic DEV-style chat.
Everything else is the real path: routing, contract validation, the scoring engine.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import REPO_ROOT, Settings
from app.cqa.adapters import qwen
from app.cqa.checklists import OFFICIAL_CHECKLIST_ID
from app.main import create_app
from tests.cqa_helpers import API, chat_record, organizer_payload, wait_batch
from tests.test_cqa_openai import FAKE_KEY, _Response

CHAT = "qw-ru-001"
LINES = [
    ("00:00", "client", "Где посмотреть мой тариф? В приложении не нахожу."),
    ("00:02", "bot", "Здравствуйте! Я AIM, AI-ассистент Freedom Broker."),
    ("00:03", "bot", "Продолжая разговор, Вы соглашаетесь на обработку персональных данных."),
    ("00:08", "bot", "Тариф указан на первой странице отчёта брокера."),
    ("00:28", "client", "Я сейчас с ноутбука, отчёт качать не хочу. Можно оператора?"),
    ("00:30", "bot", "Желаете, чтобы я соединил Вас с оператором?"),
    ("00:35", "client", "да"),
    ("00:36", "bot", "Пожалуйста, ожидайте. Оператор скоро подключится к чату."),
    ("00:38", "system", "Эскалация на оператора."),
    ("01:15", "operator", "Здравствуйте! Меня зовут Алина. В веб-версии откройте вкладку «Кабинет». "
                          "Название тарифа будет под вашим ФИО."),
    ("01:28", "client", "Нашла, спасибо."),
    ("02:04", "operator", "Пожалуйста. Хорошего вечера!"),
]
ANSWER = json.loads(  # a recorded Qwen answer, verbatim
    '{"contact": {"checks": {"greeting": {"quote": "Здравствуйте!", "turn": 10, "ok": true}, "introduced": {"quote": "Меня зовут Алина", "turn": 10, "ok": true}}, "rationale": "Оператор поздоровался и представился в первом ответе."}, "discovery": {"checks": {"clarified": {"quote": "", "turn": 0, "ok": true}, "reask": {"quote": "", "turn": 0, "ok": true}, "answered_blind": {"quote": "", "turn": 0, "ok": true}}, "na": true, "rationale": "Клиент уже указал, что использует веб-версию (ноутбук), и оператор дал точный ответ без дополнительных уточнений."}, "identification": {"checks": {"confirmed": {"quote": "", "turn": 0, "ok": true}, "disclosed": {"quote": "", "turn": 0, "ok": true}}, "na": true, "rationale": "Запрос касался навигации по интерфейсу, раскрытие персональных данных счёта не требовалось."}, "consultation": {"evidence": {"quote": "В веб-версии откройте вкладку «Кабинет». Название тарифа будет под вашим ФИО.", "turn": 10}, "open_questions": "", "step": "20", "na": false, "rationale": "Оператор дал четкую инструкцию, которая полностью решила проблему клиента."}, "empathy": {"checks": {"impolite": {"quote": "", "turn": 0, "ok": true}, "ignored_problem": {"quote": "", "turn": 0, "ok": true}}, "rationale": "Оператор был вежлив и оперативно решил проблему клиента."}, "dialogue": {"checks": {"incoherent": {"quote": "", "turn": 0, "ok": true}, "caused_reask": {"quote": "", "turn": 0, "ok": true}, "glitch": {"quote": "", "turn": 0, "ok": true}, "no_wait_warning": {"quote": "", "turn": 0, "ok": true}}, "rationale": "Диалог был ясным, связным и без задержек, требующих предупреждения."}, "closure": {"checks": {"summary_or_help": {"quote": "", "turn": 0, "ok": false}, "goodbye": {"quote": "Хорошего вечера!", "turn": 12, "ok": true}}, "na": false, "rationale": "Оператор попрощался, но не предложил дальнейшую помощь или не подвел итог в требуемом формате (использовал только вежливую фразу)."}, "critical": {"checks": {"insult": {"quote": "", "turn": 0, "ok": true}, "bypass_paid": {"quote": "", "turn": 0, "ok": true}, "confidential": {"quote": "", "turn": 0, "ok": true}}, "rationale": "Грубых ошибок, оскорблений или нарушений конфиденциальности не выявлено."}}')  # noqa: E501


class Ollama:
    """Replays queued Qwen answers in Ollama's /api/generate envelope."""

    def __init__(self) -> None:
        self.answers: list = []
        self.calls: list[dict] = []

    def __call__(self, request, timeout=None):
        body = json.loads(request.data)
        self.calls.append({"url": request.full_url, "body": body})
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return _Response(json.dumps({"model": body["model"], "response": json.dumps(answer, ensure_ascii=False),
                                     "done": True, "eval_count": 1000, "total_duration": 10_000_000_000}).encode())


def make_client(tmp_path: Path, lines=LINES) -> TestClient:
    settings = Settings(data_dir=tmp_path / "workspaces", samples_dir=REPO_ROOT / "data" / "samples",
                        allowed_hosts=["testserver"], cqa_evaluator="openai", cqa_openai_api_key=FAKE_KEY,
                        cqa_qwen_model="qwen-test")  # default mode 1, Qwen as the local model
    client = TestClient(create_app(settings))
    client.__enter__()
    assert client.post(f"{API}/imports/json",
                       json=organizer_payload([chat_record(CHAT, lines=lines)])).status_code == 201
    return client


@pytest.fixture
def ollama(monkeypatch) -> Ollama:
    fake = Ollama()
    monkeypatch.setattr(qwen.urllib.request, "urlopen", fake)
    return fake


def evaluate(client) -> dict:
    queued = client.post(f"{API}/evaluations", json={"checklist_id": OFFICIAL_CHECKLIST_ID,
                                                     "conversation_ids": [CHAT]})
    assert queued.status_code == 202, queued.text
    wait_batch(client, queued.json()["batch_id"])
    return client.get(f"{API}/evaluations/{queued.json()['evaluations'][0]['id']}").json()["evaluation"]


def values(evaluation: dict) -> dict:
    return {r["criterion_id"]: r["value"] for r in evaluation["original_results"]}


def test_mode_1_sends_the_official_eight_to_qwen_and_derives_values_from_checks(tmp_path, ollama):
    client = make_client(tmp_path)
    ollama.answers.append(ANSWER)
    evaluation = evaluate(client)
    assert evaluation["status"] == "completed", evaluation.get("error")
    assert len(ollama.calls) == 1  # GPT is never called for the unchanged official checklist
    call = ollama.calls[0]
    assert call["url"] == "http://localhost:11434/api/generate"
    assert call["body"]["model"] == "qwen-test" and call["body"]["think"] is False
    assert call["body"]["format"]["required"] == qwen.ORDER
    assert "[10] (01:15) OPERATOR: Здравствуйте! Меня зовут Алина." in call["body"]["prompt"]
    assert [p["provider"] for p in evaluation["parts"]] == ["qwen"]
    # discovery.clarified is ok=true with an empty quote: not proven, so the model's na decides (N/A)
    assert values(evaluation) == {"contact": True, "discovery": None, "identification": None, "consultation": 20,
                                  "empathy": True, "dialogue": 10, "closure": False, "critical": False}
    assert evaluation["original_score"]["percent"] == 92.31
    by_id = {r["criterion_id"]: r for r in evaluation["original_results"]}
    assert {e["message_id"] for e in by_id["contact"]["evidence"]} == {"m10"}  # greeting and name: two quotes
    assert by_id["closure"]["evidence"][0]["message_id"] == "m12"
    assert by_id["discovery"]["is_na"] and by_id["discovery"]["na_reason"]


def test_a_quoted_violation_beats_na_and_an_unfindable_quote_is_ignored(tmp_path, ollama):
    client = make_client(tmp_path)
    answer = copy.deepcopy(ANSWER)
    answer["empathy"]["checks"]["impolite"] = {"quote": "Хорошего вечера", "turn": 12, "ok": False}
    answer["critical"]["checks"]["insult"] = {"quote": "этой фразы нет в чате", "turn": 3, "ok": False}
    ollama.answers.append(answer)
    result = values(evaluate(client))
    assert result["empathy"] is False and result["critical"] is False


def test_a_first_reply_after_three_minutes_caps_dialogue_at_7(tmp_path, ollama):
    slow = [line if line[0] != "01:15" else ("03:50", line[1], line[2]) for line in LINES]
    client = make_client(tmp_path, slow)
    ollama.answers.append(ANSWER)
    evaluation = evaluate(client)
    by_id = {r["criterion_id"]: r for r in evaluation["original_results"]}
    assert by_id["dialogue"]["value"] == 7 and "192 с" in by_id["dialogue"]["explanation"]


def test_an_unreachable_ollama_fails_the_evaluation_with_a_reason(tmp_path, ollama):
    client = make_client(tmp_path)
    ollama.answers.append(qwen.urllib.error.URLError("Connection refused"))
    evaluation = evaluate(client)
    assert evaluation["status"] == "failed"
    assert evaluation["error"]["code"] == "evaluator_unreachable"
    assert "Connection refused" in evaluation["error"]["message"]
