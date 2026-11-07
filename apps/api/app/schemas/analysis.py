from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.common import AggFn, ColumnInfo, ColumnKind, Filter, SortKey, SourceMeta

ChartType = Literal["bar", "line", "scatter", "histogram", "box", "heatmap"]
TimeBucket = Literal["auto", "day", "week", "month", "quarter", "year"]


class QueryRequest(BaseModel):
    filters: list[Filter] = []
    search: str | None = Field(default=None, max_length=200)
    sort: list[SortKey] = Field(default=[], max_length=5)
    columns: list[str] | None = None
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=500)


class QueryResponse(BaseModel):
    columns: list[ColumnInfo]
    rows: list[list[Any]]
    total_rows: int
    filtered_rows: int
    offset: int
    limit: int


class Metric(BaseModel):
    column: str | None = None  # None with agg="count" counts rows
    agg: AggFn = "count"


class AggregateRequest(BaseModel):
    filters: list[Filter] = []
    group_by: list[str] = Field(min_length=1, max_length=3)
    metrics: list[Metric] = Field(min_length=1, max_length=10)
    sort: SortKey | None = None
    limit: int = Field(default=200, ge=1, le=1000)


class AggregateResponse(BaseModel):
    columns: list[str]
    rows: list[list[Any]]
    total_groups: int
    truncated: bool
    meta: SourceMeta


class ChartSpec(BaseModel):
    type: ChartType
    x: str | None = None
    y: str | None = None
    agg: AggFn = "count"
    group: str | None = None
    filters: list[Filter] = []
    bins: int = Field(default=30, ge=5, le=100)
    time_bucket: TimeBucket = "auto"
    columns: list[str] | None = None  # heatmap of numeric correlations
    limit: int = Field(default=20, ge=2, le=50)
    sort: Literal["value_desc", "value_asc", "label"] = "value_desc"


class BoxStats(BaseModel):
    group: str
    n: int
    min: float
    q1: float
    median: float
    q3: float
    max: float
    whisker_low: float
    whisker_high: float
    outliers: int
    mean: float


class HeatmapData(BaseModel):
    x_labels: list[str]
    y_labels: list[str]
    values: list[list[float | None]]
    value_label: str


class ChartData(BaseModel):
    """A chart ready to render. ``rows`` are Recharts-shaped records keyed by ``x`` and series names."""

    spec: ChartSpec
    x_label: str | None = None
    y_label: str | None = None
    x_kind: ColumnKind | None = None
    series: list[str] = []
    rows: list[dict[str, Any]] = []
    box: list[BoxStats] | None = None
    heatmap: HeatmapData | None = None
    meta: SourceMeta
    warnings: list[str] = []


class SplitConfig(BaseModel):
    strategy: Literal["random", "stratified", "chronological"] = "random"
    test_size: float = Field(default=0.2, ge=0.05, le=0.5)
    stratify_column: str | None = None
    time_column: str | None = None
    random_state: int = 42


class TransformStep(BaseModel):
    """One recipe step. ``op`` selects the operation; the other fields are op-specific."""

    op: Literal[
        "drop_columns", "select_columns", "rename", "drop_duplicates", "fill_missing",
        "drop_missing", "parse_dates", "cast", "filter_rows", "derive_date_parts",
        "derive_ratio", "derive_log", "bin_numeric", "one_hot", "scale",
    ]
    columns: list[str] = []
    mapping: dict[str, str] = {}
    strategy: Literal["mean", "median", "mode", "constant"] | None = None
    value: Any = None
    to: Literal["numeric", "string", "category", "datetime", "boolean"] | None = None
    filters: list[Filter] = []
    numerator: str | None = None
    denominator: str | None = None
    new_column: str | None = None
    bins: int | None = Field(default=None, ge=2, le=50)
    method: Literal["standard", "minmax"] | None = None
    format: str | None = None


class TransformRequest(BaseModel):
    steps: list[TransformStep] = Field(min_length=1, max_length=50)
    name: str | None = Field(default=None, max_length=120)
    split: SplitConfig | None = None
    preview: bool = False


class StepLog(BaseModel):
    op: str
    description: str
    rows_before: int
    rows_after: int
    columns_added: list[str] = []
    columns_removed: list[str] = []
    fitted: dict[str, Any] = {}
    fit_scope: Literal["none", "all_rows", "train_only"] = "none"


class TransformResult(BaseModel):
    preview: bool
    dataset_id: str | None
    n_rows_before: int
    n_rows_after: int
    n_cols_before: int
    n_cols_after: int
    log: list[StepLog]
    columns: list[ColumnInfo]
    rows: list[list[Any]]
    warnings: list[str] = []
