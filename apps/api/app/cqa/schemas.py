"""CQA domain and API models.

Conversations are stored exactly as the organizers' API delivered them (speaker roles, raw timestamps, text);
derived fields (message ids, offsets) are added next to the originals, never in place of them.

The AI integration contract (what the evaluator receives and must return) lives in ``contract.py``.
"""

from __future__ import annotations

import re
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

from app.storage.paths import ID_PATTERN

# ---------------------------------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------------------------------

Speaker = Literal["client", "operator", "bot", "system", "unknown"]
Channel = Literal["chat", "voice"]
ConversationSource = Literal["organizer_api", "fixture"]
SPEAKERS: tuple[Speaker, ...] = ("client", "operator", "bot", "system", "unknown")

CONVERSATION_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
GROUP_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
CRITERION_ID_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,47}$"
MESSAGE_ID_PATTERN = r"^m[1-9][0-9]{0,5}$"


class Message(BaseModel):
    """One transcript line. ``id`` is stable: ``m{n}`` is the n-th line (1-based) of the source transcript."""

    id: str = Field(pattern=MESSAGE_ID_PATTERN)
    index: int = Field(ge=0)
    speaker: Speaker
    speaker_raw: str = Field(description="Speaker exactly as received.")
    text: str
    timestamp: str = Field(description="Timestamp exactly as received (MM:SS for chats, ISO 8601 for calls).")
    offset_seconds: float | None = Field(
        default=None,
        description="Seconds from the start of the conversation. Chats: MM:SS. Calls: time since the first line.")
    at: str | None = Field(default=None, description="Absolute instant (ISO 8601) when the source gives one.")


class ConversationRecord(BaseModel):
    """What is persisted per conversation."""

    id: str = Field(pattern=CONVERSATION_ID_PATTERN, description="The organizers' conversation_id.")
    group_ids: list[str]
    channel: Channel
    channel_raw: str
    language: str = Field(description="RU, KZ or EN when recognized; otherwise the raw value, upper-cased.")
    language_raw: str
    audio_url: str | None = None
    source: ConversationSource
    messages: list[Message]
    transcript_hash: str
    revision: int = 1
    imported_at: str
    updated_at: str
    warnings: list[str] = []


class EvaluationBrief(BaseModel):
    id: str
    conversation_id: str
    status: Literal["pending", "running", "completed", "failed"]
    checklist_id: str
    checklist_name: str
    checklist_version: int
    evaluator: str
    is_mock: bool
    original_total: float | None = None
    final_total: float | None = None
    max_score: float | None = None
    score_status: str | None = None
    severe_errors: int = 0
    overridden: bool = False
    created_at: str
    completed_at: str | None = None
    stale: bool = Field(default=False, description="The transcript changed after this evaluation ran.")


class ConversationSummary(BaseModel):
    id: str
    group_ids: list[str]
    channel: Channel
    channel_raw: str
    language: str
    source: ConversationSource
    has_audio: bool
    message_count: int
    speaker_counts: dict[str, int]
    duration_seconds: float | None
    preview: str
    imported_at: str
    updated_at: str
    revision: int
    latest_evaluation: EvaluationBrief | None = None
    open_appeals: int = 0


class ConversationDetail(ConversationSummary):
    audio_url: str | None
    messages: list[Message]
    transcript_hash: str
    warnings: list[str]
    evaluations: list[EvaluationBrief]


class Facet(BaseModel):
    value: str
    count: int


class ConversationPage(BaseModel):
    items: list[ConversationSummary]
    total: int
    page: int
    page_size: int
    facets: dict[str, list[Facet]]


class ImportRequest(BaseModel):
    group_id: str = Field(pattern=GROUP_ID_PATTERN, examples=["DEV"])
    source: ConversationSource = "organizer_api"


class ImportIssue(BaseModel):
    severity: Literal["error", "warning"]
    code: str
    message: str
    record_index: int | None = None
    conversation_id: str | None = None


class ImportRun(BaseModel):
    id: str
    group_id: str
    source: ConversationSource
    status: Literal["completed", "partial", "failed"]
    started_at: str
    finished_at: str
    reported_total: int | None = Field(default=None, description="total_records as reported by the source.")
    received: int = 0
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    rejected: int = 0
    conversation_ids: list[str] = []
    issues: list[ImportIssue] = []
    error: str | None = None


