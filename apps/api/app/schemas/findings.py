from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.analysis import ChartData


class EvidenceItem(BaseModel):
    label: str = Field(max_length=120)
    value: str = Field(max_length=200)


class FindingIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=5000)
    chart: ChartData | None = None
    dataset_id: str | None = None
    dataset_name: str | None = None
    experiment_id: str | None = None
    methodology: str = Field(default="", max_length=5000)
    evidence: list[EvidenceItem] = Field(default=[], max_length=20)
    interpretation: str = Field(default="", max_length=5000)
    implication: str = Field(default="", max_length=5000)
    limitations: str = Field(default="", max_length=5000)
    include_in_pitch: bool = True


class FindingPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    methodology: str | None = Field(default=None, max_length=5000)
    evidence: list[EvidenceItem] | None = Field(default=None, max_length=20)
    interpretation: str | None = Field(default=None, max_length=5000)
    implication: str | None = Field(default=None, max_length=5000)
    limitations: str | None = Field(default=None, max_length=5000)
    include_in_pitch: bool | None = None


class Finding(FindingIn):
    id: str
    created_at: str
    updated_at: str


class ReorderRequest(BaseModel):
    ids: list[str]


PitchSection = Literal["title", "problem", "observations", "solution", "methodology",
                       "results", "impact", "custom"]


class PitchSlide(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    section: PitchSection
    title: str = Field(default="", max_length=200)
    body: str = Field(default="", max_length=5000)
    finding_ids: list[str] = []
    notes: str = Field(default="", max_length=5000)


class PitchDeck(BaseModel):
    title: str = Field(default="", max_length=200)
    subtitle: str = Field(default="", max_length=300)
    team: str = Field(default="", max_length=200)
    slides: list[PitchSlide] = []
    updated_at: str | None = None


ViewKind = Literal["chart", "table"]


class SavedViewIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    dataset_id: str
    kind: ViewKind
    spec: dict[str, Any]


class SavedView(SavedViewIn):
    id: str
    created_at: str
