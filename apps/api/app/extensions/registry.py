"""The analysis extension convention.

An analysis is a Python function registered with ``@register_analysis``. It receives an
``AnalysisContext`` (the filtered DataFrame plus provenance helpers) and a validated Pydantic params
object, and returns an ``AnalysisResult``. The frontend lists analyses from ``GET /api/v1/analyses``,
renders a parameter form from the params JSON schema, and displays the result generically
(summary figures, a table, an optional chart) — no frontend change is needed for a new analysis.

Mark column parameters with ``column_param(kinds=[...])`` so the form shows a column picker.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import pandas as pd
from pydantic import BaseModel, Field

from app.core.config import Settings
from app.core.errors import NotFoundError, ValidationFailed
from app.schemas.analysis import ChartData, ChartSpec
from app.schemas.common import ColumnKind, Filter, LabelValue, SourceMeta, TableData
from app.schemas.extensions import AnalysisInfo, AnalysisResult
from app.services.filters import apply_filters, describe_filters
from app.utils.frames import infer_kind, require_columns, to_rows


def column_param(*, kinds: list[ColumnKind] | None = None, multiple: bool = False, description: str = "",
                 default: Any = ..., title: str | None = None) -> Any:
    """A parameter the UI renders as a column picker filtered to ``kinds``."""
    extra = {"x-widget": "columns" if multiple else "column", "x-kinds": kinds or []}
    return Field(default, description=description, title=title, json_schema_extra=extra)


@dataclass
class AnalysisContext:
    frame: pd.DataFrame
    full_frame: pd.DataFrame
    dataset_id: str
    dataset_name: str
    filters: list[Filter]
    settings: Settings
    notes: list[str] = field(default_factory=list)

    def kind(self, column: str) -> ColumnKind:
        return infer_kind(self.frame[column])

    def require(self, *columns: str | None, kinds: set[ColumnKind] | None = None) -> None:
        require_columns(self.frame, list(columns))
        if kinds:
            for column in columns:
                if column and self.kind(column) not in kinds:
                    raise ValidationFailed(f"'{column}' must be {' or '.join(sorted(kinds))}; it is "
                                           f"{self.kind(column)}.", code="invalid_param")

    def meta(self, *, aggregation: str | None = None, sampled: bool = False,
             sample_size: int | None = None) -> SourceMeta:
        notes = list(self.notes)
        if self.filters:
            notes.insert(0, f"Filters: {describe_filters(self.filters)}")
        return SourceMeta(dataset_id=self.dataset_id, dataset_name=self.dataset_name,
                          n_rows_total=len(self.full_frame), n_rows_used=len(self.frame),
                          filters=self.filters, sampled=sampled, sample_size=sample_size,
                          aggregation=aggregation, notes=notes)

    def table(self, frame: pd.DataFrame, limit: int = 500) -> TableData:
        shown = frame.head(limit)
        if len(frame) > limit:
            self.notes.append(f"Table shows the first {limit:,} of {len(frame):,} rows.")
        return TableData(columns=[str(c) for c in shown.columns], rows=to_rows(shown))

    def chart(self, spec: ChartSpec, rows: list[dict[str, Any]], *, series: list[str],
              x_label: str | None = None, y_label: str | None = None, aggregation: str | None = None,
              x_kind: ColumnKind | None = "categorical") -> ChartData:
        return ChartData(spec=spec, rows=rows, series=series, x_label=x_label, y_label=y_label,
                         x_kind=x_kind, meta=self.meta(aggregation=aggregation))

    def result(self, analysis_id: str, title: str, *, summary: list[LabelValue] | None = None,
               table: TableData | None = None, chart: ChartData | None = None,
               notes: list[str] | None = None, aggregation: str | None = None,
               sampled: bool = False, sample_size: int | None = None) -> AnalysisResult:
        return AnalysisResult(analysis_id=analysis_id, title=title, summary=summary or [], table=table,
                              chart=chart, notes=notes or [],
                              meta=self.meta(aggregation=aggregation, sampled=sampled,
                                             sample_size=sample_size))


AnalysisFn = Callable[[AnalysisContext, Any], AnalysisResult]


@dataclass
class AnalysisDef:
    id: str
    title: str
    description: str
    category: Literal["builtin", "challenge"]
    params: type[BaseModel]
    func: AnalysisFn

    def info(self) -> AnalysisInfo:
        return AnalysisInfo(id=self.id, title=self.title, description=self.description,
                            category=self.category, params_schema=self.params.model_json_schema())


REGISTRY: dict[str, AnalysisDef] = {}


def register_analysis(analysis_id: str, *, title: str, description: str, params: type[BaseModel],
                      category: Literal["builtin", "challenge"] = "builtin") -> Callable[[AnalysisFn], AnalysisFn]:
    def decorator(func: AnalysisFn) -> AnalysisFn:
        if analysis_id in REGISTRY:
            raise RuntimeError(f"Analysis '{analysis_id}' is registered twice.")
        REGISTRY[analysis_id] = AnalysisDef(analysis_id, title, description, category, params, func)
        return func
    return decorator


def run_analysis(analysis_id: str, frame: pd.DataFrame, raw_params: dict[str, Any], filters: list[Filter],
                 *, dataset_id: str, dataset_name: str, settings: Settings) -> AnalysisResult:
    definition = REGISTRY.get(analysis_id)
    if definition is None:
        raise NotFoundError(f"Analysis '{analysis_id}' does not exist.", code="analysis_not_found")
    try:
        params = definition.params.model_validate(raw_params)
    except Exception as exc:
        raise ValidationFailed(f"Invalid parameters: {exc}", code="invalid_param") from exc
    context = AnalysisContext(frame=apply_filters(frame, filters), full_frame=frame, dataset_id=dataset_id,
                              dataset_name=dataset_name, filters=filters, settings=settings)
    if context.frame.empty:
        raise ValidationFailed("No rows match the current filters.", code="empty_selection")
    return definition.func(context, params)
