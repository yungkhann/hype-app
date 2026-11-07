"""Paged record queries and group-by aggregation. Nothing here returns an unbounded table."""

from __future__ import annotations

import pandas as pd

from app.core.errors import ValidationFailed
from app.schemas.analysis import AggregateRequest, AggregateResponse, QueryRequest, QueryResponse
from app.schemas.common import Filter, SourceMeta
from app.services.filters import apply_filters, apply_search, apply_sort, describe_filters
from app.utils.frames import column_infos, is_numeric, require_columns, to_rows

NUMERIC_AGGS = {"sum", "mean", "median", "std"}


def source_meta(dataset_id: str, dataset_name: str, total: int, used: int, filters: list[Filter],
                **extra) -> SourceMeta:
    return SourceMeta(dataset_id=dataset_id, dataset_name=dataset_name, n_rows_total=total,
                      n_rows_used=used, filters=filters, **extra)


def run_query(frame: pd.DataFrame, request: QueryRequest) -> QueryResponse:
    filtered = apply_search(apply_filters(frame, request.filters), request.search)
    ordered = apply_sort(filtered, request.sort)
    if request.columns:
        require_columns(frame, request.columns)
        ordered = ordered[request.columns]
    page = ordered.iloc[request.offset: request.offset + request.limit]
    return QueryResponse(columns=column_infos(ordered), rows=to_rows(page), total_rows=len(frame),
                         filtered_rows=len(filtered), offset=request.offset, limit=request.limit)


def query_frame(frame: pd.DataFrame, request: QueryRequest) -> pd.DataFrame:
    """The full filtered/sorted frame for exports (no paging)."""
    filtered = apply_sort(apply_search(apply_filters(frame, request.filters), request.search),
                          request.sort)
    if request.columns:
        require_columns(frame, request.columns)
        filtered = filtered[request.columns]
    return filtered


def run_aggregate(frame: pd.DataFrame, request: AggregateRequest, *, dataset_id: str,
                  dataset_name: str) -> AggregateResponse:
    require_columns(frame, request.group_by + [m.column for m in request.metrics])
    filtered = apply_filters(frame, request.filters)
    grouped = filtered.groupby(request.group_by, dropna=False, observed=True, sort=False)

    parts: list[pd.Series] = []
    for metric in request.metrics:
        if metric.agg == "count":
            series = grouped.size() if metric.column is None else grouped[metric.column].count()
            series.name = "count" if metric.column is None else f"count_{metric.column}"
        else:
            if metric.column is None:
                raise ValidationFailed(f"'{metric.agg}' needs a column.", code="invalid_metric")
            if metric.agg in NUMERIC_AGGS and not is_numeric(frame[metric.column]):
                raise ValidationFailed(
                    f"'{metric.agg}' needs a numeric column; '{metric.column}' is not numeric.",
                    code="invalid_metric")
            series = getattr(grouped[metric.column], metric.agg)()
            series.name = f"{metric.agg}_{metric.column}"
        parts.append(series)

    table = pd.concat(parts, axis=1).reset_index()
    table.columns = [str(c) for c in table.columns]
    if request.sort:
        require_columns(table, [request.sort.column])
        table = table.sort_values(request.sort.column, ascending=not request.sort.desc,
                                  na_position="last")
    else:
        table = table.sort_values(table.columns[len(request.group_by)], ascending=False,
                                  na_position="last")
    total_groups = len(table)
    shown = table.head(request.limit)
    metrics = ", ".join(f"{m.agg}({m.column or 'rows'})" for m in request.metrics)
    meta = source_meta(dataset_id, dataset_name, len(frame), len(filtered), request.filters,
                       aggregation=f"{metrics} by {', '.join(request.group_by)}",
                       notes=[f"Filters: {describe_filters(request.filters)}"] if request.filters else [])
    return AggregateResponse(columns=list(shown.columns), rows=to_rows(shown), total_groups=total_groups,
                             truncated=total_groups > len(shown), meta=meta)
