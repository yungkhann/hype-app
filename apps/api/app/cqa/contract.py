"""The evaluator integration contract (version ``cqa-eval/1``).

An evaluator adapter receives an :class:`EvaluationRequest` and returns a :class:`ModelOutput` (or the same
shape as a plain dict / JSON). The backend then:

1. parses the output strictly (unknown fields, wrong types, and coerced values are rejected);
2. checks it answers every criterion of the requested checklist version exactly once;
3. checks every evidence reference points at a real message, and that a quoted excerpt really occurs in it;
4. checks N/A and severe-error flags are allowed for that criterion and carry a reason;
5. hands the *answers* to the scoring engine (``scoring.py``). A score the evaluator states (``raw_score``) is
   stored for comparison and never used.

Any violation fails the evaluation with the list of problems; nothing partial is saved as a result.
See docs/cqa-model-contract.md for the narrative version and full examples.
"""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr, ValidationError

from app.cqa.schemas import (
    MESSAGE_ID_PATTERN,
    Channel,
    ConversationRecord,
    Criterion,
    CriterionResult,
    EvidenceRef,
    InspectedSpan,
    Message,
    ScoringRules,
    Section,
    Speaker,
)
from app.cqa.scoring import AnswerError, answer_score

CONTRACT_VERSION = "cqa-eval/1"
MAX_EVIDENCE = 20
MAX_SPANS = 10
EXCERPT_CHARS = 600

# ---------------------------------------------------------------------------------------------------
# Request: what the evaluator receives
# ---------------------------------------------------------------------------------------------------


class RequestMessage(BaseModel):
    id: str = Field(description="Stable message id (m1, m2, …). Evidence must use these ids.")
    index: int
    speaker: Speaker
    timestamp: str = Field(description="Original timestamp: MM:SS for chats, ISO 8601 for calls.")
    offset_seconds: float | None
    text: str


class RequestConversation(BaseModel):
    conversation_id: str
    language: str = Field(description="RU, KZ or EN.")
    channel: Channel
    channel_raw: str
    audio_url: str | None = Field(description="Recording player page for calls; null for chats.")
    messages: list[RequestMessage]


class RequestChecklist(BaseModel):
    checklist_id: str
    version: int
    name: str
    sections: list[Section]
    criteria: list[Criterion]
    scoring: ScoringRules = Field(description="For information only: the backend computes all scores.")


class EvaluationRules(BaseModel):
    evaluated_speaker: Literal["operator"] = "operator"
    context_speakers: list[Speaker] = ["client", "bot", "system"]
    answer_formats: dict[str, str] = {
        "binary": "true (criterion met) or false",
        "scale": "a number on the criterion's scale: min ≤ value ≤ max, on the step grid",
        "options": "the id of one of the criterion's options",
    }
    evidence: str = ("Every non-N/A result needs at least one evidence reference (message_id, optional verbatim "
                     "quote) or, when an expected action is missing, an inspected span (start/end message ids) "
                     "showing which part of the conversation was checked.")
    not_applicable: str = ("Set is_na=true with na_reason only when the criterion allows N/A (na_allowed) and its "
                           "na_rule applies; value must then be null.")
    severe_error: str = ("Set severe_error=true with severe_error_reason only for criteria with "
                         "severe_error_enabled.")


class EvaluationRequest(BaseModel):
    contract_version: Literal["cqa-eval/1"] = CONTRACT_VERSION
    evaluation_id: str
    conversation: RequestConversation
    checklist: RequestChecklist
    rules: EvaluationRules = Field(default_factory=EvaluationRules)


# ---------------------------------------------------------------------------------------------------
# Output: what the evaluator must return
# ---------------------------------------------------------------------------------------------------

_STRICT = ConfigDict(extra="forbid")


class ModelEvidence(BaseModel):
    model_config = _STRICT

    message_id: StrictStr = Field(pattern=MESSAGE_ID_PATTERN)
    quote: StrictStr | None = Field(default=None, max_length=2000,
                                    description="Verbatim text from that message (optional but recommended).")


class ModelSpan(BaseModel):
    model_config = _STRICT

    start_message_id: StrictStr = Field(pattern=MESSAGE_ID_PATTERN)
    end_message_id: StrictStr = Field(pattern=MESSAGE_ID_PATTERN)
    note: StrictStr = Field(default="", max_length=500)


class ModelCriterionResult(BaseModel):
    model_config = _STRICT

    criterion_id: StrictStr
    value: StrictBool | StrictInt | StrictFloat | StrictStr | None = None
    raw_score: StrictInt | StrictFloat | None = Field(default=None,
                                                      description="Optional. Recorded, never used for scoring.")
    is_na: StrictBool = False
    na_reason: StrictStr | None = Field(default=None, max_length=2000)
    explanation: StrictStr = Field(min_length=1, max_length=4000)
    evidence: list[ModelEvidence] = Field(default=[], max_length=MAX_EVIDENCE)
    inspected_spans: list[ModelSpan] = Field(default=[], max_length=MAX_SPANS)
    severe_error: StrictBool = False
    severe_error_reason: StrictStr | None = Field(default=None, max_length=2000)


