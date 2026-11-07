from __future__ import annotations

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse, PlainTextResponse

from app.api.deps import ItemIdPath, ReportsDep, attachment
from app.schemas.common import Deleted
from app.schemas.findings import (
    Finding,
    FindingIn,
    FindingPatch,
    PitchDeck,
    ReorderRequest,
    SavedView,
    SavedViewIn,
)
from app.services.reporting.store import findings_markdown

router = APIRouter(tags=["findings"])


@router.get("/findings", response_model=list[Finding])
def list_findings(reports: ReportsDep) -> list[Finding]:
    return reports.findings()


@router.post("/findings", response_model=Finding, status_code=status.HTTP_201_CREATED)
def create_finding(payload: FindingIn, reports: ReportsDep) -> Finding:
    return reports.create_finding(payload)


@router.put("/findings/order", response_model=list[Finding])
def reorder_findings(body: ReorderRequest, reports: ReportsDep) -> list[Finding]:
    return reports.reorder(body.ids)


@router.get("/findings/export.md", response_class=PlainTextResponse)
def export_markdown(reports: ReportsDep) -> PlainTextResponse:
    text = findings_markdown(reports.findings(), reports.pitch())
    return PlainTextResponse(text, media_type="text/markdown; charset=utf-8",
                             headers=attachment("atlas-findings.md"))


@router.get("/findings/export.json")
def export_json(reports: ReportsDep) -> JSONResponse:
    payload = {"pitch": reports.pitch().model_dump(mode="json"),
               "findings": [f.model_dump(mode="json") for f in reports.findings()]}
    return JSONResponse(payload, headers=attachment("atlas-findings.json"))


@router.get("/findings/{finding_id}", response_model=Finding)
def get_finding(finding_id: ItemIdPath, reports: ReportsDep) -> Finding:
    return reports.get_finding(finding_id)


@router.patch("/findings/{finding_id}", response_model=Finding)
def update_finding(finding_id: ItemIdPath, patch: FindingPatch, reports: ReportsDep) -> Finding:
    return reports.update_finding(finding_id, patch)


@router.delete("/findings/{finding_id}", response_model=Deleted)
def delete_finding(finding_id: ItemIdPath, reports: ReportsDep) -> Deleted:
    reports.delete_finding(finding_id)
    return Deleted(id=finding_id)


@router.get("/pitch", response_model=PitchDeck)
def get_pitch(reports: ReportsDep) -> PitchDeck:
    return reports.pitch()


@router.put("/pitch", response_model=PitchDeck)
def save_pitch(deck: PitchDeck, reports: ReportsDep) -> PitchDeck:
    return reports.save_pitch(deck)


@router.get("/views", response_model=list[SavedView])
def list_views(reports: ReportsDep, dataset_id: str | None = None) -> list[SavedView]:
    return reports.views(dataset_id)


@router.post("/views", response_model=SavedView, status_code=status.HTTP_201_CREATED)
def create_view(payload: SavedViewIn, reports: ReportsDep) -> SavedView:
    return reports.create_view(payload)


@router.delete("/views/{view_id}", response_model=Deleted)
def delete_view(view_id: ItemIdPath, reports: ReportsDep) -> Deleted:
    reports.delete_view(view_id)
    return Deleted(id=view_id)
