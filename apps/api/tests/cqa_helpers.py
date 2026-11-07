"""Shared helpers for the CQA tests. Data is synthetic (fixtures or built inline)."""

from __future__ import annotations

import time
from typing import Any

from fastapi.testclient import TestClient

from app.cqa.schemas import ChecklistConfig, Criterion, CriterionResult

API = "/api/v1/cqa"


def criterion(cid: str, weight: float = 10, **kwargs: Any) -> Criterion:
    return Criterion(id=cid, name=kwargs.pop("name", cid.title()), weight=weight, **kwargs)


def config(*criteria: Criterion, **scoring: Any) -> ChecklistConfig:
    sections = scoring.pop("sections", [])
    return ChecklistConfig(criteria=list(criteria), sections=sections, scoring=scoring or {})


def answer(cid: str, value: Any = True, **kwargs: Any) -> CriterionResult:
    return CriterionResult(criterion_id=cid, value=value, **kwargs)


def na(cid: str) -> CriterionResult:
    return CriterionResult(criterion_id=cid, value=None, is_na=True, na_reason="not applicable")


def organizer_payload(records: list[dict], group: str = "DEV") -> dict:
    return {"error": "", "isSuccess": True,
            "data": {"dataset_group_id": group, "total_records": len(records), "records": records}}


def chat_record(cid: str, language: str = "RU", lines: list[tuple[str, str, str]] | None = None) -> dict:
    lines = lines or [("00:00", "client", "Здравствуйте, вопрос по счёту."),
                      ("00:05", "bot", "Соединяю с оператором."),
                      ("00:06", "system", "Эскалация на оператора."),
                      ("00:40", "operator", "Добрый день! Меня зовут Ая. Чем помочь?"),
                      ("01:10", "client", "Спасибо, всё понятно.")]
    return {"conversation_id": cid, "channel": "agent chat", "language": language,
            "transcript": [{"timestamp": t, "speaker": s, "text": x} for t, s, x in lines], "audio_url": None}


def import_fixtures(client: TestClient, group: str = "FIXTURE") -> dict:
    response = client.post(f"{API}/imports", json={"group_id": group, "source": "fixture"})
    assert response.status_code == 201, response.text
    return response.json()


def dev_checklist(client: TestClient) -> dict:
    response = client.post(f"{API}/checklists/dev-sample")
    assert response.status_code == 201, response.text
    return response.json()


def wait_batch(client: TestClient, batch_id: str, timeout: float = 30) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get(f"{API}/evaluations/batches/{batch_id}").json()
        if status["done"]:
            return status
        time.sleep(0.05)
    raise AssertionError(f"batch {batch_id} did not finish")


def evaluate(client: TestClient, checklist_id: str, conversation_ids: list[str] | None = None, **extra: Any) -> dict:
    body: dict[str, Any] = {"checklist_id": checklist_id, **extra}
    if conversation_ids is not None:
        body["conversation_ids"] = conversation_ids
    response = client.post(f"{API}/evaluations", json=body)
    assert response.status_code == 202, response.text
    queued = response.json()
    if queued["queued"]:
        wait_batch(client, queued["batch_id"])
    return queued