class AudioInfo(BaseModel):
    status: Literal["ready", "player_only", "unavailable"]
    stream_url: str | None = Field(default=None, description="Direct audio URL the browser can play (short-lived).")
    player_url: str | None = Field(default=None,
                                   description="The original audio_url (an organizer-hosted player page).")
    content_type: str | None = None
    message: str | None = None
    offset_basis: str = "Offsets are measured from the first transcript line; the recording may start earlier."


# ---------------------------------------------------------------------------------------------------
# Checklists
# ---------------------------------------------------------------------------------------------------

AnswerType = Literal["binary", "scale", "options"]
RoundingMode = Literal["half_up", "half_even", "floor", "ceil", "none"]
ChecklistOrigin = Literal["custom", "official", "dev_sample"]


class ScaleConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min: float = 0
    max: float = 5
    step: float = 1
    labels: dict[str, str] = Field(default_factory=dict,
                                   description="Optional labels per scale point, keyed by the value as text.")

    @model_validator(mode="after")
    def _check(self) -> ScaleConfig:
        if self.max <= self.min:
            raise ValueError("Scale max must be greater than min.")
        if self.step <= 0:
            raise ValueError("Scale step must be positive.")
        points = (self.max - self.min) / self.step
        if abs(points - round(points)) > 1e-9:
            raise ValueError("(max − min) must be a whole number of steps.")
        if round(points) > 100:
            raise ValueError("A scale may have at most 101 points.")
        return self

    def points(self) -> list[float]:
        count = round((self.max - self.min) / self.step)
        return [round(self.min + i * self.step, 10) for i in range(count + 1)]


class AnswerOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=CRITERION_ID_PATTERN)
    label: str = Field(min_length=1, max_length=120)
    points: float = Field(ge=0, le=1000)


class Criterion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=CRITERION_ID_PATTERN, description="Stable key; evaluations and appeals refer to it.")
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000, description="What the evaluator must check.")
    section_id: str | None = None
    weight: float = Field(gt=0, le=1000)
    answer_type: AnswerType = "binary"
    scale: ScaleConfig | None = None
    options: list[AnswerOption] | None = None
    na_allowed: bool = False
    na_rule: str = Field(default="", max_length=2000, description="When N/A applies.")
    severe_error_enabled: bool = False
    severe_error_rule: str = Field(default="", max_length=2000, description="What counts as a severe error.")

    @model_validator(mode="after")
    def _check_type(self) -> Criterion:
        if self.answer_type == "scale":
            if self.scale is None:
                self.scale = ScaleConfig()
            self.options = None
        elif self.answer_type == "options":
            if not self.options or len(self.options) < 2:
                raise ValueError(f"Criterion '{self.id}': an options answer needs at least two options.")
            if len(self.options) > 12:
                raise ValueError(f"Criterion '{self.id}': at most 12 options.")
            if len({o.id for o in self.options}) != len(self.options):
                raise ValueError(f"Criterion '{self.id}': option ids must be unique.")
            if max(o.points for o in self.options) <= 0:
                raise ValueError(f"Criterion '{self.id}': at least one option must score above zero.")
            self.scale = None
        else:
            self.scale = None
            self.options = None
        return self


class Section(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=CRITERION_ID_PATTERN)
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)


class RoundingRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: RoundingMode = "half_up"
    digits: int = Field(default=1, ge=0, le=4)


