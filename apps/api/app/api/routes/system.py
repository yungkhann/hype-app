from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app import __version__
from app.api.deps import SettingsDep
from app.services.modeling.pipelines import CATBOOST_AVAILABLE

router = APIRouter(tags=["system"])


class Limits(BaseModel):
    max_upload_mb: int
    max_rows: int
    max_page_size: int
    max_chart_points: int
    profile_sample_rows: int
    model_max_train_rows: int


class Health(BaseModel):
    status: str
    version: str
    catboost: bool
    accepted_formats: list[str]
    limits: Limits


@router.get("/health", response_model=Health)
def health(settings: SettingsDep) -> Health:
    from app.services.ingestion.readers import EXTENSIONS

    return Health(status="ok", version=__version__, catboost=CATBOOST_AVAILABLE,
                  accepted_formats=sorted(EXTENSIONS),
                  limits=Limits(max_upload_mb=settings.max_upload_mb, max_rows=settings.max_rows,
                                max_page_size=settings.max_page_size,
                                max_chart_points=settings.max_chart_points,
                                profile_sample_rows=settings.profile_sample_rows,
                                model_max_train_rows=settings.model_max_train_rows))
