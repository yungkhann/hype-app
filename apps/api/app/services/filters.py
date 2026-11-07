"""Row filtering, search, and sorting. Shared by query, aggregation, charts, exports, and transforms."""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from app.core.errors import ValidationFailed
from app.schemas.common import Filter, SortKey
from app.utils.frames import is_numeric, require_columns

_LIST_OPS = {"in", "not_in"}
_SEARCH_MAX_COLUMNS = 40


def _coerce(series: pd.Series, value: Any) -> Any:
    if value is None:
        return None
    if is_numeric(series):
        try:
            return float(value)
        except (TypeError, ValueError) as exc:
            raise ValidationFailed(f"'{value}' is not a number (column '{series.name}').",
                                   code="invalid_filter_value") from exc
    if pd.api.types.is_datetime64_any_dtype(series):
        parsed = pd.to_datetime(value, errors="coerce")
        if pd.isna(parsed):
            raise ValidationFailed(f"'{value}' is not a date (column '{series.name}').",
                                   code="invalid_filter_value")
        tz = getattr(series.dt, "tz", None)
        if tz is not None and parsed.tzinfo is None:
            parsed = parsed.tz_localize(tz)
        return parsed
    if pd.api.types.is_bool_dtype(series):
        if isinstance(value, str):
            return value.strip().lower() in {"true", "1", "yes"}
        return bool(value)
    return str(value)


def _as_comparable(series: pd.Series) -> pd.Series:
    """Strings compare as strings; categoricals/objects are cast so equality is predictable."""
    if is_numeric(series) or pd.api.types.is_datetime64_any_dtype(series) \
            or pd.api.types.is_bool_dtype(series):
        return series
    return series.astype("str")


def filter_mask(frame: pd.DataFrame, flt: Filter) -> pd.Series:
    require_columns(frame, [flt.column])
    series = frame[flt.column]
    op = flt.op
    if op == "is_null":
        return series.isna()
    if op == "not_null":
        return series.notna()

    comparable = _as_comparable(series)
    if op in _LIST_OPS:
        values = flt.value if isinstance(flt.value, list) else [flt.value]
        coerced = [_coerce(series, v) for v in values]
        mask = comparable.isin(coerced)
        return ~mask if op == "not_in" else mask
    if op == "between":
        if not isinstance(flt.value, list) or len(flt.value) != 2:
            raise ValidationFailed("'between' needs a [low, high] pair.", code="invalid_filter_value")
        low, high = (_coerce(series, v) for v in flt.value)
        mask = pd.Series(True, index=frame.index)
        if low is not None:
            mask &= comparable >= low
        if high is not None:
            mask &= comparable <= high
        return mask.fillna(False).astype(bool)
    if op in {"contains", "not_contains"}:
        needle = str(flt.value or "")
        mask = series.astype("str").str.contains(needle, case=False, regex=False, na=False)
        return ~mask if op == "not_contains" else mask

    value = _coerce(series, flt.value)
    if op == "eq":
        mask = comparable == value
    elif op == "neq":
        mask = comparable != value
    else:
        if not (is_numeric(series) or pd.api.types.is_datetime64_any_dtype(series)):
            raise ValidationFailed(f"'{op}' needs a numeric or date column; '{flt.column}' is neither.",
                                   code="invalid_filter_op")
        mask = {"gt": comparable > value, "gte": comparable >= value,
                "lt": comparable < value, "lte": comparable <= value}[op]
    return pd.Series(mask, index=frame.index).fillna(False).astype(bool)


def apply_filters(frame: pd.DataFrame, filters: list[Filter]) -> pd.DataFrame:
    if not filters:
        return frame
    mask = pd.Series(True, index=frame.index)
    for flt in filters:
        mask &= filter_mask(frame, flt)
    return frame[mask]


def apply_search(frame: pd.DataFrame, search: str | None) -> pd.DataFrame:
    if not search or not search.strip():
        return frame
    needle = search.strip()
    mask = np.zeros(len(frame), dtype=bool)
    for column in list(frame.columns)[:_SEARCH_MAX_COLUMNS]:
        mask |= frame[column].astype("str").str.contains(
            needle, case=False, regex=False, na=False).to_numpy()
    return frame[mask]


def apply_sort(frame: pd.DataFrame, sort: list[SortKey]) -> pd.DataFrame:
    if not sort:
        return frame
    require_columns(frame, [s.column for s in sort])
    return frame.sort_values([s.column for s in sort], ascending=[not s.desc for s in sort],
                             na_position="last", kind="stable")


def describe_filters(filters: list[Filter]) -> str:
    if not filters:
        return "no filters"
    parts = []
    for f in filters:
        if f.op in {"is_null", "not_null"}:
            parts.append(f"{f.column} {f.op.replace('_', ' ')}")
        else:
            parts.append(f"{f.column} {f.op} {f.value}")
    return "; ".join(parts)