class ScoringRules(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_score: float = Field(default=100, gt=0, le=10_000)
    rounding: RoundingRule = Field(default_factory=RoundingRule)
    severe_error_policy: Literal["flag_only", "zero_total"] = Field(
        default="flag_only",
        description="flag_only: severe errors are reported next to the score. zero_total: any severe error sets "
                    "the total to 0. Set it from the official checklist.")
    na_policy: Literal["redistribute"] = Field(
        default="redistribute",
        description="N/A criteria are removed and their weight is shared proportionally by the applicable ones.")


class ChecklistConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sections: list[Section] = []
    criteria: list[Criterion] = Field(min_length=1, max_length=60)
    scoring: ScoringRules = Field(default_factory=ScoringRules)

    @model_validator(mode="after")
    def _check_refs(self) -> ChecklistConfig:
        ids = [c.id for c in self.criteria]
        duplicates = sorted({i for i in ids if ids.count(i) > 1})
        if duplicates:
            raise ValueError(f"Criterion ids must be unique: {', '.join(duplicates)}.")
        section_ids = [s.id for s in self.sections]
        if len(set(section_ids)) != len(section_ids):
            raise ValueError("Section ids must be unique.")
        unknown = sorted({c.section_id for c in self.criteria if c.section_id and c.section_id not in section_ids})
        if unknown:
            raise ValueError(f"Unknown section id(s): {', '.join(unknown)}.")
        return self

    def criterion(self, criterion_id: str) -> Criterion | None:
        return next((c for c in self.criteria if c.id == criterion_id), None)


class Replacement(BaseModel):
    old_id: str
    new_id: str
    old_name: str
    new_name: str


class ChecklistVersion(BaseModel):
    version: int = Field(ge=1)
    created_at: str
    note: str = ""
    config: ChecklistConfig
    config_hash: str
    replacements: list[Replacement] = []


class Checklist(BaseModel):
    id: str = Field(pattern=ID_PATTERN)
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    origin: ChecklistOrigin = "custom"
    archived: bool = False
    created_at: str
    updated_at: str
    latest_version: int
    duplicated_from: str | None = None
    versions: list[ChecklistVersion]

    def version(self, number: int | None = None) -> ChecklistVersion:
        target = number or self.latest_version
        for version in self.versions:
            if version.version == target:
                return version
        raise KeyError(target)


class ChecklistSummary(BaseModel):
    id: str
    name: str
    description: str
    origin: ChecklistOrigin
    archived: bool
    latest_version: int
    versions: int
    criteria: int
    sections: int
    total_weight: float
    created_at: str
    updated_at: str
    evaluations: int = 0


class ChecklistCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    origin: ChecklistOrigin = "custom"
    config: ChecklistConfig
    note: str = Field(default="", max_length=500)


class ChecklistUpdate(BaseModel):
    """Save edits. A changed configuration always becomes a new version; metadata edits do not."""

    base_version: int = Field(ge=1, description="The version the edits started from (stale-edit protection).")
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)
    origin: ChecklistOrigin | None = None
    archived: bool | None = None
    config: ChecklistConfig | None = None
    note: str = Field(default="", max_length=500)


class ChecklistDuplicate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    version: int | None = Field(default=None, ge=1, description="Version to copy (default: latest).")


class CriterionReplace(BaseModel):
    base_version: int = Field(ge=1)
    criterion: Criterion = Field(description="The new criterion. It takes the replaced criterion's position.")
    note: str = Field(default="", max_length=500)


class ChecklistImport(BaseModel):
    """A checklist as exported by GET /cqa/checklists/{id}/export (or written by hand)."""

    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)
    origin: ChecklistOrigin = "custom"
    config: ChecklistConfig


# ---------------------------------------------------------------------------------------------------
# Scores (computed by scoring.py only)
# ---------------------------------------------------------------------------------------------------

CriterionStatus = Literal["scored", "na", "missing", "invalid"]


class CriterionScore(BaseModel):
    criterion_id: str
    name: str
    section_id: str | None
    answer_type: AnswerType
    status: CriterionStatus
    raw_score: float | None = Field(description="Points on the criterion's own scale (binary 0/1, scale value, "
                                                "option points).")
    raw_max: float | None
    normalized: float | None = Field(description="0–1 after normalizing to the criterion's scale.")
    weight: float = Field(description="Configured weight.")
    effective_weight: float = Field(description="Share of the total after N/A redistribution (0–1).")
    points: float | None = Field(description="Contribution to the total (unrounded).")
    max_points: float
    severe_error: bool
    issue: str | None = None


class SectionScore(BaseModel):
    section_id: str
    name: str
    status: Literal["scored", "na", "incomplete"]
    score: float | None = Field(description="Section subtotal on the 0–max_score scale (rounded).")
    score_unrounded: float | None
    points: float | None = Field(description="The section's contribution to the total (rounded).")
    max_points: float
    weight: float
    effective_weight: float
    criteria_ids: list[str]
    severe_errors: list[str]


class ScoreBreakdown(BaseModel):
    status: Literal["scored", "not_applicable", "incomplete"]
    total: float | None
    total_unrounded: float | None
    total_before_severe_policy: float | None
    max_score: float
    rounding: RoundingRule
    severe_error_policy: str
    severe_errors: list[str]
    severe_error_applied: bool
    applicable_weight: float
    total_weight: float
    criteria: list[CriterionScore]
    sections: list[SectionScore]
    issues: list[str]


# ---------------------------------------------------------------------------------------------------
# Evaluations
# ---------------------------------------------------------------------------------------------------