class ModelInfo(BaseModel):
    model_config = _STRICT

    name: StrictStr = Field(max_length=120)
    version: StrictStr = Field(default="", max_length=120)


class ModelOutput(BaseModel):
    model_config = _STRICT

    contract_version: StrictStr
    evaluation_id: StrictStr
    conversation_id: StrictStr
    checklist_id: StrictStr
    checklist_version: StrictInt
    model: ModelInfo | None = None
    results: list[ModelCriterionResult] = Field(max_length=60)


# ---------------------------------------------------------------------------------------------------
# Building requests and validating output
# ---------------------------------------------------------------------------------------------------


class ContractViolation(Exception):
    """The evaluator's output broke the contract. ``issues`` lists every problem found."""

    def __init__(self, issues: list[str]) -> None:
        super().__init__("; ".join(issues[:3]))
        self.issues = issues


class ValidatedOutput(BaseModel):
    results: list[CriterionResult]
    warnings: list[str]
    model_info: dict[str, str]


def build_request(evaluation_id: str, conversation: ConversationRecord, checklist_id: str, checklist_name: str,
                  version: int, config) -> EvaluationRequest:
    return EvaluationRequest(
        evaluation_id=evaluation_id,
        conversation=RequestConversation(
            conversation_id=conversation.id, language=conversation.language, channel=conversation.channel,
            channel_raw=conversation.channel_raw, audio_url=conversation.audio_url,
            messages=[RequestMessage(id=m.id, index=m.index, speaker=m.speaker, timestamp=m.timestamp,
                                     offset_seconds=m.offset_seconds, text=m.text) for m in conversation.messages]),
        checklist=RequestChecklist(checklist_id=checklist_id, version=version, name=checklist_name,
                                   sections=config.sections, criteria=config.criteria, scoring=config.scoring),
    )


def _fold(text: str) -> tuple[str, list[int]]:
    """Case-folded text with whitespace runs collapsed, plus the original index of every folded character."""
    out: list[str] = []
    origin: list[int] = []
    previous_space = False
    for index, char in enumerate(text):
        if char.isspace():
            if previous_space or not out:
                continue
            out.append(" ")
            origin.append(index)
            previous_space = True
            continue
        previous_space = False
        for folded in char.casefold():
            out.append(folded)
            origin.append(index)
    while out and out[-1] == " ":
        out.pop()
        origin.pop()
    return "".join(out), origin


def locate_quote(text: str, quote: str) -> tuple[int, int] | None:
    """Where ``quote`` occurs in ``text``: exactly, or ignoring case and whitespace differences."""
    cleaned = quote.strip().strip("\"'«»“”„").strip()
    for suffix in ("...", "…"):
        if cleaned.endswith(suffix):
            cleaned = cleaned[: -len(suffix)].rstrip()
    if not cleaned:
        return None
    position = text.find(cleaned)
    if position >= 0:
        return position, position + len(cleaned)
    folded_text, origin = _fold(text)
    folded_quote, _ = _fold(cleaned)
    position = folded_text.find(folded_quote)
    if position < 0 or not folded_quote:
        return None
    start = origin[position]
    end = origin[position + len(folded_quote) - 1] + 1
    return start, end


def evidence_ref(message: Message, start: int | None = None, end: int | None = None,
                 matched: bool = False) -> EvidenceRef:
    if start is None or end is None:
        start, end = 0, min(len(message.text), EXCERPT_CHARS)
    return EvidenceRef(message_id=message.id, message_index=message.index, speaker=message.speaker,
                       timestamp=message.timestamp, offset_seconds=message.offset_seconds,
                       excerpt=message.text[start:end], char_start=start, char_end=end, quote_matched=matched)


def _errors(error: ValidationError) -> list[str]:
    issues = []
    for item in error.errors()[:50]:
        where = ".".join(str(part) for part in item.get("loc", ())) or "output"
        issues.append(f"{where}: {item.get('msg', 'invalid')}")
    return issues


