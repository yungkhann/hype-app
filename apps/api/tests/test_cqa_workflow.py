"""Evaluation lifecycle, adapter failures, appeals and reviewer decisions, and the full five-minute demo flow
(through the HTTP API, with the development mock and test adapters; all data synthetic)."""

from __future__ import annotations

import threading

import pytest

from app.cqa.adapters import EvaluatorAdapter, register_adapter
from app.cqa.adapters.mock import MOCK_TAG
from app.cqa.audio import AudioResolver, extract_audio_source, host_allowed
from app.cqa.schemas import ConversationRecord, Message
from tests.cqa_helpers import API, dev_checklist, evaluate, import_fixtures, wait_batch

# ---- test adapters (registered globally; each app instance gets its own copy) ------------------------------


@register_adapter("test-invalid")
class InvalidEvaluator(EvaluatorAdapter):
    """Cites a message that does not exist and quotes text that is not in the transcript."""

    def evaluate(self, request):
        results = [{"criterion_id": c.id, "value": True if c.answer_type == "binary" else None,
                    "explanation": "x", "evidence": [{"message_id": "m999"}]} for c in request.checklist.criteria]
        return {"contract_version": "cqa-eval/1", "evaluation_id": request.evaluation_id,
                "conversation_id": request.conversation.conversation_id,
                "checklist_id": request.checklist.checklist_id, "checklist_version": request.checklist.version,
                "results": results}


@register_adapter("test-crash")
class CrashingEvaluator(EvaluatorAdapter):
    def evaluate(self, request):
        raise RuntimeError("boom")


GATE = threading.Event()


@register_adapter("test-slow")
class SlowEvaluator(EvaluatorAdapter):
    """Blocks until GATE is set, then answers like the mock: exposes pending/running states."""

    def evaluate(self, request):
        GATE.wait(10)
        from app.cqa.adapters.mock import MockEvaluator
        return MockEvaluator(self.settings).evaluate(request)


@pytest.fixture
def ready(client):
    import_fixtures(client)
    return dev_checklist(client)


def detail(client, evaluation_id):
    return client.get(f"{API}/evaluations/{evaluation_id}").json()


def first_evaluation(client, conversation_id):
    return client.get(f"{API}/conversations/{conversation_id}").json()["evaluations"][0]


# ---- evaluations ------------------------------------------------------------------------------------------


def test_mock_evaluation_completes_with_validated_evidence_and_engine_scores(client, ready):
    evaluate(client, ready["id"], ["fx-ru-001"])
    brief = first_evaluation(client, "fx-ru-001")
    assert brief["status"] == "completed" and brief["is_mock"] and brief["checklist_version"] == 1
    data = detail(client, brief["id"])
    record = data["evaluation"]
    assert record["evaluator"]["name"] == "mock" and record["evaluator"]["is_mock"]
    assert record["checklist"] == ready["versions"][0]["config"]  # reproducible snapshot
    messages = {m["id"]: m for m in client.get(f"{API}/conversations/fx-ru-001").json()["messages"]}
    for view in data["criteria"]:
        result = view["original"]
        assert MOCK_TAG in result["explanation"]  # never presented as AI analysis
        for ref in result["evidence"]:
            assert ref["excerpt"] in messages[ref["message_id"]]["text"]
    assert record["original_score"]["total"] == record["final_score"]["total"]


def test_mock_is_deterministic_and_unaffected_by_unrelated_criteria(client, ready):
    evaluate(client, ready["id"], ["fx-en-001"])
    evaluate(client, ready["id"], ["fx-en-001"])
    first, second = [e["id"] for e in client.get(f"{API}/conversations/fx-en-001").json()["evaluations"]]
    assert detail(client, first)["final_results"] == detail(client, second)["final_results"]