EvaluationStatus = Literal["pending", "running", "completed", "failed"]
# Strict members: JSON 1 must stay the number 1 (a valid scale point), never become true.
AnswerValue = StrictBool | StrictInt | StrictFloat | StrictStr | None


class EvidenceRef(BaseModel):
    """A pointer to a real transcript line, with the excerpt taken from the transcript (never from the model)."""

    message_id: str
    message_index: int
    speaker: Speaker
    timestamp: str
    offset_seconds: float | None
    excerpt: str
    char_start: int | None = None
    char_end: int | None = None
    quote_matched: bool = Field(description="True when the evaluator's quote was found in the message.")


class InspectedSpan(BaseModel):
    start_message_id: str
    end_message_id: str
    start_index: int
    end_index: int
    message_count: int
    note: str = ""


class CriterionResult(BaseModel):
    criterion_id: str
    value: AnswerValue = None
    is_na: bool = False
    na_reason: str | None = None
    explanation: str = ""
    evidence: list[EvidenceRef] = []
    inspected_spans: list[InspectedSpan] = []
    severe_error: bool = False
    severe_error_reason: str | None = None
    model_raw_score: float | None = Field(default=None,
                                          description="The evaluator's own score claim. Recorded, never used.")
    source: Literal["evaluator", "reviewer"] = "evaluator"


class EvaluatorInfo(BaseModel):
    name: str
    label: str
    version: str = ""
    is_mock: bool
    description: str = ""
    available: bool = True
    contract_version: str


class EvaluationError(BaseModel):
    code: str
    message: str
    issues: list[str] = []


class Override(BaseModel):
    criterion_id: str
    appeal_id: str
    result: CriterionResult
    reviewer: str
    explanation: str
    decided_at: str


class EvaluationRecord(BaseModel):
    id: str = Field(pattern=ID_PATTERN)
    conversation_id: str
    checklist_id: str
    checklist_name: str
    checklist_version: int
    checklist: ChecklistConfig = Field(description="Snapshot of the configuration used, for reproducibility.")
    transcript_hash: str
    evaluator: EvaluatorInfo
    status: EvaluationStatus
    batch_id: str | None = None
    error: EvaluationError | None = None
    created_at: str
    updated_at: str
    started_at: str | None = None
    completed_at: str | None = None
    original_results: list[CriterionResult] = []
    original_score: ScoreBreakdown | None = None
    overrides: list[Override] = []
    final_score: ScoreBreakdown | None = None
    warnings: list[str] = []
    model_info: dict[str, str] = {}
    raw_output: dict | None = Field(default=None, description="The evaluator's response, kept for audit.")


class EvaluationSummary(EvaluationBrief):
    conversation_language: str | None = None
    conversation_channel: str | None = None
    batch_id: str | None = None
    error: EvaluationError | None = None
    started_at: str | None = None


class EvaluationPage(BaseModel):
    items: list[EvaluationSummary]
    total: int
    page: int
    page_size: int


class CriterionView(BaseModel):
    """Everything the results screen needs for one criterion, original next to final."""

    criterion: Criterion
    original: CriterionResult | None
    final: CriterionResult | None
    original_score: CriterionScore | None
    final_score: CriterionScore | None
    overridden: bool
    appeals: list[str] = Field(default=[], description="Appeal ids for this criterion, newest first.")


