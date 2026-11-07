"""GPT evaluation through the OpenAI adapter, end to end through the HTTP API.

The OpenAI endpoint is replaced by a fake ``urlopen`` (no network, no paid calls); everything else is the real code
path: prompt built from the saved checklist version, strict validation, retry with feedback, the deterministic
scoring engine, and persistence. All data is synthetic.
"""

from __future__ import annotations

import io
import json
import urllib.error
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import REPO_ROOT, Settings
from app.cqa.adapters import openai_gpt
from app.cqa.checklists import OFFICIAL_CHECKLIST_ID
from app.cqa.scoring import compute_score
from app.main import create_app
from tests.cqa_helpers import API, answer, chat_record, config, criterion, na, organizer_payload, wait_batch

# client, bot, system, operator, client: the operator's line is turn 4 of the original transcript.
CONVERSATION = "gpt-ru-001"
FAKE_KEY = "sk-test-0123456789abcdef"


class _Response:
    def __init__(self, body: bytes) -> None:
        self._body = io.BytesIO(body)

    def read(self, size: int = -1) -> bytes:
        return self._body.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        return None


class FakeOpenAI:
    """Stands in for urllib.request.urlopen: records each request, replays the queued answers in order."""

    def __init__(self, *answers) -> None:
        self.answers = list(answers)
        self.bodies: list[dict] = []
        self.headers: list[dict] = []
        self.urls: list[str] = []

    def __call__(self, request, timeout=None):
        self.urls.append(request.full_url)
        self.bodies.append(json.loads(request.data))
        self.headers.append(dict(request.header_items()))
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        content = answer if isinstance(answer, str) else json.dumps(answer, ensure_ascii=False)
        return _Response(json.dumps({
            "id": f"chatcmpl-{len(self.bodies)}", "model": "gpt-test-2026-01-01",
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
            "usage": {"prompt_tokens": 900, "completion_tokens": 300, "total_tokens": 1200},
        }).encode())

    def prompt(self, index: int = -1) -> dict:
        """The JSON document GPT received in the user message of request ``index``."""
        user = self.bodies[index]["messages"][1]["content"]
        return json.loads(user.split("<data>\n", 1)[1].rsplit("\n</data>", 1)[0])


@pytest.fixture
def client(tmp_path: Path):
    settings = Settings(data_dir=tmp_path / "workspaces", samples_dir=REPO_ROOT / "data" / "samples",
                        allowed_hosts=["testserver"], cqa_evaluator="openai", cqa_openai_api_key=FAKE_KEY,
                        cqa_openai_model="gpt-test")
    with TestClient(create_app(settings)) as test_client:
        test_client.app.state.cqa.adapters["openai"].retry_delay_s = 0
        response = test_client.post(f"{API}/imports/json", json=organizer_payload([chat_record(CONVERSATION)]))
        assert response.status_code == 201, response.text
        yield test_client


def fake(monkeypatch, *answers) -> FakeOpenAI:
    gpt = FakeOpenAI(*answers)
    monkeypatch.setattr(openai_gpt.urllib.request, "urlopen", gpt)
    return gpt


def run(client: TestClient, checklist_id: str, version: int | None = None, **extra) -> dict:
    body = {"checklist_id": checklist_id, "conversation_ids": [CONVERSATION], **extra}
    if version:
        body["checklist_version"] = version
    queued = client.post(f"{API}/evaluations", json=body)
    assert queued.status_code == 202, queued.text
    wait_batch(client, queued.json()["batch_id"])
    return client.get(f"{API}/evaluations/{queued.json()['evaluations'][0]['id']}").json()


def item(cid, value, rationale="Оператор поздоровался.", turns=(4,), **extra) -> dict:
    return {"criterion_id": cid, "value": value, "rationale": rationale, "evidence_turns": list(turns), **extra}


OFFICIAL_ANSWER = {"criteria": [
    item("contact", True), item("discovery", None, "Клиент сам назвал вопрос.", turns=()),
    item("identification", True), item("consultation", 15), item("empathy", False),
    item("dialogue", 7), item("closure", True), item("critical", True),
]}


def custom_checklist(client: TestClient, wording: str, scores: list[int]) -> dict:
    body = {"name": "Manager checklist", "config": {"criteria": [
        {"id": "professionalism", "name": "Professionalism", "weight": 40, "answer_type": "numeric",
         "allowed_scores": scores, "description": wording},
        {"id": "greeting", "name": "Greeting", "weight": 60, "description": "The operator greets the client."},
        {"id": "legacy", "name": "Legacy", "weight": 10, "enabled": False},
    ], "scoring": {"rounding": {"mode": "half_up", "digits": 2}}}}
    response = client.post(f"{API}/checklists", json=body)
    assert response.status_code == 201, response.text
    return response.json()