def test_status_moves_pending_running_completed(client, ready):
    GATE.clear()
    queued = client.post(f"{API}/evaluations", json={"checklist_id": ready["id"], "conversation_ids": ["fx-ru-001"],
                                                     "adapter": "test-slow"}).json()
    evaluation_id = queued["evaluations"][0]["id"]
    assert queued["evaluations"][0]["status"] == "pending"
    for _ in range(100):
        if detail(client, evaluation_id)["evaluation"]["status"] == "running":
            break
        threading.Event().wait(0.02)
    assert detail(client, evaluation_id)["evaluation"]["status"] == "running"
    GATE.set()
    wait_batch(client, queued["batch_id"])
    assert detail(client, evaluation_id)["evaluation"]["status"] == "completed"


def test_invalid_model_output_fails_the_evaluation_with_reasons(client, ready):
    evaluate(client, ready["id"], ["fx-ru-001"], adapter="test-invalid")
    record = detail(client, first_evaluation(client, "fx-ru-001")["id"])["evaluation"]
    assert record["status"] == "failed" and record["error"]["code"] == "invalid_output"
    assert any("m999 does not exist" in issue for issue in record["error"]["issues"])
    assert record["original_results"] == [] and record["final_score"] is None  # nothing partial saved
    assert record["raw_output"]["results"]  # kept for debugging


def test_crashing_adapter_is_contained(client, ready):
    evaluate(client, ready["id"], ["fx-ru-001"], adapter="test-crash")
    record = detail(client, first_evaluation(client, "fx-ru-001")["id"])["evaluation"]
    assert record["status"] == "failed" and record["error"]["code"] == "evaluator_crashed"


def test_unavailable_or_unknown_evaluators_are_refused_up_front(client, ready):
    body = {"checklist_id": ready["id"], "conversation_ids": ["fx-ru-001"]}
    assert client.post(f"{API}/evaluations", json={**body, "adapter": "http"}).json()["error"]["code"] == \
        "evaluator_unavailable"
    assert client.post(f"{API}/evaluations", json={**body, "adapter": "nope"}).status_code == 422
    assert client.post(f"{API}/evaluations", json={**body, "conversation_ids": ["ghost"]}).status_code == 404


def test_batch_by_group_and_only_missing(client, ready):
    queued = evaluate(client, ready["id"], group_id="FIXTURE")
    assert queued["queued"] == 6
    again = evaluate(client, ready["id"], only_missing=True)
    assert again["queued"] == 0 and again["skipped"] == 6
    import_fixtures(client, "FIXTURE-CONTROL")
    control = evaluate(client, ready["id"], only_missing=True)
    assert control["queued"] == 2
    statuses = client.get(f"{API}/evaluations", params={"status": "completed"}).json()
    assert statuses["total"] == 8


def test_contract_request_endpoint_matches_what_the_adapter_receives(client, ready):
    evaluate(client, ready["id"], ["fx-kz-001"])
    evaluation_id = first_evaluation(client, "fx-kz-001")["id"]
    request = client.get(f"{API}/evaluations/{evaluation_id}/request").json()
    assert request["evaluation_id"] == evaluation_id and request["conversation"]["language"] == "KZ"
    assert request["checklist"]["version"] == 1 and len(request["checklist"]["criteria"]) == 7
    contract = client.get(f"{API}/contract").json()
    assert contract["contract_version"] == "cqa-eval/1" and "output_schema" in contract


# ---- appeals ------------------------------------------------------------------------------------------------


@pytest.fixture
def evaluated(client, ready):
    evaluate(client, ready["id"], ["fx-ru-001"])
    return detail(client, first_evaluation(client, "fx-ru-001")["id"])


def appeal(client, evaluation_id, criterion_id, comment="The operator did greet the client."):
    return client.post(f"{API}/appeals", json={"evaluation_id": evaluation_id, "criterion_id": criterion_id,
                                               "comment": comment, "submitted_by": "Operator A"})


def scored_criterion(data, predicate):
    return next(v for v in data["criteria"] if v["final_score"]["status"] == "scored" and predicate(v))


