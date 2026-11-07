"""CQA HTTP API, mounted at ``/api/v1/cqa``. Routes validate and pick status codes; services do the work."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Depends, Path, Query, Request, status
from fastapi.responses import JSONResponse

from app.api.deps import attachment
from app.cqa.contract import EvaluationRequest, contract_schema
from app.cqa.examples import example_output, example_request
from app.cqa.schemas import (
    CONVERSATION_ID_PATTERN,
    CRITERION_ID_PATTERN,
    GROUP_ID_PATTERN,
    TEMPLATE_ID_PATTERN,
    Appeal,
    AppealCreate,
    AppealDecisionIn,
    AppealDetail,
    AudioInfo,
    AuditEvent,
    BatchStatus,
    Checklist,
    ChecklistCreate,
    ChecklistDuplicate,
    ChecklistFromTemplate,
    ChecklistImport,
    ChecklistSummary,
    ChecklistTemplate,
    ChecklistTemplateSummary,
    ChecklistUpdate,
    ChecklistValidation,
    ChecklistVersionDetail,
    ChecklistVersionSummary,
    ConversationDetail,
    ConversationPage,
    ConversationRecord,
    CqaInfo,
    CriterionReplace,
    EvaluateRequest,
    EvaluateResponse,
    EvaluationDetail,
    EvaluationPage,
    ImportRequest,
    ImportRun,
    Overview,
)
from app.cqa.service import CqaService, SortKey
from app.schemas.common import Deleted
from app.storage.paths import ID_PATTERN

router = APIRouter(prefix="/cqa", tags=["cqa"])


def get_cqa(request: Request) -> CqaService:
    return request.app.state.cqa


Cqa = Annotated[CqaService, Depends(get_cqa)]
HexId = Annotated[str, Path(pattern=ID_PATTERN)]
ConversationId = Annotated[str, Path(pattern=CONVERSATION_ID_PATTERN)]
CriterionId = Annotated[str, Path(pattern=CRITERION_ID_PATTERN)]
TemplateId = Annotated[str, Path(pattern=TEMPLATE_ID_PATTERN)]


# ---- info & overview ------------------------------------------------------------------------------

@router.get("/info", response_model=CqaInfo)
def info(cqa: Cqa) -> CqaInfo:
    return cqa.info()


@router.get("/overview", response_model=Overview)
def overview(cqa: Cqa, checklist_id: Annotated[str | None, Query(pattern=ID_PATTERN)] = None) -> Overview:
    return cqa.overview(checklist_id)


@router.get("/contract")
def contract() -> dict:
    """The evaluator integration contract: JSON schemas plus a worked example request and response."""
    return {**contract_schema(), "example_request": example_request().model_dump(mode="json"),
            "example_output": example_output()}


@router.get("/audit", response_model=list[AuditEvent])
def audit(cqa: Cqa, conversation_id: str | None = None,
          evaluation_id: Annotated[str | None, Query(pattern=ID_PATTERN)] = None,
          checklist_id: Annotated[str | None, Query(pattern=ID_PATTERN)] = None,
          appeal_id: Annotated[str | None, Query(pattern=ID_PATTERN)] = None,
          limit: Annotated[int, Query(ge=1, le=1000)] = 100) -> list[AuditEvent]:
    return cqa.store.events(conversation_id=conversation_id, evaluation_id=evaluation_id,
                            checklist_id=checklist_id, appeal_id=appeal_id, limit=limit)


# ---- imports & conversations -------------------------------------------------------------------------

@router.post("/imports", response_model=ImportRun, status_code=status.HTTP_201_CREATED)
def import_group(body: ImportRequest, cqa: Cqa) -> ImportRun:
    """Fetch a group from the organizers' API (server-side, so the browser never hits CORS) or load fixtures."""
    return cqa.import_group(body)


@router.post("/imports/json", response_model=ImportRun, status_code=status.HTTP_201_CREATED)
def import_json(
    cqa: Cqa,
    payload: Annotated[Any, Body(description="The organizers' API response, pasted as is: "
                                             '{"isSuccess": true, "data": {"dataset_group_id": …, "records": […]}}')],
) -> ImportRun:
    """Import a pasted organizers' API response through the same ingestion as ``POST /imports``."""
    return cqa.import_json(payload)


@router.get("/imports", response_model=list[ImportRun])
def list_imports(cqa: Cqa) -> list[ImportRun]:
    return cqa.store.imports


@router.get("/conversation-records", response_model=list[ConversationRecord])
def list_conversation_records(
    cqa: Cqa, group_id: Annotated[str | None, Query(pattern=GROUP_ID_PATTERN)] = None,
) -> list[ConversationRecord]:
    """Every stored conversation with its full transcript, exactly as persisted (ordered by id)."""
    return cqa.records(group_id)


