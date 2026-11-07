"""Evaluator integration contract: strict output parsing, evidence validation, N/A and severe-error rules."""

from __future__ import annotations

import copy

import pytest

from app.cqa.contract import (
    CONTRACT_VERSION,
    ContractViolation,
    EvaluationRequest,
    locate_quote,
    validate_output,
)
from app.cqa.examples import example_output, example_request
from app.cqa.ingestion import fixture_payload, parse_payload


@pytest.fixture
def request_() -> EvaluationRequest:
    return example_request()


@pytest.fixture
def messages():
    parsed = parse_payload(fixture_payload("FIXTURE"), "FIXTURE", "fixture", "2026-11-07T08:00:00+00:00")
    return next(r for r in parsed.records if r.id == "fx-ru-001").messages


def output(**changes):
    data = copy.deepcopy(example_output())
    data.update(changes)
    return data


def with_result(criterion_id: str, **changes):
    data = output()
    for result in data["results"]:
        if result["criterion_id"] == criterion_id:
            result.update(changes)
    return data


def violations(request_, messages, payload) -> list[str]:
    with pytest.raises(ContractViolation) as caught:
        validate_output(request_, payload, messages)
    return caught.value.issues


def test_the_documented_example_passes_validation(request_, messages):
    validated = validate_output(request_, example_output(), messages)
    assert [r.criterion_id for r in validated.results] == [c.id for c in request_.checklist.criteria]
    assert validated.model_info == {"name": "example-model", "version": "0.0"}


def test_request_carries_stable_message_ids_and_full_criterion_definitions(request_):
    assert request_.contract_version == CONTRACT_VERSION
    ids = [m.id for m in request_.conversation.messages]
    assert ids == [f"m{i}" for i in range(1, len(ids) + 1)]
    assert {m.speaker for m in request_.conversation.messages} == {"client", "bot", "system", "operator"}
    solution = next(c for c in request_.checklist.criteria if c.id == "solution")
    assert solution.answer_type == "options" and solution.severe_error_enabled and solution.weight == 30
    assert request_.rules.evaluated_speaker == "operator"


def test_evidence_excerpt_is_taken_from_the_transcript(request_, messages):
    validated = validate_output(request_, example_output(), messages)
    greeting = validated.results[0].evidence[0]
    assert greeting.message_id == "m5" and greeting.excerpt == "Добрый день!" and greeting.quote_matched
    assert greeting.speaker == "operator" and greeting.timestamp == "00:41"
    no_quote = next(r for r in validated.results if r.criterion_id == "solution").evidence[0]
    assert no_quote.excerpt == messages[5].text and not no_quote.quote_matched


def test_unknown_message_id_is_rejected(request_, messages):
    issues = violations(request_, messages, with_result("greeting", evidence=[{"message_id": "m99"}]))
    assert any("m99 does not exist" in issue for issue in issues)


def test_fabricated_quote_is_rejected(request_, messages):
    issues = violations(request_, messages,
                        with_result("greeting", evidence=[{"message_id": "m5", "quote": "Привет, я робот"}]))
    assert any("quote not found in m5" in issue for issue in issues)


def test_quote_from_a_different_message_is_rejected(request_, messages):
    issues = violations(request_, messages,
                        with_result("greeting", evidence=[{"message_id": "m1", "quote": "Добрый день!"}]))
    assert any("quote not found in m1" in issue for issue in issues)


def test_quote_tolerates_case_whitespace_quotes_and_ellipsis_but_keeps_original_text(request_, messages):
    payload = with_result("greeting", evidence=[{"message_id": "m5", "quote": "«добрый   ДЕНЬ! меня зовут…»"}])
    evidence = validate_output(request_, payload, messages).results[0].evidence[0]
    assert evidence.excerpt == "Добрый день! Меня зовут"


@pytest.mark.parametrize(("text", "quote", "expected"), [
    ("Hello there", "hello THERE", (0, 11)),
    ("Сәлеметсіз бе!", "сәлеметсіз", (0, 10)),
    ("a  b\nc", "a b c", (0, 6)),
    ("abc", "   ", None),
    ("abc", "abd", None),
])
def test_locate_quote(text, quote, expected):
    assert locate_quote(text, quote) == expected


