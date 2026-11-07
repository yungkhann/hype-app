from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.analysis import SplitConfig
from app.schemas.common import ColumnKind
from app.schemas.profile import CategoryCount, Histogram
from app.storage.paths import ID_PATTERN

TaskType = Literal["classification", "regression"]
ModelName = Literal[
    "dummy", "logistic_regression", "linear_regression", "ridge", "random_forest", "catboost",
]
ExperimentStatus = Literal["queued", "running", "completed", "failed"]


class ModelOption(BaseModel):
    name: ModelName
    label: str
    tasks: list[TaskType]
    available: bool
    note: str | None = None


class ModelCheckRequest(BaseModel):
    dataset_id: str = Field(pattern=ID_PATTERN)
    target: str
    task: TaskType | None = None
    features: list[str] | None = None
    exclude: list[str] = []
    split: SplitConfig | None = None


class ModelWarning(BaseModel):
    code: str
    severity: Literal["info", "warning", "critical"]
    column: str | None = None
    message: str


class DroppedFeature(BaseModel):
    column: str
    reason: str


class ModelCheckResponse(BaseModel):
    target: str
    target_kind: ColumnKind
    suggested_task: TaskType | None
    task: TaskType | None
    n_rows: int
    n_target_missing: int
    n_classes: int | None = None
    class_balance: list[CategoryCount] | None = None
    usable_features: list[str]
    dropped_features: list[DroppedFeature]
    warnings: list[ModelWarning]
    can_train: bool


class ExperimentRequest(BaseModel):
    dataset_id: str = Field(pattern=ID_PATTERN)
    target: str
    task: TaskType
    model: ModelName
    features: list[str] | None = None
    exclude: list[str] = []
    split: SplitConfig = SplitConfig()
    params: dict[str, Any] = {}
    name: str | None = Field(default=None, max_length=120)


class SplitInfo(BaseModel):
    strategy: str
    test_size: float
    n_train: int
    n_test: int
    n_train_used: int
    train_sampled: bool
    time_column: str | None = None
    train_period: list[str] | None = None
    test_period: list[str] | None = None
    random_state: int


class FeatureImportance(BaseModel):
    feature: str
    importance: float


class Confusion(BaseModel):
    labels: list[str]
    matrix: list[list[int]]


class PredPoint(BaseModel):
    actual: float
    predicted: float


class MetricValue(BaseModel):
    name: str
    value: float | None
    higher_is_better: bool = True


class ExperimentSummary(BaseModel):
    id: str
    name: str
    status: ExperimentStatus
    dataset_id: str
    dataset_name: str
    target: str
    task: TaskType
    model: ModelName
    created_at: str
    started_at: str | None = None
    finished_at: str | None = None
    duration_s: float | None = None
    primary_metric: MetricValue | None = None
    baseline_metric: MetricValue | None = None
    error: str | None = None


class ExperimentDetail(ExperimentSummary):
    request: ExperimentRequest
    split_info: SplitInfo | None = None
    features_used: list[str] = []
    dropped_features: list[DroppedFeature] = []
    warnings: list[ModelWarning] = []
    metrics: dict[str, float | None] = {}
    baseline_metrics: dict[str, float | None] = {}
    positive_label: str | None = None
    class_labels: list[str] = []
    confusion: Confusion | None = None
    class_balance_test: list[CategoryCount] | None = None
    pred_vs_actual: list[PredPoint] | None = None
    residual_histogram: Histogram | None = None
    feature_importance: list[FeatureImportance] = []
    importance_method: str | None = None