@router.get("/conversations", response_model=ConversationPage)
def list_conversations(
    cqa: Cqa,
    q: Annotated[str | None, Query(max_length=200)] = None,
    language: Annotated[list[str] | None, Query()] = None,
    channel: Annotated[list[Literal["chat", "voice"]] | None, Query()] = None,
    status_: Annotated[list[Literal["not_evaluated", "pending", "running", "completed", "failed", "appealed"]] | None,
                       Query(alias="status")] = None,
    group_id: Annotated[str | None, Query(max_length=64)] = None,
    source: Annotated[Literal["organizer_api", "fixture"] | None, Query()] = None,
    min_score: float | None = None,
    max_score: float | None = None,
    checklist_id: Annotated[str | None, Query(pattern=ID_PATTERN)] = None,
    sort: SortKey = "id",
    desc: bool = False,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 25,
) -> ConversationPage:
    return cqa.list_conversations(q=q, language=language, channel=channel, status=status_, group_id=group_id,
                                  source=source, min_score=min_score, max_score=max_score,
                                  checklist_id=checklist_id, sort=sort, desc=desc, page=page, page_size=page_size)


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
def get_conversation(conversation_id: ConversationId, cqa: Cqa) -> ConversationDetail:
    return cqa.conversation_detail(conversation_id)


@router.get("/conversations/{conversation_id}/audio", response_model=AudioInfo)
def get_audio(conversation_id: ConversationId, cqa: Cqa) -> AudioInfo:
    return cqa.audio(conversation_id)


# ---- checklists ---------------------------------------------------------------------------------------

@router.get("/checklists", response_model=list[ChecklistSummary])
def list_checklists(cqa: Cqa, include_archived: bool = False) -> list[ChecklistSummary]:
    return cqa.checklists.summaries(include_archived)


@router.post("/checklists", response_model=Checklist, status_code=status.HTTP_201_CREATED)
def create_checklist(body: ChecklistCreate, cqa: Cqa) -> Checklist:
    return cqa.checklists.create(body)


@router.post("/checklists/dev-sample", response_model=Checklist, status_code=status.HTTP_201_CREATED)
def create_dev_sample(cqa: Cqa) -> Checklist:
    """Create the unofficial development sample checklist (placeholder criteria, clearly labeled)."""
    return cqa.checklists.create_dev_sample()


@router.post("/checklists/import", response_model=Checklist, status_code=status.HTTP_201_CREATED)
def import_checklist(body: ChecklistImport, cqa: Cqa) -> Checklist:
    return cqa.checklists.import_(body)


@router.post("/checklists/from-template", response_model=Checklist, status_code=status.HTTP_201_CREATED)
def create_from_template(body: ChecklistFromTemplate, cqa: Cqa) -> Checklist:
    """Create a new, independent checklist (v1) from a starter template. The template itself never changes."""
    return cqa.checklists.create_from_template(body)


@router.post("/checklists/validate", response_model=ChecklistValidation)
def validate_checklist(
    cqa: Cqa,
    config: Annotated[Any, Body(description="A checklist configuration: {sections, criteria, scoring}.")],
) -> ChecklistValidation:
    """Check a configuration without saving it. Problems come back as data (200), not as a 422."""
    return cqa.checklists.validate(config)


@router.get("/checklist-templates", response_model=list[ChecklistTemplateSummary])
def list_templates(cqa: Cqa) -> list[ChecklistTemplateSummary]:
    return cqa.checklists.templates()


@router.get("/checklist-templates/{template_id}", response_model=ChecklistTemplate)
def get_template(template_id: TemplateId, cqa: Cqa) -> ChecklistTemplate:
    """A read-only starter template with its full configuration and source notes."""
    return cqa.checklists.template(template_id)


@router.get("/checklists/{checklist_id}", response_model=Checklist)
def get_checklist(checklist_id: HexId, cqa: Cqa) -> Checklist:
    return cqa.checklists.get(checklist_id)


@router.get("/checklists/{checklist_id}/versions", response_model=list[ChecklistVersionSummary])
def list_versions(checklist_id: HexId, cqa: Cqa) -> list[ChecklistVersionSummary]:
    """Every saved version, newest first, with how many evaluations used each."""
    return cqa.checklists.versions(checklist_id)


@router.get("/checklists/{checklist_id}/versions/{version}", response_model=ChecklistVersionDetail)
def get_version(checklist_id: HexId, version: Annotated[int, Path(ge=1)], cqa: Cqa) -> ChecklistVersionDetail:
    """One version exactly as an evaluation with this checklist_version will use it."""
    return cqa.checklists.version_detail(checklist_id, version)


@router.put("/checklists/{checklist_id}", response_model=Checklist)
def update_checklist(checklist_id: HexId, body: ChecklistUpdate, cqa: Cqa) -> Checklist:
    return cqa.checklists.update(checklist_id, body)