# ---- the official checklist ------------------------------------------------------------------------------


def test_official_checklist_is_evaluated_validated_scored_as_percent_and_persisted(client, monkeypatch):
    gpt = fake(monkeypatch, OFFICIAL_ANSWER)
    detail = run(client, OFFICIAL_CHECKLIST_ID)
    record = detail["evaluation"]
    assert record["status"] == "completed", record["error"]

    # The request: real endpoint shape, key only in the header, strict schema built from the 8 saved criteria.
    body = gpt.bodies[0]
    assert gpt.urls[0] == "https://api.openai.com/v1/chat/completions"
    assert gpt.headers[0]["Authorization"] == f"Bearer {FAKE_KEY}"
    assert FAKE_KEY not in json.dumps(body)
    assert body["model"] == "gpt-test" and body["response_format"]["json_schema"]["strict"] is True
    official = ["contact", "discovery", "identification", "consultation", "empathy", "dialogue", "closure", "critical"]
    schema_item = body["response_format"]["json_schema"]["schema"]["properties"]["criteria"]["items"]
    assert schema_item["properties"]["criterion_id"]["enum"] == official
    prompt = gpt.prompt()
    assert [c["criterion_id"] for c in prompt["criteria"]] == official
    assert prompt["criteria"][3]["allowed_values"] == [0, 5, 10, 15, 20, None]  # consultation, N/A allowed
    assert prompt["criteria"][5]["allowed_values"] == [0, 4, 7, 10]  # dialogue, N/A not allowed
    turns = prompt["conversation"]["turns"]
    assert [t["turn"] for t in turns] == [1, 2, 3, 4, 5]
    assert [t["speaker"] for t in turns] == ["client", "bot", "system", "operator", "client"]
    assert turns[3]["text"] == "Добрый день! Меня зовут Ая. Чем помочь?"  # original text, not translated

    # Scoring by the backend: N/A excluded and redistributed, numeric = value / max, critical does not zero.
    # applicable weight 85; earned 10 + 20 + 15 + 0 + 10.5 + 5 = 60.5 → 100 × 60.5 / 85 = 71.18
    score = record["final_score"]
    assert score["percent"] == 71.18 and score["total"] == 71.18
    assert score["severe_errors"] == ["critical"]
    views = {v["criterion"]["id"]: v for v in detail["criteria"]}
    assert views["discovery"]["original"]["is_na"] and views["discovery"]["final_score"]["status"] == "na"
    assert views["consultation"]["final_score"]["normalized"] == 0.75

    # Evidence turn 4 is the 4th line of the original transcript (the operator), not the 1st operator line.
    evidence = views["contact"]["original"]["evidence"][0]
    assert evidence["message_id"] == "m4" and evidence["message_index"] == 3 and evidence["speaker"] == "operator"
    assert views["contact"]["original"]["explanation"] == "Оператор поздоровался."

    # Persisted with the actual model, the checklist snapshot and the model's own answer.
    assert record["model_info"]["name"] == "gpt-test-2026-01-01" and record["evaluator"]["version"] == "gpt-test"
    assert record["checklist_version"] == 1 and len(record["checklist"]["criteria"]) == 8
    assert record["raw_output"]["meta"]["model_answer"] == OFFICIAL_ANSWER
    brief = client.get(f"{API}/conversations/{CONVERSATION}").json()["evaluations"][0]
    assert brief["final_percent"] == 71.18 and brief["severe_errors"] == 1 and not brief["is_mock"]


# ---- custom and edited criteria --------------------------------------------------------------------------


def test_custom_criteria_and_later_edits_reach_gpt_without_code_changes(client, monkeypatch):
    checklist = custom_checklist(client, "Evaluate whether the operator stays professional.", [0, 5, 10])
    gpt = fake(monkeypatch,
               {"criteria": [item("professionalism", 5), item("greeting", True)]},
               {"criteria": [item("professionalism", 6), item("greeting", True)]})
    first = run(client, checklist["id"])
    assert first["evaluation"]["final_score"]["percent"] == 80.0  # 5/10 × 40 + 60
    criteria = {c["criterion_id"]: c for c in gpt.prompt(0)["criteria"]}
    assert set(criteria) == {"professionalism", "greeting"}  # the disabled criterion is not asked for
    assert criteria["professionalism"]["wording"] == "Evaluate whether the operator stays professional."
    assert criteria["professionalism"]["allowed_values"] == [0, 5, 10]

    # The manager edits the wording and the scale: version 2, evaluated with the new configuration.
    config_v2 = checklist["versions"][0]["config"]
    config_v2["criteria"][0].update(description="Professional and respectful tone throughout.",
                                    allowed_scores=[0, 2, 4, 6, 8, 10])
    saved = client.put(f"{API}/checklists/{checklist['id']}", json={"base_version": 1, "config": config_v2})
    assert saved.status_code == 200, saved.text
    second = run(client, checklist["id"], 2)
    criteria = {c["criterion_id"]: c for c in gpt.prompt(1)["criteria"]}
    assert criteria["professionalism"]["wording"] == "Professional and respectful tone throughout."
    assert criteria["professionalism"]["allowed_values"] == [0, 2, 4, 6, 8, 10]
    assert second["evaluation"]["final_score"]["percent"] == 84.0  # 6/10 × 40 + 60
    # History: the version-1 evaluation is unchanged.
    again = client.get(f"{API}/evaluations/{first['evaluation']['id']}").json()["evaluation"]
    assert again["checklist_version"] == 1 and again["final_score"]["percent"] == 80.0


