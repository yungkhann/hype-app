"""The organizers' results file (JSON 1.0): built from stored evaluations, final answers after accepted appeals.

GPT is the fake ``urlopen`` from the OpenAI tests (no network, no paid calls). Everything else is the real path:
import, official checklist, GPT evaluation, scoring engine, appeal, GPT reassessment, manager decision, export.
All data is synthetic.
"""

from __future__ import annotations

import copy
import json

from app.cqa.checklists import OFFICIAL_CHECKLIST_ID
from app.cqa.results_export import main, official_ids, validate_document
from tests import test_cqa_openai
from tests.cqa_helpers import API, chat_record, organizer_payload, wait_batch
from tests.test_cqa_appeals import decide, recommend, settled, submit
from tests.test_cqa_openai import CONVERSATION, OFFICIAL_ANSWER, custom_checklist, fake, item, run

client = test_cqa_openai.client  # a test app configured for GPT, with conversation gpt-ru-001 in group DEV
SECOND = "gpt-ru-002"
TEAM = "Test Team"


def export(client, **params):
    params = {"group_id": "DEV", "team_name": TEAM, **params}
    response = client.get(f"{API}/results/export", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_export_holds_final_answers_after_an_accepted_appeal_and_genuine_failures(client, monkeypatch):
    assert client.post(f"{API}/imports/json", json=organizer_payload([chat_record(SECOND)])).status_code == 201
    before = export(client)
    assert not before["ready"] and before["summary"]["missing"] == 2 and before["document"]["results"] == []
    params = {"group_id": "DEV", "team_name": TEAM}
    assert client.get(f"{API}/results/export/download", params=params).status_code == 409

    gpt = fake(monkeypatch, OFFICIAL_ANSWER)
    evaluation = run(client, OFFICIAL_CHECKLIST_ID)["evaluation"]
    assert evaluation["final_score"]["percent"] == 71.18
    bad = {"criteria": [item("contact", "yes")]}
    gpt.answers.extend([bad, bad])  # stays invalid after the retry: a genuine failure
    queued = client.post(f"{API}/evaluations",
                         json={"checklist_id": OFFICIAL_CHECKLIST_ID, "conversation_ids": [SECOND]})
    wait_batch(client, queued.json()["batch_id"])
    failure = client.get(f"{API}/evaluations", params={"conversation_id": SECOND}).json()["items"][0]["error"]

    gpt.answers.append(recommend("change", False, True, turns=(4, 5)))  # empathy: GPT recommends "yes"
    appeal = submit(client, evaluation["id"], "empathy")
    settled(client, appeal["id"])
    assert decide(client, appeal["id"], "accept").status_code == 200

    report = export(client)
    assert report["ready"], report["issues"]
    document = report["document"]
    assert list(document) == ["schema_version", "team_name", "model", "results"]
    assert document["schema_version"] == "1.0" and document["team_name"] == TEAM
    assert document["model"] == {"mode": "external_api", "name": "gpt-test-2026-01-01"}
    ok, failed = document["results"]
    assert ok["conversation_id"] == CONVERSATION and ok["status"] == "ok"
    assert [c["criterion_id"] for c in ok["criteria"]] == official_ids()
    values = {c["criterion_id"]: c["value"] for c in ok["criteria"]}
    assert values == {"contact": True, "discovery": None, "identification": True, "consultation": 15,
                      "empathy": True, "dialogue": 7, "closure": True, "critical": True}
    assert type(values["consultation"]) is int and type(values["dialogue"]) is int
    # The accepted appeal is in the score: (10 + 20 + 15 + 15 + 10.5 + 5) / 85 = 88.82 (was 71.18), critical kept.
    assert ok["score"] == {"final_score": 88.82, "critical_flag": True}
    turns = {c["criterion_id"]: c["evidence_turns"] for c in ok["criteria"]}
    assert turns["contact"] == [4] and turns["empathy"] == [4, 5] and turns["discovery"] == []
    assert all(c["rationale"] for c in ok["criteria"])
    assert failed == {"conversation_id": SECOND, "status": "error", "criteria": [], "score": None,
                      "error": failure["message"]}
    assert report["summary"]["with_accepted_appeals"] == 1 and report["summary"]["error"] == 1

    record = client.get(f"{API}/evaluations/{evaluation['id']}").json()["evaluation"]
    assert record["original_score"]["percent"] == 71.18  # history keeps the original evaluation

    download = client.get(f"{API}/results/export/download", params={"group_id": "DEV", "team_name": TEAM})
    assert download.status_code == 200 and "results.json" in download.headers["content-disposition"]
    assert json.loads(download.content.decode("utf-8")) == document
    assert not export(client, team_name="")["ready"]
    assert export(client, target="prod")["issues"][-1]["code"] == "unexpected_count"


def test_mock_results_and_incompatible_checklists_are_never_exported(client, monkeypatch):
    run(client, OFFICIAL_CHECKLIST_ID, adapter="mock")
    report = export(client)
    assert report["rows"][0]["state"] == "mock_only" and report["document"]["results"] == []
    assert not report["ready"]

    checklist = custom_checklist(client, "Professional tone.", [0, 5, 10])
    fake(monkeypatch, {"criteria": [item("professionalism", 5), item("greeting", True)]})
    run(client, checklist["id"])
    report = export(client, checklist_id=checklist["id"])
    assert not report["checklist_compatible"] and report["rows"][0]["state"] == "incompatible"
    assert report["document"]["results"] == [] and not report["ready"]
    assert "checklist_incompatible" in {i["code"] for i in report["issues"]}


APPENDIX = {"schema_version": "1.0", "team_name": "Название команды", "model": {"mode": "local", "name": "M"},
            "results": [{"conversation_id": "demo-001", "status": "ok", "criteria": [
                {"criterion_id": "contact", "value": True, "rationale": "r", "evidence_turns": [4]},
                {"criterion_id": "discovery", "value": None, "rationale": "r", "evidence_turns": [1]},
                {"criterion_id": "identification", "value": None, "rationale": "r", "evidence_turns": [1]},
                {"criterion_id": "consultation", "value": 15, "rationale": "r", "evidence_turns": [5, 6]},
                {"criterion_id": "empathy", "value": True, "rationale": "r", "evidence_turns": [4, 5]},
                {"criterion_id": "dialogue", "value": 7, "rationale": "r", "evidence_turns": [5, 6]},
                {"criterion_id": "closure", "value": True, "rationale": "r", "evidence_turns": [8]},
                {"criterion_id": "critical", "value": False, "rationale": "r", "evidence_turns": [4, 5, 6, 8]}],
                "score": {"final_score": 85.38, "critical_flag": False}},
                {"conversation_id": "demo-002", "status": "error", "criteria": [], "score": None,
                 "error": "Не удалось получить ответ модели."}]}


def test_validator_accepts_the_appendix_example_and_rejects_format_breaks():
    assert validate_document(APPENDIX) == []

    def codes(mutate) -> set[str]:
        document = copy.deepcopy(APPENDIX)
        mutate(document)
        return {i.code for i in validate_document(document, transcript_lengths={"demo-001": 8}, target="prod")}

    criteria = lambda d: d["results"][0]["criteria"]  # noqa: E731
    assert "invalid_document" in codes(lambda d: criteria(d)[3].update(value=15.0))  # numbers stay integers
    assert "invalid_document" in codes(lambda d: criteria(d)[0].update(value=None))  # contact has no N/A
    assert "score_mismatch" in codes(lambda d: d["results"][0]["score"].update(final_score=85.0))
    assert "invalid_document" in codes(lambda d: d["results"][0]["score"].update(critical_flag=True))
    assert "invalid_evidence" in codes(lambda d: criteria(d)[6].update(evidence_turns=[9]))
    assert "invalid_document" in codes(lambda d: criteria(d).pop())
    assert "invalid_document" in codes(lambda d: d["results"][1].update(score=0))
    assert "duplicate_ids" in codes(lambda d: d["results"].append(copy.deepcopy(d["results"][1])))
    assert "unexpected_count" in codes(lambda d: None)  # prod needs exactly 10 records


def test_command_line_writes_only_a_ready_file_and_checks_it(client, monkeypatch, tmp_path, capsys):
    fake(monkeypatch, OFFICIAL_ANSWER)
    run(client, OFFICIAL_CHECKLIST_ID)
    data_dir = str(client.app.state.cqa.settings.data_dir)
    out = tmp_path / "results" / "prod" / "results.json"
    args = ["--set", "prod", "--group", "DEV", "--data-dir", data_dir, "--out", str(out), "--team", TEAM]
    assert main(args) == 1 and not out.exists()  # PROD needs 10 conversations: nothing written
    assert main([*args, "--allow-incomplete"]) == 1 and out.exists()
    document = json.loads(out.read_text(encoding="utf-8"))
    assert [r["conversation_id"] for r in document["results"]] == [CONVERSATION]
    assert main(["--set", "prod", "--check", str(out)]) == 1  # structurally valid, but not 10 records
    assert "needs 10 records" in capsys.readouterr().out
    assert validate_document(document) == []
