from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import DatasetIdPath, DatasetsDep, SettingsDep
from app.extensions import REGISTRY
from app.extensions.registry import run_analysis
from app.schemas.common import Filter
from app.schemas.extensions import AnalysisInfo, AnalysisResult

router = APIRouter(tags=["analyses"])


class RunAnalysisRequest(BaseModel):
    params: dict[str, Any] = {}
    filters: list[Filter] = []


@router.get("/analyses", response_model=list[AnalysisInfo])
def list_analyses() -> list[AnalysisInfo]:
    """Every registered analysis with its parameter JSON schema (``x-widget`` marks column pickers)."""
    return [definition.info() for definition in REGISTRY.values()]


@router.post("/datasets/{dataset_id}/analyses/{analysis_id}", response_model=AnalysisResult)
def run(dataset_id: DatasetIdPath, analysis_id: str, body: RunAnalysisRequest, datasets: DatasetsDep,
        settings: SettingsDep) -> AnalysisResult:
    return run_analysis(analysis_id, datasets.frame(dataset_id), body.params, body.filters,
                        dataset_id=dataset_id, dataset_name=datasets.name(dataset_id), settings=settings)
