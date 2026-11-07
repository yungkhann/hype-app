from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.common import ColumnInfo

FileFormat = Literal["csv", "xlsx", "parquet"]
DatasetStatus = Literal["staged", "ready", "failed"]
DatasetSource = Literal["upload", "sample", "transform"]


class IngestOptions(BaseModel):
    """Parsing options. ``None`` means "use what detection found"."""

    sheet: str | None = None
    delimiter: str | None = Field(default=None, max_length=2)
    encoding: str | None = Field(default=None, max_length=40)
    header_row: int = Field(default=0, ge=0, le=100)
    decimal: Literal[".", ","] = "."


class DetectedFormat(BaseModel):
    format: FileFormat
    encoding: str | None = None
    encoding_confidence: float | None = None
    delimiter: str | None = None
    sheets: list[str] = []


class OriginalFile(BaseModel):
    filename: str
    extension: str
    size_bytes: int
    sha256: str


class Lineage(BaseModel):
    parent_id: str
    parent_name: str
    steps: list[dict[str, Any]]
    log: list[dict[str, Any]]
    split: dict[str, Any] | None = None


class DatasetSummary(BaseModel):
    id: str
    name: str
    status: DatasetStatus
    source: DatasetSource
    format: FileFormat
    original: OriginalFile | None = None
    n_rows: int | None = None
    n_cols: int | None = None
    created_at: str
    updated_at: str
    is_synthetic: bool = False
    replacing: bool = False  # a replacement file is staged; the previous version is kept
    lineage: Lineage | None = None
    error: str | None = None


class DatasetDetail(DatasetSummary):
    detected: DetectedFormat | None = None
    ingest_options: IngestOptions | None = None
    columns: list[ColumnInfo] = []
    notes: list[str] = []  # disclosed conversions made during import


class StagedPreview(BaseModel):
    """Returned after upload: what ATLAS detected and how the first rows parse."""

    dataset: DatasetDetail
    columns: list[str]
    rows: list[list[Any]]
    warnings: list[str] = []


class PreviewResponse(BaseModel):
    columns: list[ColumnInfo]
    rows: list[list[Any]]
    n_rows: int
    limit: int


class DatasetUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class SampleInfo(BaseModel):
    name: str
    filename: str
    description: str
    size_bytes: int