def test_submit_appeal_records_the_disputed_result(client, evaluated):
    view = scored_criterion(evaluated, lambda v: True)
    response = appeal(client, evaluated["evaluation"]["id"], view["criterion"]["id"])
    assert response.status_code == 201
    created = response.json()
    assert created["status"] == "pending" and created["submitted_by"] == "Operator A"
    assert created["disputed_points"] == view["final_score"]["points"]
    assert created["total_at_submission"] == evaluated["evaluation"]["final_score"]["total"]
    duplicate = appeal(client, evaluated["evaluation"]["id"], view["criterion"]["id"])
    assert duplicate.status_code == 409 and duplicate.json()["error"]["code"] == "appeal_exists"
    assert client.get(f"{API}/appeals", params={"status": "pending"}).json()[0]["id"] == created["id"]
    page = client.get(f"{API}/conversations", params={"status": "appealed"}).json()
    assert page["total"] == 1 and page["items"][0]["open_appeals"] == 1


def test_reviewer_sees_original_score_evidence_comment_and_context(client, evaluated):
    view = scored_criterion(evaluated, lambda v: bool(v["original"]["evidence"]))
    created = appeal(client, evaluated["evaluation"]["id"], view["criterion"]["id"]).json()
    review = client.get(f"{API}/appeals/{created['id']}").json()
    assert review["appeal"]["comment"] == "The operator did greet the client."
    assert review["criterion"]["id"] == view["criterion"]["id"]
    assert review["current_result"]["evidence"] == view["original"]["evidence"]
    context_ids = {m["id"] for m in review["context"]}
    assert {ref["message_id"] for ref in view["original"]["evidence"]} <= context_ids


def test_confirm_keeps_the_score_and_requires_an_explanation(client, evaluated):
    view = scored_criterion(evaluated, lambda v: True)
    created = appeal(client, evaluated["evaluation"]["id"], view["criterion"]["id"]).json()
    url = f"{API}/appeals/{created['id']}/decision"
    assert client.post(url, json={"decision": "confirm", "explanation": ""}).status_code == 422
    decided = client.post(url, json={"decision": "confirm", "explanation": "Evidence supports the result.",
                                     "reviewer": "QA Lead"}).json()
    assert decided["status"] == "confirmed" and decided["decision"]["reviewer"] == "QA Lead"
    assert decided["decision"]["total_before"] == decided["decision"]["total_after"]
    assert client.post(url, json={"decision": "confirm", "explanation": "again"}).status_code == 409
    after = detail(client, evaluated["evaluation"]["id"])
    assert after["evaluation"]["overrides"] == []


def test_override_recalculates_final_score_and_preserves_original(client, evaluated):
    record = evaluated["evaluation"]
    view = next(v for v in evaluated["criteria"] if v["criterion"]["answer_type"] == "binary"
                and v["final_score"]["status"] == "scored")
    flipped = not view["original"]["value"]
    created = appeal(client, record["id"], view["criterion"]["id"]).json()
    decided = client.post(f"{API}/appeals/{created['id']}/decision", json={
        "decision": "override", "explanation": "Line m5 shows the opposite.", "reviewer": "QA Lead",
        "override": {"value": flipped}}).json()
    assert decided["status"] == "overridden"
    after = detail(client, record["id"])
    final_view = next(v for v in after["criteria"] if v["criterion"]["id"] == view["criterion"]["id"])
    assert final_view["overridden"] and final_view["final"]["value"] is flipped
    assert final_view["final"]["source"] == "reviewer"
    assert final_view["original"]["value"] is view["original"]["value"]  # original preserved
    assert after["evaluation"]["original_score"] == record["original_score"]
    delta = final_view["final_score"]["max_points"] * (1 if flipped else -1)
    assert after["evaluation"]["final_score"]["total"] == pytest.approx(record["final_score"]["total"] + delta,
                                                                          abs=0.051)
    assert decided["decision"]["total_after"] == after["evaluation"]["final_score"]["total"]
    types = [e["type"] for e in client.get(f"{API}/audit", params={"evaluation_id": record["id"]}).json()]
    assert {"evaluation.queued", "evaluation.completed", "appeal.submitted", "appeal.decided",
            "evaluation.final_recalculated"} <= set(types)
    brief = first_evaluation(client, "fx-ru-001")
    assert brief["overridden"] and brief["original_total"] != brief["final_total"]


