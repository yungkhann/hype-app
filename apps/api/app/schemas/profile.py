from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from app.schemas.common import ColumnKind


class Histogram(BaseModel):
    edges: list[float]
    counts: list[int]


class CategoryCount(BaseModel):
    value: str
    count: int


class NumericStats(BaseModel):
    min: float | None
    max: float | None
    mean: float | None
    median: float | None
    std: float | None
    q1: float | None
    q3: float | None
    skew: float | None
    zeros: int
    negatives: int
    outliers_iqr: int
    lower_fence: float | None
    upper_fence: float | None


class DatetimeStats(BaseModel):
    min: str | None
    max: str | None
    span_days: float | None


class QualityFlag(BaseModel):
    """``basis='detected'`` is a measured fact; ``basis='heuristic'`` is an assumption to verify."""

    code: str
    severity: Literal["info", "warning", "critical"]
    basis: Literal["detected", "heuristic"]
    column: str | None = None
    message: str


class ColumnProfile(BaseModel):
    name: str
    dtype: str
    kind: ColumnKind
    non_null: int
    missing: int
    missing_pct: float
    unique: int
    unique_pct: float
    examples: list[str]
    numeric: NumericStats | None = None
    datetime: DatetimeStats | None = None
    top: list[CategoryCount] | None = None
    other_count: int | None = None
    histogram: Histogram | None = None
    flags: list[str] = []


class ProfileOverview(BaseModel):
    n_rows: int
    n_cols: int
    file_size_bytes: int | None
    memory_bytes: int
    duplicate_rows: int
    duplicate_pct: float
    missing_cells: int
    missing_pct: float
    kinds: dict[str, int]


class Correlation(BaseModel):
    method: Literal["pearson", "spearman"]
    columns: list[str]
    matrix: list[list[float | None]]
    n_rows_used: int
    sampled: bool


class Sampling(BaseModel):
    sampled: bool
    sample_rows: int
    total_rows: int
    note: str | None = None


class DatasetProfile(BaseModel):
    dataset_id: str
    dataset_name: str
    generated_at: str
    overview: ProfileOverview
    columns: list[ColumnProfile]
    quality: list[QualityFlag]
    correlation: Correlation | None
    sampling: Sampling
