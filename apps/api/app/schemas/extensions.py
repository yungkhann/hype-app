from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel

from app.schemas.analysis import ChartData
from app.schemas.common import LabelValue, SourceMeta, TableData


class AnalysisInfo(BaseModel):
    id: str
    title: str
    description: str
    category: Literal["builtin", "challenge"]
    params_schema: dict[str, Any]


class AnalysisResult(BaseModel):
    analysis_id: str
    title: str
    summary: list[LabelValue] = []
    table: TableData | None = None
    chart: ChartData | None = None
    notes: list[str] = []
    meta: SourceMeta
