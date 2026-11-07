"""GPT reassessment of an appealed criterion (an internal format, not the official JSON 1.0 submission).

When a criterion is appealed, the backend makes a new, separate request to the reassessor adapter (GPT) with:
the original transcript (1-based turns, every speaker), the disputed criterion exactly as configured in the
checklist version of the original evaluation, the disputed result (value, rationale, evidence turns, critical
flag), and the appeal's explanation. Nothing else about the project or the people involved is sent.

The adapter returns::

    {"recommendation": "change", "original_value": 5, "recommended_value": 10,
     "rationale": "...", "evidence_turns": [4, 6, 8]}

(plus ``critical_error`` when the criterion is weighted and may carry a critical-error flag). ``check_reassessment``
validates that answer against the stored configuration. The adapter uses it to send problems back to the model
once; the appeal service runs it again on whatever the adapter returns, so an adapter can never slip an invalid
value or evidence turn into an appeal. GPT only recommends: the manager decides, and the scoring engine computes
every number.
"""

from __future__ import annotations

from fractions import Fraction
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.cqa.contract import MAX_EVIDENCE, RequestConversation, RequestMessage
from app.cqa.schemas import (
    AnswerValue,
    Appeal,
    ConversationRecord,
    Criterion,
    CriterionResult,
    EvaluationRecord,
    ExplanationLanguage,
)
from app.cqa.scoring import AnswerError, answer_score

MAX_RATIONALE_CHARS = 3000


class DisputedResult(BaseModel):
    """The result under appeal, as the model sees it."""

    value: AnswerValue = None
    is_na: bool = False
    rationale: str = ""
    evidence_turns: list[int] = []
    critical_error: bool = False
    source: Literal["evaluator", "reviewer"] = "evaluator"


class ReassessmentRequest(BaseModel):
    reassessment_id: str
    appeal_id: str
    evaluation_id: str
    checklist_id: str
    checklist_name: str
    checklist_version: int
    section_name: str | None = None
    conversation: RequestConversation
    criterion: Criterion = Field(description="As configured in the evaluation's checklist version.")
    disputed: DisputedResult
    appeal_explanation: str
    explanation_language: ExplanationLanguage = "en"


def flag_allowed(criterion: Criterion) -> bool:
    """A weighted criterion on which a critical error may be flagged (an indicator's value is its own flag)."""
    return criterion.severe_error_enabled and not criterion.is_indicator


def same_value(a: object, b: object) -> bool:
    """Answer equality: true/false never equal 1/0, and 5 equals 5.0."""
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return Fraction(str(a)) == Fraction(str(b))
    return isinstance(a, str) and isinstance(b, str) and a == b


def _fold(text: str) -> str:
    return " ".join(text.casefold().split())


def build_reassessment_request(*, reassessment_id: str, appeal: Appeal, record: EvaluationRecord,
                               conversation: ConversationRecord, criterion: Criterion,
                               language: ExplanationLanguage) -> ReassessmentRequest:
    disputed: CriterionResult | None = appeal.disputed_result
    section = next((s.name for s in record.checklist.sections if s.id == criterion.section_id), None)
    return ReassessmentRequest(
        reassessment_id=reassessment_id, appeal_id=appeal.id, evaluation_id=record.id,
        checklist_id=record.checklist_id, checklist_name=record.checklist_name,
        checklist_version=record.checklist_version, section_name=section,
        conversation=RequestConversation(
            conversation_id=conversation.id, language=conversation.language, channel=conversation.channel,
            channel_raw=conversation.channel_raw, audio_url=None,
            messages=[RequestMessage(id=m.id, index=m.index, speaker=m.speaker, timestamp=m.timestamp,
                                     offset_seconds=m.offset_seconds, text=m.text) for m in conversation.messages]),
        criterion=criterion,
        disputed=DisputedResult(
            value=disputed.value if disputed else None, is_na=disputed.is_na if disputed else False,
            rationale=(disputed.explanation or disputed.na_reason or "") if disputed else "",
            evidence_turns=sorted({ref.message_index + 1 for ref in disputed.evidence}) if disputed else [],
            critical_error=bool(disputed and disputed.severe_error and flag_allowed(criterion)),
            source=disputed.source if disputed else "evaluator"),
        appeal_explanation=appeal.comment, explanation_language=language)