def test_override_to_na_redistributes_weight(client, evaluated):
    record = evaluated["evaluation"]
    view = next(v for v in evaluated["criteria"] if v["criterion"]["na_allowed"]
                and v["final_score"]["status"] == "scored")
    created = appeal(client, record["id"], view["criterion"]["id"]).json()
    client.post(f"{API}/appeals/{created['id']}/decision", json={
        "decision": "override", "explanation": "Not applicable here.", "override": {"is_na": True}})
    final = detail(client, record["id"])["evaluation"]["final_score"]
    target = next(c for c in final["criteria"] if c["criterion_id"] == view["criterion"]["id"])
    assert target["status"] == "na" and target["effective_weight"] == 0
    assert sum(c["effective_weight"] for c in final["criteria"]) == pytest.approx(1)


def test_invalid_overrides_are_rejected(client, evaluated):
    record = evaluated["evaluation"]
    def decide(criterion_id, override):
        created = appeal(client, record["id"], criterion_id, comment=f"dispute {criterion_id}").json()
        return client.post(f"{API}/appeals/{created['id']}/decision",
                           json={"decision": "override", "explanation": "x" * 5, "override": override})
    assert decide("need_identified", {"value": 9}).status_code == 422   # off the 0–5 scale
    assert decide("solution", {"is_na": True}).status_code == 422       # N/A not allowed
    assert decide("tone", {"value": 3, "severe_error": True}).status_code == 422  # severe not enabled
    assert decide("greeting", {"value": "yes"}).status_code == 422      # binary needs true/false


def test_appeals_need_a_completed_evaluation(client, ready):
    evaluate(client, ready["id"], ["fx-ru-001"], adapter="test-crash")
    failed = first_evaluation(client, "fx-ru-001")
    assert appeal(client, failed["id"], "greeting").status_code == 409


# ---- audio ---------------------------------------------------------------------------------------------------


def make_call(audio_url):
    return ConversationRecord(id="call", group_ids=["DEV"], channel="voice", channel_raw="voice call", language="RU",
                              language_raw="RU", audio_url=audio_url, source="organizer_api",
                              messages=[Message(id="m1", index=0, speaker="operator", speaker_raw="operator", text="x",
                                                timestamp="t")], transcript_hash="h", imported_at="t", updated_at="t")


PLAYER = ('<html><audio controls><source src="https://files.crm.dynamics.com/api/file/1?sp=r&amp;se=2099-01-01T00:00:00Z'
          '&amp;sig=abc" type="audio/mpeg"></audio></html>')


def test_audio_player_page_resolves_to_a_playable_source(settings):
    calls = []

    def opener(url, timeout):
        calls.append(url)
        return "text/html", PLAYER.encode()

    resolver = AudioResolver(settings, opener=opener)
    info = resolver.resolve(make_call("https://x.environment.api.powerplatform.com/invoke/Conversation/1?sig=s"))
    assert info.status == "ready" and info.content_type == "audio/mpeg"
    assert info.stream_url.startswith("https://files.crm.dynamics.com/api/file/1?sp=r&se=")
    resolver.resolve(make_call("https://x.environment.api.powerplatform.com/invoke/Conversation/1?sig=s"))
    assert len(calls) == 1  # cached


