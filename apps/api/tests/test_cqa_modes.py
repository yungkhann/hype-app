"""Evaluation modes: mode 1 (Gemma for unchanged official criteria, GPT for the rest) and mode 2 (GPT only).

Both providers are a fake ``urlopen`` (no network, no paid calls) that echoes the requested model, so every request
can be attributed: Gemma goes to the local Ollama URL, GPT to the OpenAI URL. Everything else is the real path:
routing, per-provider validation, merging, the scoring engine, appeals and the JSON 1.0 export. Synthetic data.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import REPO_ROOT, Settings
from app.cqa import routing
from app.cqa.adapters import openai_gpt
from app.cqa.checklists import OFFICIAL_CHECKLIST_ID
from app.main import create_app
from tests.cqa_helpers import API, chat_record, organizer_payload, wait_batch
from tests.test_cqa_appeals import decide, recommend, settled, submit
from tests.test_cqa_openai import CONVERSATION, FAKE_KEY, _Response, item

GEMMA_URL = "http://localhost:11434/v1/chat/completions"
GPT_URL = "https://api.openai.com/v1/chat/completions"


class Models:
    """Replays queued answers; the response names the requested model + '-reported'."""

    def __init__(self) -> None:
        self.answers: list = []
        self.calls: list[dict] = []

    def __call__(self, request, timeout=None):
        body = json.loads(request.data)
        self.calls.append({"url": request.full_url, "body": body, "headers": dict(request.header_items())})
        answer = self.answers.pop(0)
        return _Response(json.dumps({
            "id": f"r{len(self.calls)}", "model": f"{body['model']}-reported",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": json.dumps(answer, ensure_ascii=False)}}],
            "usage": {}}).encode())

    def criteria(self, index: int) -> list[str]:
        user = self.calls[index]["body"]["messages"][1]["content"]
        prompt = json.loads(user.split("<data>\n", 1)[1].rsplit("\n</data>", 1)[0])
        return [c["criterion_id"] for c in prompt["criteria"]]


@pytest.fixture
def client(tmp_path: Path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "workspaces", samples_dir=REPO_ROOT / "data" / "samples",
                        allowed_hosts=["testserver"], cqa_evaluator="openai", cqa_openai_api_key=FAKE_KEY,
                        cqa_openai_model="gpt-test", cqa_gemma_model="gemma-test",
                        cqa_local_evaluator="gemma")  # default mode: 1, Gemma as the local model
    with TestClient(create_app(settings)) as test_client:
        for name in ("openai", "gemma"):
            test_client.app.state.cqa.adapters[name].retry_delay_s = 0
        assert test_client.post(f"{API}/imports/json",
                                json=organizer_payload([chat_record(CONVERSATION)])).status_code == 201
        yield test_client


@pytest.fixture
def models(monkeypatch) -> Models:
    fake = Models()
    monkeypatch.setattr(openai_gpt.urllib.request, "urlopen", fake)
    return fake


def official_config(client) -> dict:
    return copy.deepcopy(client.get(f"{API}/checklists/{OFFICIAL_CHECKLIST_ID}").json()["versions"][0]["config"])


def create(client, config, name="Manager checklist") -> dict:
    response = client.post(f"{API}/checklists", json={"name": name, "config": config})
    assert response.status_code == 201, response.text
    return response.json()


def evaluate(client, checklist_id, **extra) -> dict:
    queued = client.post(f"{API}/evaluations", json={"checklist_id": checklist_id,
                                                     "conversation_ids": [CONVERSATION], **extra})
    assert queued.status_code == 202, queued.text
    wait_batch(client, queued.json()["batch_id"])
    return client.get(f"{API}/evaluations/{queued.json()['evaluations'][0]['id']}").json()["evaluation"]


def mixed_checklist(client) -> dict:
    """The official eight, with empathy's wording edited, contact re-weighted, plus one custom criterion."""
    config = official_config(client)
    by_id = {c["id"]: c for c in config["criteria"]}
    by_id["contact"]["weight"] = 5  # weight is not part of the definition: still Gemma
    by_id["empathy"]["description"] = "Edited by the manager: the operator acknowledges the client's feelings."
    config["criteria"].append({"id": "farewell_name", "name": "Says goodbye by name", "weight": 5,
                               "answer_type": "binary", "description": "Custom criterion."})
    return create(client, config)