def test_every_criterion_must_be_answered_exactly_once(request_, messages):
    data = output()
    data["results"] = data["results"][1:]
    assert any("Missing results for: greeting" in i for i in violations(request_, messages, data))
    data = output()
    data["results"].append(copy.deepcopy(data["results"][0]))
    assert any("more than once" in i for i in violations(request_, messages, data))
    data = output()
    data["results"][0]["criterion_id"] = "made_up"
    assert any("unknown criterion id" in i for i in violations(request_, messages, data))


def test_na_only_where_allowed_with_reason_and_null_value(request_, messages):
    assert any("N/A is not allowed" in i for i in violations(
        request_, messages, with_result("solution", is_na=True, value=None, na_reason="x")))
    assert any("needs na_reason" in i for i in violations(
        request_, messages, with_result("greeting", is_na=True, value=None)))
    assert any("value must be null" in i for i in violations(
        request_, messages, with_result("greeting", is_na=True, value=True, na_reason="x")))
    payload = with_result("greeting", is_na=True, value=None, na_reason="No operator", evidence=[])
    ok = validate_output(request_, payload, messages)
    assert ok.results[0].is_na and ok.results[0].na_reason == "No operator"


@pytest.mark.parametrize(("criterion_id", "value"), [("greeting", "yes"), ("greeting", 1), ("need_identified", True),
                                                     ("need_identified", 7), ("need_identified", 2.5),
                                                     ("solution", "maybe"), ("solution", 2)])
def test_answers_must_match_the_answer_type_strictly(request_, messages, criterion_id, value):
    violations(request_, messages, with_result(criterion_id, value=value))


def test_answer_needs_evidence_or_an_inspected_span(request_, messages):
    issues = violations(request_, messages, with_result("tone", evidence=[], inspected_spans=[]))
    assert any("at least one evidence reference or inspected span" in i for i in issues)
    span_only = with_result("tone", evidence=[], inspected_spans=[{"start_message_id": "m5", "end_message_id": "m10"}])
    tone = next(r for r in validate_output(request_, span_only, messages).results if r.criterion_id == "tone")
    assert tone.inspected_spans[0].message_count == 6


def test_inspected_span_must_be_ordered_and_real(request_, messages):
    assert any("start is after end" in i for i in violations(
        request_, messages, with_result("farewell", inspected_spans=[{"start_message_id": "m9",
                                                                       "end_message_id": "m2"}])))
    assert any("unknown message id" in i for i in violations(
        request_, messages, with_result("farewell", inspected_spans=[{"start_message_id": "m1",
                                                                       "end_message_id": "m50"}])))


def test_severe_error_only_where_enabled_and_with_a_reason(request_, messages):
    assert any("not enabled" in i for i in violations(
        request_, messages, with_result("greeting", severe_error=True, severe_error_reason="x")))
    assert any("needs severe_error_reason" in i for i in violations(
        request_, messages, with_result("solution", value="none", severe_error=True)))
    ok = validate_output(request_, with_result("solution", value="none", severe_error=True,
                                               severe_error_reason="Wrong withdrawal instructions"), messages)
    assert next(r for r in ok.results if r.criterion_id == "solution").severe_error


def test_header_must_match_the_request(request_, messages):
    assert any("contract_version" in i for i in violations(request_, messages, output(contract_version="v0")))
    assert any("evaluation_id" in i for i in violations(request_, messages, output(evaluation_id="other")))
    assert any("checklist_id" in i for i in violations(request_, messages, output(checklist_version=2)))


def test_unknown_fields_and_wrong_shapes_are_rejected(request_, messages):
    violations(request_, messages, with_result("greeting", score=100))  # no extra fields: no score smuggling
    violations(request_, messages, output(total_score=99))
    violations(request_, messages, "not an object")
    violations(request_, messages, output(results="nope"))


def test_stated_raw_score_never_drives_the_score_and_a_mismatch_is_a_warning(request_, messages):
    validated = validate_output(request_, with_result("need_identified", raw_score=5), messages)
    result = next(r for r in validated.results if r.criterion_id == "need_identified")
    assert result.value == 4 and result.model_raw_score == 5
    assert any("raw_score 5" in w for w in validated.warnings)