def test_audio_hosts_outside_the_allow_list_are_never_contacted(settings):
    resolver = AudioResolver(settings, opener=lambda url, timeout: pytest.fail("must not fetch"))
    info = resolver.resolve(make_call("https://evil.example.com/rec"))
    assert info.status == "player_only" and info.player_url == "https://evil.example.com/rec"
    assert resolver.resolve(make_call(None)).status == "unavailable"
    assert not host_allowed("http://x.powerplatform.com/a", settings.cqa_audio_hosts)  # https only
    assert not host_allowed("https://powerplatform.com.evil.io/a", settings.cqa_audio_hosts)
    assert extract_audio_source("<p>no audio</p>") is None


# ---- the five-minute demo, end to end ----------------------------------------------------------------------


def test_full_demo_flow(client):
    # 1. Import the dataset and create the checklist.
    assert import_fixtures(client)["created"] == 6
    checklist = dev_checklist(client)
    evaluate(client, checklist["id"])
    overview = client.get(f"{API}/overview").json()
    assert overview["conversations"] == 6 and overview["evaluated_conversations"] == 6
    assert overview["mock_results"] == 6 and len(overview["criterion_stats"]) == 7

    # 2. Open a conversation: transcript, evaluation, evidence that points at a real line, an N/A example.
    conversation = client.get(f"{API}/conversations/fx-en-002").json()  # bot-only chat → operator criteria N/A
    result = detail(client, conversation["evaluations"][0]["id"])
    na_views = [v for v in result["criteria"] if v["final_score"]["status"] == "na"]
    assert na_views and all(v["final"]["na_reason"] for v in na_views)
    assert result["evaluation"]["final_score"]["total"] is not None

    # 3. Appeal a criterion and override it as reviewer: the final total changes, the original stays.
    target = scored_criterion(result, lambda v: v["criterion"]["answer_type"] == "scale")
    created = appeal(client, result["evaluation"]["id"], target["criterion"]["id"], "Score is too low.").json()
    scale = target["criterion"]["scale"]
    new_value = scale["max"] if target["final"]["value"] != scale["max"] else scale["min"]
    decision = client.post(f"{API}/appeals/{created['id']}/decision", json={
        "decision": "override", "explanation": "Reviewed the transcript.", "override": {"value": new_value}}).json()
    assert decision["decision"]["total_before"] != decision["decision"]["total_after"]

    # 4. Replace a criterion through the API, re-evaluate with the new version.
    new_criterion = {"id": "compliance", "name": "Compliance (sample)", "weight": 15, "answer_type": "binary",
                     "section_id": "resolution"}
    updated = client.post(f"{API}/checklists/{checklist['id']}/criteria/tone/replace",
                          json={"base_version": 1, "criterion": new_criterion}).json()
    assert updated["latest_version"] == 2
    queued = evaluate(client, checklist["id"], only_missing=True)
    assert queued["queued"] == 6
    latest = first_evaluation(client, "fx-en-002")
    assert latest["checklist_version"] == 2
    ids = [v["criterion"]["id"] for v in detail(client, latest["id"])["criteria"]]
    assert "compliance" in ids and "tone" not in ids
    old = detail(client, result["evaluation"]["id"])
    assert old["evaluation"]["checklist_version"] == 1  # earlier results remain reproducible
    assert "tone" in [v["criterion"]["id"] for v in old["criteria"]]

    # New conversations arrive (control set) and are evaluated without redeploying.
    import_fixtures(client, "FIXTURE-CONTROL")
    assert evaluate(client, checklist["id"], only_missing=True)["queued"] == 2


def test_latest_evaluation_is_the_most_recent_even_within_the_same_second(client, ready):
    copy = client.post(f"{API}/checklists/{ready['id']}/duplicate", json={"name": "Second"}).json()
    for _ in range(3):
        evaluate(client, ready["id"], ["fx-en-001"])
        evaluate(client, copy["id"], ["fx-en-001"])
        newest = client.get(f"{API}/conversations/fx-en-001").json()["evaluations"][0]
        assert newest["checklist_id"] == copy["id"]