GEMMA_ANSWER = {"criteria": [item("contact", True), item("discovery", None, "Клиент сам назвал вопрос.", turns=()),
                             item("identification", True), item("consultation", 15, turns=(4, 5)),
                             item("dialogue", 7), item("closure", True), item("critical", False)]}
GPT_ANSWER = {"criteria": [item("empathy", False, "Нет признания чувств клиента."), item("farewell_name", True)]}


def test_routing_compares_the_definition_not_the_id():
    official = {c.id: c for c in routing.checklist_templates()[routing.OFFICIAL_TEMPLATE_ID].config.criteria}
    assert all(routing.matches_official(c) for c in official.values())
    consultation = official["consultation"]
    assert routing.matches_official(consultation.model_copy(update={"weight": 25}))  # weighting only
    assert routing.matches_official(consultation.model_copy(update={"name": "  Корректная  и полная консультация "}))
    assert not routing.matches_official(consultation.model_copy(update={"allowed_scores": [0, 10, 20]}))
    assert not routing.matches_official(consultation.model_copy(update={"na_allowed": False}))
    assert not routing.matches_official(official["empathy"].model_copy(update={"description": "New wording."}))
    assert not routing.matches_official(official["empathy"].model_copy(update={"id": "empathy_v2"}))


def test_mode_1_splits_criteria_merges_one_evaluation_and_mode_2_keeps_history(client, models):
    checklist = mixed_checklist(client)
    models.answers += [GEMMA_ANSWER, GPT_ANSWER]
    hybrid = evaluate(client, checklist["id"])  # no mode_type: the default, mode 1
    assert hybrid["status"] == "completed", hybrid["error"]
    assert hybrid["mode_type"] == 1 and hybrid["evaluator"]["name"] == "hybrid"

    # Gemma got the seven unchanged official criteria (contact re-weighted only), locally and without a key;
    # GPT got the edited empathy and the custom criterion.
    gemma, gpt = models.calls
    assert gemma["url"] == GEMMA_URL and gemma["body"]["model"] == "gemma-test"
    assert "Authorization" not in gemma["headers"]
    assert models.criteria(0) == ["contact", "discovery", "identification", "consultation", "dialogue", "closure",
                                  "critical"]
    assert gpt["url"] == GPT_URL and gpt["body"]["model"] == "gpt-test"
    assert models.criteria(1) == ["empathy", "farewell_name"]
    assert [p["provider"] for p in hybrid["parts"]] == ["gemma", "openai"]
    assert hybrid["parts"][0]["official_baseline"] and not hybrid["parts"][1]["official_baseline"]

    # One merged result per criterion, in checklist order, with its provider; one score from the engine:
    # applicable 85 (discovery N/A); 5 + 20 + 15 + 0 + 10.5 + 5 + 5 = 60.5 → 71.18.
    results = hybrid["original_results"]
    assert [r["criterion_id"] for r in results] == [c["id"] for c in checklist["versions"][0]["config"]["criteria"]]
    provider = {r["criterion_id"]: (r["provider"], r["model"]) for r in results}
    assert provider["contact"] == ("gemma", "gemma-test-reported")
    assert provider["empathy"] == provider["farewell_name"] == ("openai", "gpt-test-reported")
    assert hybrid["final_score"]["percent"] == 71.18
    consultation = next(r for r in results if r["criterion_id"] == "consultation")
    assert consultation["value"] == 15 and [e["message_index"] + 1 for e in consultation["evidence"]] == [4, 5]
    assert next(r for r in results if r["criterion_id"] == "discovery")["is_na"]
    stored = json.dumps(client.get(f"{API}/evaluations/{hybrid['id']}").json()["evaluation"], sort_keys=True)

    # Mode 2: one GPT call for all nine criteria, Gemma never called, a new record; the mode 1 record is untouched.
    models.answers.append({"criteria": GEMMA_ANSWER["criteria"] + GPT_ANSWER["criteria"]})
    gpt_only = evaluate(client, checklist["id"], mode_type=2)
    assert gpt_only["status"] == "completed" and gpt_only["mode_type"] == 2 and gpt_only["id"] != hybrid["id"]
    assert len(models.calls) == 3 and models.calls[2]["url"] == GPT_URL and len(models.criteria(2)) == 9
    assert [p["provider"] for p in gpt_only["parts"]] == ["openai"]
    assert gpt_only["final_score"]["percent"] == 71.18
    assert json.dumps(client.get(f"{API}/evaluations/{hybrid['id']}").json()["evaluation"], sort_keys=True) == stored


