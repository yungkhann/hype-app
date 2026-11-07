"""Shared request/response building blocks."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.storage.paths import ID_PATTERN

DatasetId = Field(pattern=ID_PATTERN)

ColumnKind = Literal["numeric", "categorical", "boolean", "datetime", "text"]
FilterOp = Literal[
    "eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between",
    "contains", "not_contains", "is_null", "not_null",
]
AggFn = Literal["count", "sum", "mean", "median", "min", "max", "nunique", "std"]


class ColumnInfo(BaseModel):
    name: str
    dtype: str
    kind: ColumnKind


class Filter(BaseModel):
    """A single column condition. ``value`` is a scalar, or a list for ``in``/``not_in``/``between``."""

    column: str
    op: FilterOp
    value: Any = None


class SortKey(BaseModel):
    column: str
    desc: bool = False


class SourceMeta(BaseModel):
    """Provenance carried by every computed result (the UI's "source line")."""

    dataset_id: str
    dataset_name: str
    n_rows_total: int
    n_rows_used: int
    filters: list[Filter] = []
    sampled: bool = False
    sample_size: int | None = None
    aggregation: str | None = None
    notes: list[str] = []


class LabelValue(BaseModel):
    label: str
    value: str
    hint: str | None = None


class TableData(BaseModel):
    columns: list[str]
    rows: list[list[Any]]


class Deleted(BaseModel):
    id: str
    deleted: bool = True
