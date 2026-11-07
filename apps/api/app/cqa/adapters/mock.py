"""DEVELOPMENT MOCK evaluator. Deterministic placeholder answers, never AI analysis.

It exists so every screen and the whole appeal workflow can be built and tested before the real model is
connected. Every result it produces says so in its explanation, the evaluation is flagged ``is_mock``, and the UI
shows a warning wherever its numbers appear.

How it answers (no language understanding at all):

* each answer comes from a SHA-256 hash of (conversation id, criterion id, criterion definition), so the same
  input always gives the same output, and editing or replacing one criterion changes only that criterion;
* the cited evidence is a real transcript line (preferably an operator line) picked by the same hash, quoted
  verbatim, so evidence navigation can be exercised;
* N/A appears for criteria that allow it when there is no operator line, or for some hash buckets, to exercise
  weight redistribution; severe errors appear only where enabled, for some negative answers.
"""

from __future__ import annotations

import hashlib
import json

from app.cqa.adapters.base import EvaluatorAdapter, register_adapter
from app.cqa.contract import CONTRACT_VERSION, EvaluationRequest, RequestMessage
from app.cqa.schemas import Criterion

MOCK_TAG = "[DEV MOCK]"
_EXPLANATION = (f"{MOCK_TAG} Deterministic placeholder, not an AI judgement. The answer comes from a hash of the "
                "conversation and criterion; the cited line is a real transcript line picked the same way.")


def _bucket(*parts: str) -> int:
    return int(hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:12], 16)


def _definition(criterion: Criterion) -> str:
    return json.dumps(criterion.model_dump(mode="json"), sort_keys=True, ensure_ascii=False)


def _quote(message: RequestMessage, limit: int = 90) -> str | None:
    text = message.text.strip()
    if not text:
        return None
    if len(text) <= limit:
        return text
    cut = text.rfind(" ", 0, limit)
    return text[: cut if cut > 20 else limit].rstrip()


@register_adapter("mock")
class MockEvaluator(EvaluatorAdapter):
    label = "Development mock (not AI)"
    version = "1"
    is_mock = True
    description = ("Deterministic placeholder answers for development and demos of the workflow. "
                   "Not an AI evaluation.")

    def evaluate(self, request: EvaluationRequest) -> dict:
        messages = request.conversation.messages
        operator = [m for m in messages if m.speaker == "operator"]
        pool = operator or [m for m in messages if m.speaker not in ("system",)] or messages
        results = []
        for criterion in request.checklist.criteria:
            h = _bucket(request.conversation.conversation_id, criterion.id, _definition(criterion))
            whole = {"start_message_id": messages[0].id, "end_message_id": messages[-1].id,
                     "note": f"{MOCK_TAG} whole conversation"}
            if criterion.na_allowed and (not operator or h % 6 == 0):
                reason = ("no operator line in the transcript" if not operator
                          else "placeholder N/A chosen by hash to exercise weight redistribution")
                results.append({"criterion_id": criterion.id, "value": None, "is_na": True,
                                "na_reason": f"{MOCK_TAG} {reason.capitalize()}. Not an AI judgement.",
                                "explanation": _EXPLANATION, "evidence": [], "inspected_spans": [whole]})
                continue

            negative: bool
            if criterion.answer_type == "binary":
                value: object = h % 4 != 0
                negative = value is False
            elif criterion.answer_type == "scale":
                points = criterion.scale.points()  # type: ignore[union-attr]
                value = points[-1 - (h % min(3, len(points)))]
                if float(value).is_integer():
                    value = int(value)
                negative = (float(value) - points[0]) / (points[-1] - points[0]) < 0.5
            else:
                options = sorted(criterion.options or [], key=lambda o: -o.points)
                option = options[h % len(options)]
                value = option.id
                negative = option.points < options[0].points / 2

            message = pool[h % len(pool)]
            quote = _quote(message)
            result = {"criterion_id": criterion.id, "value": value, "is_na": False, "explanation": _EXPLANATION,
                      "evidence": [{"message_id": message.id, "quote": quote}], "inspected_spans": []}
            if negative:
                result["inspected_spans"] = [{"start_message_id": pool[0].id, "end_message_id": messages[-1].id,
                                              "note": f"{MOCK_TAG} range checked for the expected action"}]
                if criterion.severe_error_enabled and h % 5 == 0:
                    result["severe_error"] = True
                    result["severe_error_reason"] = f"{MOCK_TAG} Placeholder severe-error flag. Not an AI judgement."
            results.append(result)

        return {"contract_version": CONTRACT_VERSION, "evaluation_id": request.evaluation_id,
                "conversation_id": request.conversation.conversation_id,
                "checklist_id": request.checklist.checklist_id, "checklist_version": request.checklist.version,
                "model": {"name": "dev-mock", "version": self.version}, "results": results}