def test_a_failed_provider_fails_the_evaluation_and_a_retry_asks_only_that_provider(client, models):
    checklist = mixed_checklist(client)
    bad = {"criteria": [item("empathy", "maybe")]}
    models.answers += [GEMMA_ANSWER, bad, bad]
    failed = evaluate(client, checklist["id"], mode_type=1)
    assert failed["status"] == "failed" and failed["final_score"] is None and failed["original_results"] == []
    assert "OpenAI GPT failed for empathy, farewell_name" in failed["error"]["message"]
    assert [p["status"] for p in failed["parts"]] == ["completed", "failed"]

    models.answers.append(GPT_ANSWER)
    rerun = client.post(f"{API}/evaluations/{failed['id']}/rerun")
    assert rerun.status_code == 202
    wait_batch(client, rerun.json()["batch_id"])
    retried = client.get(f"{API}/evaluations/{rerun.json()['evaluations'][0]['id']}").json()["evaluation"]
    assert retried["status"] == "completed" and retried["final_score"]["percent"] == 71.18
    assert len(models.calls) == 4 and models.calls[3]["url"] == GPT_URL  # Gemma was not asked again
    assert retried["parts"][0]["reused_from"] == failed["id"] and retried["parts"][1]["reused_from"] is None
    assert client.get(f"{API}/evaluations/{failed['id']}").json()["evaluation"]["status"] == "failed"


def test_appeals_on_gemma_criteria_are_reassessed_by_gpt_and_export_reports_hybrid(client, models):
    config = official_config(client)
    next(c for c in config["criteria"] if c["id"] == "empathy")["description"] = "Edited wording."
    checklist = create(client, config, "Official, empathy reworded")  # still JSON 1.0 compatible
    models.answers += [GEMMA_ANSWER, {"criteria": [item("empathy", False, "Нет признания чувств клиента.")]}]
    evaluation = evaluate(client, checklist["id"], mode_type=1)
    assert evaluation["status"] == "completed" and evaluation["final_score"]["percent"] == 71.18

    models.answers.append(recommend("change", True, False, turns=(4,)))
    appeal = submit(client, evaluation["id"], "contact")  # contact was answered by Gemma
    detail = settled(client, appeal["id"])
    assert models.calls[2]["url"] == GPT_URL and models.calls[2]["body"]["model"] == "gpt-test"
    assert models.calls[2]["body"]["response_format"]["json_schema"]["name"] == "cqa_appeal_reassessment"
    assert detail["appeal"]["reassessment"]["reassessor"] == "openai"
    pending = client.get(f"{API}/evaluations/{evaluation['id']}").json()["evaluation"]
    assert pending["final_score"]["percent"] == 71.18  # GPT only recommends; nothing changes before the decision
    assert decide(client, appeal["id"], "accept").status_code == 200
    # contact (10) now false: 20 + 15 + 0 + 10.5 + 5 = 50.5 of 85 → 59.41
    assert client.get(f"{API}/evaluations/{evaluation['id']}").json()["evaluation"]["final_score"]["percent"] == 59.41

    report = client.get(f"{API}/results/export", params={"group_id": "DEV", "checklist_id": checklist["id"],
                                                         "team_name": "T"}).json()
    assert report["ready"], report["issues"]
    document = report["document"]
    assert document["model"] == {"mode": "hybrid", "name": "gemma-test-reported, gpt-test-reported"}
    assert document["results"][0]["score"]["final_score"] == 59.41

    # The untouched official checklist in mode 1 uses Gemma only: the export says "local", not "hybrid".
    models.answers.append({"criteria": [*GEMMA_ANSWER["criteria"], item("empathy", True)]})
    assert evaluate(client, OFFICIAL_CHECKLIST_ID, mode_type=1)["status"] == "completed"
    assert models.calls[-1]["url"] == GEMMA_URL
    local = client.get(f"{API}/results/export", params={"group_id": "DEV", "team_name": "T"}).json()
    assert local["ready"] and local["document"]["model"] == {"mode": "local", "name": "gemma-test-reported"}