def validate_output(request: EvaluationRequest, payload: object, messages: list[Message]) -> ValidatedOutput:
    if isinstance(payload, ModelOutput):
        payload = payload.model_dump()
    if not isinstance(payload, dict):
        raise ContractViolation([f"Output must be a JSON object, got {type(payload).__name__}."])
    try:
        output = ModelOutput.model_validate(payload)
    except ValidationError as error:
        raise ContractViolation(_errors(error)) from None

    issues: list[str] = []
    warnings: list[str] = []
    if output.contract_version != CONTRACT_VERSION:
        issues.append(f"contract_version is '{output.contract_version}', expected '{CONTRACT_VERSION}'.")
    if output.evaluation_id != request.evaluation_id:
        issues.append("evaluation_id does not match the request.")
    if output.conversation_id != request.conversation.conversation_id:
        issues.append("conversation_id does not match the request.")
    if output.checklist_id != request.checklist.checklist_id or output.checklist_version != request.checklist.version:
        issues.append("checklist_id / checklist_version do not match the request.")

    criteria = {c.id: c for c in request.checklist.criteria}
    by_message = {m.id: m for m in messages}
    seen: set[str] = set()
    results: list[CriterionResult] = []
    for index, item in enumerate(output.results):
        label = f"results[{index}] ({item.criterion_id})"
        criterion = criteria.get(item.criterion_id)
        if criterion is None:
            issues.append(f"{label}: unknown criterion id.")
            continue
        if item.criterion_id in seen:
            issues.append(f"{label}: criterion answered more than once.")
            continue
        seen.add(item.criterion_id)
        problems: list[str] = []

        if item.is_na:
            if not criterion.na_allowed:
                problems.append("N/A is not allowed for this criterion.")
            if not (item.na_reason or "").strip():
                problems.append("N/A needs na_reason.")
            if item.value is not None:
                problems.append("value must be null when is_na is true.")
        else:
            if item.value is None:
                problems.append("value is required unless is_na is true.")
            else:
                try:
                    raw, _, _ = answer_score(criterion, item.value)
                    if item.raw_score is not None and math.isfinite(item.raw_score) \
                            and abs(float(raw) - float(item.raw_score)) > 1e-9:
                        warnings.append(f"{criterion.id}: evaluator stated raw_score {item.raw_score:g}, the scoring "
                                        f"engine computed {float(raw):g} from the answer; the engine's value is used.")
                except AnswerError as error:
                    problems.append(str(error))
            if not item.evidence and not item.inspected_spans:
                problems.append("needs at least one evidence reference or inspected span.")

        evidence: list[EvidenceRef] = []
        for ref_index, ref in enumerate(item.evidence):
            message = by_message.get(ref.message_id)
            if message is None:
                problems.append(f"evidence[{ref_index}]: message {ref.message_id} does not exist.")
                continue
            if ref.quote is not None and ref.quote.strip():
                span = locate_quote(message.text, ref.quote)
                if span is None:
                    problems.append(f"evidence[{ref_index}]: quote not found in {ref.message_id}.")
                    continue
                evidence.append(evidence_ref(message, *span, matched=True))
            else:
                evidence.append(evidence_ref(message))

        spans: list[InspectedSpan] = []
        for span_index, span in enumerate(item.inspected_spans):
            start, end = by_message.get(span.start_message_id), by_message.get(span.end_message_id)
            if start is None or end is None:
                problems.append(f"inspected_spans[{span_index}]: unknown message id.")
                continue
            if start.index > end.index:
                problems.append(f"inspected_spans[{span_index}]: start is after end.")
                continue
            spans.append(InspectedSpan(start_message_id=start.id, end_message_id=end.id, start_index=start.index,
                                       end_index=end.index, message_count=end.index - start.index + 1,
                                       note=span.note))

        if item.severe_error:
            if not criterion.severe_error_enabled:
                problems.append("severe_error is not enabled for this criterion.")
            if not (item.severe_error_reason or "").strip():
                problems.append("severe_error needs severe_error_reason.")
            if item.is_na:
                problems.append("an N/A criterion cannot carry a severe error.")

        if problems:
            issues.extend(f"{label}: {problem}" for problem in problems)
            continue
        results.append(CriterionResult(
            criterion_id=criterion.id, value=None if item.is_na else item.value, is_na=item.is_na,
            na_reason=item.na_reason.strip() if item.is_na and item.na_reason else None,
            explanation=item.explanation.strip(), evidence=evidence, inspected_spans=spans,
            severe_error=item.severe_error,
            severe_error_reason=item.severe_error_reason.strip() if item.severe_error and item.severe_error_reason
            else None,
            model_raw_score=None if item.raw_score is None else float(item.raw_score), source="evaluator"))

    missing = [cid for cid in criteria if cid not in seen]
    if missing:
        issues.append(f"Missing results for: {', '.join(missing)}.")
    if issues:
        raise ContractViolation(issues)
    order = {c.id: i for i, c in enumerate(request.checklist.criteria)}
    results.sort(key=lambda r: order[r.criterion_id])
    model_info = {"name": output.model.name, "version": output.model.version} if output.model else {}
    return ValidatedOutput(results=results, warnings=warnings, model_info=model_info)


def contract_schema() -> dict:
    return {
        "contract_version": CONTRACT_VERSION,
        "request_schema": EvaluationRequest.model_json_schema(),
        "output_schema": ModelOutput.model_json_schema(),
    }