# ---- invalid answers and API failures -------------------------------------------------------------------


def test_invalid_answer_is_sent_back_once_and_a_corrected_answer_is_accepted(client, monkeypatch):
    checklist = custom_checklist(client, "Professional tone.", [0, 5, 10])
    gpt = fake(monkeypatch,
               {"criteria": [item("professionalism", 7, turns=(99,))]},  # not allowed, bad turn, greeting missing
               {"criteria": [item("professionalism", 10), item("greeting", False)]})
    record = run(client, checklist["id"])["evaluation"]
    assert record["status"] == "completed" and record["final_score"]["percent"] == 40.0
    feedback = gpt.bodies[1]["messages"][-1]["content"]
    assert "7 is not an allowed score" in feedback and "[99] do not exist" in feedback
    assert "Missing criteria: greeting" in feedback
    assert record["raw_output"]["meta"]["attempts"] == 2


def test_answers_that_stay_invalid_fail_the_evaluation_without_a_score(client, monkeypatch):
    checklist = custom_checklist(client, "Professional tone.", [0, 5, 10])
    bad = {"criteria": [item("professionalism", None), item("greeting", "yes"), item("ghost", True)]}
    gpt = fake(monkeypatch, bad, bad)
    record = run(client, checklist["id"])["evaluation"]
    assert len(gpt.bodies) == 2  # limited retry, no loop
    assert record["status"] == "failed" and record["error"]["code"] == "invalid_model_answer"
    issues = " ".join(record["error"]["issues"])
    assert "null (N/A) is not allowed" in issues and "needs true or false" in issues and "unknown criterion" in issues
    assert record["final_score"] is None and record["original_results"] == []
    assert record["conversation_id"] == CONVERSATION and record["raw_output"]["model_answer"] == bad
    brief = client.get(f"{API}/conversations/{CONVERSATION}").json()["evaluations"][0]
    assert brief["status"] == "failed" and brief["final_percent"] is None  # never shown as 0 %


def test_api_errors_fail_with_a_reason_and_never_echo_the_key(client, monkeypatch):
    body = json.dumps({"error": {"message": f"Incorrect API key provided: {FAKE_KEY}", "code": "invalid_api_key"}})
    denied = urllib.error.HTTPError("https://api.openai.com/v1/chat/completions", 401, "Unauthorized", {},
                                    io.BytesIO(body.encode()))
    fake(monkeypatch, denied)
    record = run(client, OFFICIAL_CHECKLIST_ID)["evaluation"]
    assert record["status"] == "failed" and record["error"]["code"] == "evaluator_auth_failed"
    assert FAKE_KEY not in json.dumps(record)


def test_without_a_key_evaluation_is_refused_up_front(client, monkeypatch):
    adapter = client.app.state.cqa.adapters["openai"]
    monkeypatch.setattr(adapter.settings, "cqa_openai_api_key", None)
    response = client.post(f"{API}/evaluations", json={"checklist_id": OFFICIAL_CHECKLIST_ID,
                                                       "conversation_ids": [CONVERSATION]})
    assert response.status_code == 422 and response.json()["error"]["code"] == "evaluator_unavailable"
    assert "OpenAI API key" in response.json()["error"]["message"]


# ---- percentage scoring (the spec's example) ---------------------------------------------------------------


def test_na_weight_is_redistributed_into_a_percentage():
    checklist = config(criterion("a", 40), criterion("b", 30, answer_type="numeric", allowed_scores=[0, 5, 10]),
                       criterion("c", 30, na_allowed=True), rounding={"mode": "half_up", "digits": 2})
    score = compute_score(checklist, [answer("a", True), answer("b", 5), na("c")])
    assert score.percent == 78.57 and score.applicable_weight == 70  # 100 × 55 / 70, not 55
