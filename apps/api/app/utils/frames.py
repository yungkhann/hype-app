"""DataFrame helpers shared by every service: semantic column kinds and JSON-safe conversion."""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from typing import Any

import numpy as np
import pandas as pd

from app.core.errors import ValidationFailed
from app.schemas.common import ColumnInfo, ColumnKind

TEXT_AVG_LENGTH = 40          # average string length above which a column reads as free text
CATEGORICAL_MAX_UNIQUE = 200  # absolute cap on distinct values for a categorical column
CATEGORICAL_MAX_RATIO = 0.5   # distinct/non-null ratio above which strings are not categories


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def is_numeric(series: pd.Series) -> bool:
    return pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series)


def infer_kind(series: pd.Series) -> ColumnKind:
    """Classify a column by how it should be analyzed, not only by storage dtype."""
    if pd.api.types.is_bool_dtype(series):
        return "boolean"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "datetime"
    if is_numeric(series):
        return "numeric"
    if isinstance(series.dtype, pd.CategoricalDtype):
        return "categorical"
    non_null = series.dropna()
    if non_null.empty:
        return "categorical"
    sample = non_null if len(non_null) <= 50_000 else non_null.sample(50_000, random_state=0)
    as_text = sample.astype("str")
    unique = as_text.nunique()
    avg_len = float(as_text.str.len().mean())
    if avg_len > TEXT_AVG_LENGTH:
        return "text"
    if unique <= CATEGORICAL_MAX_UNIQUE or unique / max(len(as_text), 1) <= CATEGORICAL_MAX_RATIO:
        return "categorical"
    return "text"


def column_infos(frame: pd.DataFrame) -> list[ColumnInfo]:
    return [ColumnInfo(name=str(c), dtype=str(frame[c].dtype), kind=infer_kind(frame[c]))
            for c in frame.columns]


def kinds_by_column(frame: pd.DataFrame) -> dict[str, ColumnKind]:
    return {str(c): infer_kind(frame[c]) for c in frame.columns}


def require_columns(frame: pd.DataFrame, columns: list[str | None]) -> None:
    missing = [c for c in columns if c is not None and c not in frame.columns]
    if missing:
        raise ValidationFailed(f"Unknown column(s): {', '.join(missing)}.", code="unknown_column",
                               details={"columns": missing})


def to_rows(frame: pd.DataFrame) -> list[list[Any]]:
    """Convert to JSON-safe rows: NaN/NaT -> null, timestamps -> ISO strings, numpy -> Python."""
    if frame.empty:
        return []
    return json.loads(frame.to_json(orient="values", date_format="iso", default_handler=str))


def to_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    if frame.empty:
        return []
    return json.loads(frame.to_json(orient="records", date_format="iso", default_handler=str))


def clean_float(value: Any, digits: int | None = None) -> float | None:
    """Return a finite Python float or ``None``."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return round(number, digits) if digits is not None else number


def display_value(value: Any) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "∅"
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, np.generic):
        value = value.item()
    text = str(value)
    return text if len(text) <= 80 else text[:77] + "…"


def sample_frame(frame: pd.DataFrame, max_rows: int, seed: int = 0) -> tuple[pd.DataFrame, bool]:
    if len(frame) <= max_rows:
        return frame, False
    return frame.sample(max_rows, random_state=seed), True