class EvaluateRequest(BaseModel):
    checklist_id: str = Field(pattern=ID_PATTERN)
    checklist_version: int | None = Field(default=None, ge=1, description="Default: the latest version.")
    conversation_ids: list[str] | None = Field(default=None, max_length=1000,
                                               description="Explicit conversations. Omit to use the scope below.")
    group_id: str | None = Field(default=None, pattern=GROUP_ID_PATTERN,
                                 description="Scope: only conversations imported with this group.")
    only_missing: bool = Field(default=False,
                               description="Skip conversations that already have a completed or queued evaluation "
                                           "with this checklist version.")
    adapter: str | None = Field(default=None, max_length=64, description="Default: ATLAS_CQA_EVALUATOR.")

    @field_validator("conversation_ids")
    @classmethod
    def _ids(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        pattern = re.compile(CONVERSATION_ID_PATTERN)
        bad = [v for v in value if not pattern.fullmatch(v)]
        if bad:
            raise ValueError(f"Invalid conversation id(s): {', '.join(bad[:5])}")
        return list(dict.fromkeys(value))


class BatchStatus(BaseModel):
    batch_id: str
    total: int
    pending: int
    running: int
    completed: int
    failed: int
    done: bool
    evaluation_ids: list[str]


class EvaluateResponse(BaseModel):
    batch_id: str
    queued: int
    skipped: int
    evaluations: list[EvaluationBrief]


# ---------------------------------------------------------------------------------------------------
# Appeals and audit
# ---------------------------------------------------------------------------------------------------

AppealStatus = Literal["pending", "confirmed", "overridden"]


class AppealCreate(BaseModel):
    evaluation_id: str = Field(pattern=ID_PATTERN)
    criterion_id: str = Field(pattern=CRITERION_ID_PATTERN)
    comment: str = Field(min_length=3, max_length=2000)
    submitted_by: str = Field(default="Operator", min_length=1, max_length=120)


class OverrideAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: AnswerValue = None
    is_na: bool = False
    na_reason: str | None = Field(default=None, max_length=2000)
    severe_error: bool = False
    severe_error_reason: str | None = Field(default=None, max_length=2000)


class AppealDecisionIn(BaseModel):
    decision: Literal["confirm", "override"]
    explanation: str = Field(min_length=3, max_length=4000, description="Mandatory reason for the decision.")
    reviewer: str = Field(default="Reviewer", min_length=1, max_length=120)
    override: OverrideAnswer | None = None

    @model_validator(mode="after")
    def _needs_override(self) -> AppealDecisionIn:
        if self.decision == "override" and self.override is None:
            raise ValueError("An override decision needs the new answer.")
        if self.decision == "confirm":
            self.override = None
        return self


class AppealDecision(BaseModel):
    decision: Literal["confirm", "override"]
    explanation: str
    reviewer: str
    decided_at: str
    previous_result: CriterionResult | None
    new_result: CriterionResult | None
    total_before: float | None
    total_after: float | None


class Appeal(BaseModel):
    id: str = Field(pattern=ID_PATTERN)
    evaluation_id: str
    conversation_id: str
    checklist_id: str
    checklist_version: int
    criterion_id: str
    criterion_name: str
    comment: str
    submitted_by: str
    created_at: str
    updated_at: str
    status: AppealStatus
    disputed_result: CriterionResult | None
    disputed_points: float | None
    disputed_max_points: float | None
    total_at_submission: float | None
    decision: AppealDecision | None = None


class AuditEvent(BaseModel):
    id: str
    at: str
    type: str
    actor: str
    summary: str
    conversation_id: str | None = None
    evaluation_id: str | None = None
    checklist_id: str | None = None
    appeal_id: str | None = None
    details: dict = {}


class EvaluationDetail(BaseModel):
    evaluation: EvaluationRecord
    criteria: list[CriterionView]
    final_results: list[CriterionResult]
    stale: bool
    appeals: list[Appeal]
    audit: list[AuditEvent]


class AppealDetail(BaseModel):
    appeal: Appeal
    criterion: Criterion
    evaluation: EvaluationSummary
    current_result: CriterionResult | None
    current_score: CriterionScore | None
    original_score: CriterionScore | None
    context: list[Message] = Field(description="Transcript lines around the evidence (and the evidence itself).")
    evaluation_stale: bool
    audit: list[AuditEvent]


# ---------------------------------------------------------------------------------------------------
# Overview / info
# ---------------------------------------------------------------------------------------------------


class CriterionStat(BaseModel):
    criterion_id: str
    name: str
    evaluated: int
    scored: int
    na: int
    severe: int
    mean_normalized: float | None


class ScoreBin(BaseModel):
    start: float
    end: float
    count: int


class Overview(BaseModel):
    conversations: int
    by_language: list[Facet]
    by_channel: list[Facet]
    by_group: list[Facet]
    by_source: list[Facet]
    evaluated_conversations: int
    evaluations_by_status: list[Facet]
    mean_final_score: float | None
    max_score: float | None
    score_bins: list[ScoreBin]
    severe_error_conversations: int
    appeals_pending: int
    appeals_decided: int
    overridden_criteria: int
    checklist_id: str | None
    checklist_name: str | None
    checklist_version: int | None
    criterion_stats: list[CriterionStat]
    mock_results: int = Field(description="Latest evaluations produced by the development mock.")
    recent_imports: list[ImportRun]
    recent_activity: list[AuditEvent]


class CqaInfo(BaseModel):
    source_configured: bool
    fixtures_enabled: bool
    fixture_groups: list[str]
    default_evaluator: str
    evaluators: list[EvaluatorInfo]
    contract_version: str