@router.delete("/checklists/{checklist_id}", response_model=Deleted)
def delete_checklist(checklist_id: HexId, cqa: Cqa) -> Deleted:
    cqa.checklists.delete(checklist_id)
    return Deleted(id=checklist_id)


@router.post("/checklists/{checklist_id}/duplicate", response_model=Checklist, status_code=status.HTTP_201_CREATED)
def duplicate_checklist(checklist_id: HexId, body: ChecklistDuplicate, cqa: Cqa) -> Checklist:
    return cqa.checklists.duplicate(checklist_id, body)


@router.post("/checklists/{checklist_id}/criteria/{criterion_id}/replace", response_model=Checklist)
def replace_criterion(checklist_id: HexId, criterion_id: CriterionId, body: CriterionReplace, cqa: Cqa) -> Checklist:
    return cqa.checklists.replace_criterion(checklist_id, criterion_id, body)


@router.get("/checklists/{checklist_id}/export")
def export_checklist(checklist_id: HexId, cqa: Cqa,
                     version: Annotated[int | None, Query(ge=1)] = None) -> JSONResponse:
    payload = cqa.checklists.export(checklist_id, version)
    return JSONResponse(payload, headers=attachment(f"{payload['name']} v{payload['version']}.json"))


# ---- evaluations ----------------------------------------------------------------------------------------

@router.post("/evaluations", response_model=EvaluateResponse, status_code=status.HTTP_202_ACCEPTED)
def evaluate(body: EvaluateRequest, cqa: Cqa) -> EvaluateResponse:
    """Queue evaluations (pending → running → completed | failed). Poll the batch or the evaluations."""
    return cqa.evaluations.queue(body)


@router.get("/evaluations", response_model=EvaluationPage)
def list_evaluations(
    cqa: Cqa,
    conversation_id: Annotated[str | None, Query(max_length=128)] = None,
    checklist_id: Annotated[str | None, Query(pattern=ID_PATTERN)] = None,
    status_: Annotated[Literal["pending", "running", "completed", "failed"] | None, Query(alias="status")] = None,
    batch_id: Annotated[str | None, Query(pattern=ID_PATTERN)] = None,
    mock: bool | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
) -> EvaluationPage:
    return cqa.evaluations.page(conversation_id=conversation_id, checklist_id=checklist_id, status=status_,
                                batch_id=batch_id, mock=mock, page=page, page_size=page_size)


@router.get("/evaluations/batches/{batch_id}", response_model=BatchStatus)
def batch_status(batch_id: HexId, cqa: Cqa) -> BatchStatus:
    return cqa.evaluations.batch(batch_id)


@router.get("/evaluations/{evaluation_id}", response_model=EvaluationDetail)
def get_evaluation(evaluation_id: HexId, cqa: Cqa) -> EvaluationDetail:
    return cqa.evaluations.detail(evaluation_id, cqa.appeals.list(evaluation_id=evaluation_id))


@router.get("/evaluations/{evaluation_id}/request", response_model=EvaluationRequest)
def evaluation_request(evaluation_id: HexId, cqa: Cqa) -> EvaluationRequest:
    """The exact contract request this evaluation sends to its adapter (for debugging the model integration)."""
    record = cqa.evaluations.get(evaluation_id)
    return cqa.evaluations.request_for(record, cqa.conversation(record.conversation_id))


@router.post("/evaluations/{evaluation_id}/rerun", response_model=EvaluateResponse,
             status_code=status.HTTP_202_ACCEPTED)
def rerun_evaluation(evaluation_id: HexId, cqa: Cqa) -> EvaluateResponse:
    return cqa.evaluations.rerun(evaluation_id)


# ---- appeals ----------------------------------------------------------------------------------------------

@router.post("/appeals", response_model=Appeal, status_code=status.HTTP_201_CREATED)
def create_appeal(body: AppealCreate, cqa: Cqa) -> Appeal:
    return cqa.appeals.create(body)


@router.get("/appeals", response_model=list[Appeal])
def list_appeals(
    cqa: Cqa,
    status_: Annotated[Literal["pending", "confirmed", "overridden"] | None, Query(alias="status")] = None,
    evaluation_id: Annotated[str | None, Query(pattern=ID_PATTERN)] = None,
    conversation_id: Annotated[str | None, Query(max_length=128)] = None,
) -> list[Appeal]:
    return cqa.appeals.list(status=status_, evaluation_id=evaluation_id, conversation_id=conversation_id)


@router.get("/appeals/{appeal_id}", response_model=AppealDetail)
def get_appeal(appeal_id: HexId, cqa: Cqa) -> AppealDetail:
    return cqa.appeals.detail(appeal_id)


@router.post("/appeals/{appeal_id}/decision", response_model=Appeal)
def decide_appeal(appeal_id: HexId, body: AppealDecisionIn, cqa: Cqa) -> Appeal:
    return cqa.appeals.decide(appeal_id, body)