def check_reassessment(request: ReassessmentRequest, payload: object) -> tuple[dict[str, Any] | None, list[str]]:
    """The validated recommendation, or every problem found (then nothing is usable)."""
    if not isinstance(payload, dict):
        return None, ["The answer must be a JSON object."]
    criterion = request.criterion
    turns = {m.index + 1 for m in request.conversation.messages}
    issues: list[str] = []

    recommendation = payload.get("recommendation")
    if recommendation not in ("uphold", "change"):
        issues.append('recommendation must be "uphold" or "change".')

    if "original_value" not in payload:
        issues.append("original_value is missing.")
    elif not same_value(payload["original_value"], request.disputed.value):
        issues.append(f"original_value must repeat the disputed value ({request.disputed.value!r}) exactly.")

    value = payload.get("recommended_value")
    if "recommended_value" not in payload:
        issues.append("recommended_value is missing.")
    elif value is None:
        if not criterion.na_allowed:
            issues.append("recommended_value null (N/A) is not allowed for this criterion.")
    else:
        try:
            answer_score(criterion, value)
        except AnswerError as error:
            issues.append(f"recommended_value: {error}")

    rationale = payload.get("rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        issues.append("rationale is missing.")
        rationale = ""
    elif len(rationale) > MAX_RATIONALE_CHARS:
        issues.append(f"rationale is longer than {MAX_RATIONALE_CHARS} characters.")
    elif request.disputed.rationale.strip() and _fold(rationale) == _fold(request.disputed.rationale):
        issues.append("rationale repeats the original rationale; explain how the appeal's points hold up against "
                      "the transcript.")

    cited: list[int] = []
    raw_turns = payload.get("evidence_turns")
    if not isinstance(raw_turns, list) or any(isinstance(t, bool) or not isinstance(t, int) for t in raw_turns):
        issues.append("evidence_turns must be a list of turn numbers.")
    else:
        outside = [t for t in raw_turns if t not in turns]
        if outside:
            issues.append(f"evidence_turns {outside} do not exist (the transcript has turns 1–{len(turns)}).")
        cited = list(dict.fromkeys(t for t in raw_turns if t in turns))
        if len(cited) > MAX_EVIDENCE:
            issues.append(f"at most {MAX_EVIDENCE} evidence turns.")
        if value is not None and not raw_turns:
            issues.append("needs at least one evidence turn.")

    critical = payload.get("critical_error", False)
    if not isinstance(critical, bool):
        issues.append("critical_error must be true or false.")
        critical = False
    elif critical:
        if not flag_allowed(criterion):
            issues.append("critical_error is not enabled for this criterion.")
        elif value is None:
            issues.append("an N/A answer cannot carry a critical error.")

    if not issues:
        unchanged = same_value(value, request.disputed.value) and (
            not flag_allowed(criterion) or critical == request.disputed.critical_error)
        if recommendation == "uphold" and not unchanged:
            issues.append('recommendation is "uphold" but the recommended answer differs from the original; use '
                          '"change" or repeat the original answer.')
        elif recommendation == "change" and unchanged:
            issues.append('recommendation is "change" but the recommended answer is the original one; use '
                          '"uphold" or recommend a different allowed value.')
    if issues:
        return None, issues
    return {"recommendation": recommendation, "original_value": request.disputed.value,
            "recommended_value": value, "recommended_is_na": value is None,
            "recommended_critical_error": bool(critical and flag_allowed(criterion) and value is not None),
            "rationale": rationale.strip(), "evidence_turns": cited}, []
