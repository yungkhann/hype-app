"""A worked request/response pair for the evaluator contract, built from the synthetic fixture ``fx-ru-001``
and the unofficial development checklist. The response is hand-written to show the expected shape; tests check
that it passes the backend's validation. Regenerate the docs copy with ``scripts/cqa_contract_example.py``.
"""

from __future__ import annotations

import json

from app.cqa.checklists import DEV_CHECKLIST_PATH
from app.cqa.contract import CONTRACT_VERSION, EvaluationRequest, build_request
from app.cqa.ingestion import fixture_payload, parse_payload
from app.cqa.schemas import ChecklistImport

EXAMPLE_EVALUATION_ID = "0123456789abcdef0123456789abcdef"
EXAMPLE_CHECKLIST_ID = "fedcba9876543210fedcba9876543210"


def example_request() -> EvaluationRequest:
    parsed = parse_payload(fixture_payload("FIXTURE"), "FIXTURE", "fixture", "2026-11-07T08:00:00+00:00")
    conversation = next(r for r in parsed.records if r.id == "fx-ru-001")
    document = json.loads(DEV_CHECKLIST_PATH.read_text(encoding="utf-8"))
    checklist = ChecklistImport.model_validate({k: v for k, v in document.items() if not k.startswith("_")})
    return build_request(EXAMPLE_EVALUATION_ID, conversation, EXAMPLE_CHECKLIST_ID, checklist.name, 1,
                         checklist.config)


def example_output() -> dict:
    """Illustrative answers for fx-ru-001 (m5 is the operator's greeting, m10 the farewell)."""
    return {
        "contract_version": CONTRACT_VERSION,
        "evaluation_id": EXAMPLE_EVALUATION_ID,
        "conversation_id": "fx-ru-001",
        "checklist_id": EXAMPLE_CHECKLIST_ID,
        "checklist_version": 1,
        "model": {"name": "example-model", "version": "0.0"},
        "results": [
            {"criterion_id": "greeting", "value": True, "raw_score": 1, "is_na": False,
             "explanation": "The operator's first message opens with a greeting.",
             "evidence": [{"message_id": "m5", "quote": "Добрый день!"}]},
            {"criterion_id": "introduction", "value": True, "is_na": False,
             "explanation": "The operator gives their name in the first message.",
             "evidence": [{"message_id": "m5", "quote": "Меня зовут Мария."}]},
            {"criterion_id": "need_identified", "value": 4, "is_na": False,
             "explanation": "The request (withdrawal to a card) is clear from the client's first line; the operator "
                            "acts on it without asking clarifying questions.",
             "evidence": [{"message_id": "m1", "quote": "как вывести деньги со счёта на карту?"},
                          {"message_id": "m5", "quote": "Помогу с выводом средств."}]},
            {"criterion_id": "solution", "value": "full", "is_na": False,
             "explanation": "The operator gives the exact steps and the expected timing; the client confirms success.",
             "evidence": [{"message_id": "m6"}, {"message_id": "m7", "quote": "Получилось, заявка создана."}]},
            {"criterion_id": "tone", "value": 5, "is_na": False,
             "explanation": "Polite throughout.",
             "evidence": [{"message_id": "m10", "quote": "Спасибо за обращение! Хорошего дня."}]},
            {"criterion_id": "further_help", "value": True, "is_na": False,
             "explanation": "The operator asks whether anything else is needed.",
             "evidence": [{"message_id": "m8", "quote": "Могу ещё чем-нибудь помочь?"}]},
            {"criterion_id": "farewell", "value": True, "is_na": False,
             "explanation": "The operator closes politely.",
             "evidence": [{"message_id": "m10"}],
             "inspected_spans": [{"start_message_id": "m8", "end_message_id": "m10",
                                  "note": "closing part of the conversation"}]},
        ],
    }
