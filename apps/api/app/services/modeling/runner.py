"""Experiment execution in a local thread pool so training never blocks the API.

Records are JSON files under ``experiments/``; predictions are Parquet files beside them. Every run
trains the requested model *and* a dummy baseline on the identical split.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

from app.core.config import Settings
from app.core.errors import NotFoundError, ValidationFailed
from app.schemas.experiments import (
    ExperimentDetail,
    ExperimentRequest,
    ExperimentSummary,
    FeatureImportance,
    ModelCheckRequest,
    ModelCheckResponse,
    ModelWarning,
    SplitInfo,
)
from app.schemas.profile import CategoryCount
from app.services.datasets import DatasetService
from app.services.modeling import metrics as m
from app.services.modeling.checks import check_problem
from app.services.modeling.pipelines import (
    MODEL_OPTIONS,
    build_estimator,
    expand_dates,
    importances,
    prepare_categoricals,
    split_kinds,
    validate_params,
)
from app.storage.paths import new_id
from app.storage.workspace import Workspace, read_json, write_json
from app.utils.frames import display_value, is_numeric, now_iso

logger = logging.getLogger("atlas.modeling")
MAX_PROBA_COLUMNS = 10


def label_series(y: pd.Series) -> pd.Series:
    """Class labels as strings; integer-valued floats lose their '.0' so 1.0 and 1 match."""
    if is_numeric(y):
        values = y.astype(float)
        if np.all(np.mod(values.dropna(), 1) == 0):
            return values.astype("Int64").astype("str")
    return y.astype("str")


def _split(data: pd.DataFrame, y: pd.Series, request: ExperimentRequest,
           warnings: list[ModelWarning]) -> tuple[pd.Index, pd.Index, dict[str, Any]]:
    split = request.split
    info: dict[str, Any] = {"strategy": split.strategy, "test_size": split.test_size,
                            "random_state": split.random_state, "time_column": None}
    if split.strategy == "chronological":
        time_values = data[split.time_column]
        order = time_values.sort_values(kind="stable", na_position="first").index
        cut = int(np.floor(len(order) * (1 - split.test_size)))
        train_index, test_index = order[:cut], order[cut:]
        info["time_column"] = split.time_column
        info["train_period"] = [display_value(time_values.loc[train_index].min()),
                                display_value(time_values.loc[train_index].max())]
        info["test_period"] = [display_value(time_values.loc[test_index].min()),
                               display_value(time_values.loc[test_index].max())]
        return train_index, test_index, info
    stratify = None
    if split.strategy == "stratified" and request.task == "classification":
        if y.value_counts().min() >= 2:
            stratify = y
        else:
            warnings.append(ModelWarning(code="stratify_disabled", severity="warning",
                                         message="A class has a single row; a plain random split is used."))
            info["strategy"] = "random"
    elif split.strategy == "stratified":
        info["strategy"] = "random"
    train_index, test_index = train_test_split(data.index, test_size=split.test_size,
                                               random_state=split.random_state, stratify=stratify)
    return pd.Index(train_index), pd.Index(test_index), info


def train_experiment(frame: pd.DataFrame, request: ExperimentRequest, check: ModelCheckResponse,
                     settings: Settings) -> tuple[dict[str, Any], pd.DataFrame]:
    """Train the model and its baseline. Returns (record fields, predictions frame)."""
    params = validate_params(request.params)
    warnings = list(check.warnings)
    data = frame[frame[request.target].notna()]
    features = check.usable_features
    y_all = label_series(data[request.target]) if request.task == "classification" \
        else data[request.target].astype(float)

    train_index, test_index, info = _split(data, y_all, request, warnings)
    n_train_full = len(train_index)
    sampled = False
    if n_train_full > settings.model_max_train_rows:
        stratify = y_all.loc[train_index] if request.task == "classification" \
            and y_all.loc[train_index].value_counts().min() >= 2 else None
        train_index, _ = train_test_split(train_index, train_size=settings.model_max_train_rows,
                                          random_state=request.split.random_state, stratify=stratify)
        train_index = pd.Index(train_index)
        sampled = True
        warnings.append(ModelWarning(code="train_sampled", severity="info",
                                     message=f"Training used a random sample of {len(train_index):,} of "
                                             f"{n_train_full:,} training rows (ATLAS_MODEL_MAX_TRAIN_ROWS)."))

    X_train = expand_dates(data.loc[train_index, features])
    X_test = expand_dates(data.loc[test_index, features])
    y_train, y_test = y_all.loc[train_index], y_all.loc[test_index]
    numeric, categorical = split_kinds(X_train)
    X_train = prepare_categoricals(X_train, categorical)
    X_test = prepare_categoricals(X_test, categorical)
    for column in numeric:
        X_train[column] = X_train[column].astype("float64")
        X_test[column] = X_test[column].astype("float64")

    if request.task == "classification" and y_train.nunique() < 2:
        raise ValidationFailed("The training partition contains a single class. Use a stratified split "
                               "or a larger test size.", code="single_class_train")

    seed = request.split.random_state
    model = build_estimator(request.model, request.task, numeric, categorical, params, seed)
    baseline = build_estimator("dummy", request.task, numeric, categorical, {}, seed)
    model.fit(X_train, y_train)
    baseline.fit(X_train, y_train)
    prediction = model.predict(X_test)
    baseline_prediction = baseline.predict(X_test)

    record: dict[str, Any] = {"features_used": features, "warnings": [w.model_dump() for w in warnings]}
    predictions = pd.DataFrame({"row_index": test_index.to_numpy(), "actual": y_test.to_numpy(),
                                "predicted": prediction})
    if request.task == "classification":
        classes = [str(c) for c in model.classes_]
        counts = y_train.value_counts()
        positive = str(counts.index[-1]) if len(classes) == 2 else None  # minority class in training
        proba = model.predict_proba(X_test) if hasattr(model, "predict_proba") else None
        baseline_proba = baseline.predict_proba(X_test)
        record["metrics"] = m.classification_metrics(y_test, prediction, proba, classes, positive)
        record["baseline_metrics"] = m.classification_metrics(y_test, baseline_prediction, baseline_proba,
                                                              classes, positive)
        record["primary_metric"] = m.primary_classification(record["metrics"], positive is not None).model_dump()
        record["baseline_metric"] = m.primary_classification(record["baseline_metrics"],
                                                             positive is not None).model_dump()
        record["positive_label"] = positive
        record["class_labels"] = classes
        confusion = m.confusion(y_test, prediction, classes)
        record["confusion"] = confusion.model_dump() if confusion else None
        record["class_balance_test"] = [CategoryCount(value=str(v), count=int(c)).model_dump()
                                        for v, c in y_test.value_counts().head(20).items()]
        if proba is not None and len(classes) <= MAX_PROBA_COLUMNS:
            for index, label in enumerate(classes):
                predictions[f"proba_{label}"] = proba[:, index]
    else:
        record["metrics"] = m.regression_metrics(y_test, prediction)
        record["baseline_metrics"] = m.regression_metrics(y_test, baseline_prediction)
        record["primary_metric"] = m.primary_regression(record["metrics"]).model_dump()
        record["baseline_metric"] = m.primary_regression(record["baseline_metrics"]).model_dump()
        record["pred_vs_actual"] = [p.model_dump() for p in m.pred_vs_actual(y_test, prediction, seed)]
        histogram = m.residual_histogram(y_test, prediction)
        record["residual_histogram"] = histogram.model_dump() if histogram else None
        predictions["residual"] = y_test.to_numpy(dtype=float) - np.asarray(prediction, dtype=float)

    scores, method = importances(model, request.model, features)
    record["feature_importance"] = [FeatureImportance(feature=k, importance=round(v, 6)).model_dump()
                                    for k, v in sorted(scores.items(), key=lambda kv: -kv[1])[:30]]
    record["importance_method"] = method
    record["split_info"] = SplitInfo(n_train=n_train_full, n_test=len(test_index),
                                     n_train_used=len(train_index), train_sampled=sampled,
                                     **info).model_dump()
    return record, predictions


class ExperimentManager:
    def __init__(self, workspace: Workspace, datasets: DatasetService, settings: Settings) -> None:
        self.ws = workspace
        self.datasets = datasets
        self.settings = settings
        self.executor = ThreadPoolExecutor(max_workers=settings.model_workers,
                                           thread_name_prefix="atlas-train")
        self._recover_interrupted()

    def _recover_interrupted(self) -> None:
        for path in self.ws.experiments_dir.glob("*.json"):
            record = read_json(path)
            if record and record.get("status") in {"queued", "running"}:
                record.update(status="failed", error="Interrupted: the API restarted during training.",
                              finished_at=now_iso())
                write_json(path, record)

    def shutdown(self) -> None:
        self.executor.shutdown(wait=False, cancel_futures=True)

    # ---- checks --------------------------------------------------------------------
    def check(self, request: ModelCheckRequest) -> ModelCheckResponse:
        frame = self.datasets.frame(request.dataset_id)
        manifest = self.ws.read_manifest(request.dataset_id)
        return check_problem(frame, target=request.target, task=request.task, features=request.features,
                             exclude=request.exclude, split=request.split, lineage=manifest.get("lineage"))

    # ---- lifecycle -------------------------------------------------------------------
    def submit(self, request: ExperimentRequest) -> ExperimentDetail:
        option = next(o for o in MODEL_OPTIONS if o.name == request.model)
        if request.task not in option.tasks:
            raise ValidationFailed(f"{option.label} does not support {request.task}.", code="model_task_mismatch")
        if not option.available:
            raise ValidationFailed(f"{option.label} is not installed. {option.note or ''}".strip(),
                                   code="model_unavailable")
        validate_params(request.params)
        if request.split.strategy == "chronological" and not request.split.time_column:
            raise ValidationFailed("Choose a time column for a chronological split.", code="invalid_split")
        check = self.check(ModelCheckRequest(dataset_id=request.dataset_id, target=request.target,
                                             task=request.task, features=request.features,
                                             exclude=request.exclude, split=request.split))
        if not check.can_train:
            blocking = [w.message for w in check.warnings if w.severity == "critical"
                        and not w.code.startswith("leakage")]
            raise ValidationFailed("Training cannot start: " + " ".join(blocking), code="cannot_train",
                                   details=check.model_dump())
        experiment_id = new_id()
        dataset_name = self.datasets.name(request.dataset_id)
        record = {
            "id": experiment_id,
            "name": request.name or f"{request.model} → {request.target}",
            "status": "queued", "dataset_id": request.dataset_id, "dataset_name": dataset_name,
            "target": request.target, "task": request.task, "model": request.model,
            "created_at": now_iso(), "request": request.model_dump(),
            "warnings": [w.model_dump() for w in check.warnings],
            "dropped_features": [d.model_dump() for d in check.dropped_features],
        }
        write_json(self.ws.experiment_path(experiment_id), record)
        self.executor.submit(self._run, experiment_id, check)
        return ExperimentDetail.model_validate(record)

    def _run(self, experiment_id: str, check: ModelCheckResponse) -> None:
        path = self.ws.experiment_path(experiment_id)
        record = read_json(path)
        started = time.perf_counter()
        record.update(status="running", started_at=now_iso())
        write_json(path, record)
        try:
            request = ExperimentRequest.model_validate(record["request"])
            frame = self.datasets.frame(request.dataset_id)
            fields, predictions = train_experiment(frame, request, check, self.settings)
            predictions.to_parquet(self.ws.predictions_path(experiment_id), index=False)
            record.update(fields, status="completed")
        except ValidationFailed as exc:
            record.update(status="failed", error=exc.message)
        except Exception as exc:  # surfaced to the user; full trace in the API log
            logger.exception("Experiment %s failed", experiment_id)
            record.update(status="failed", error=f"{type(exc).__name__}: {exc}")
        record.update(finished_at=now_iso(), duration_s=round(time.perf_counter() - started, 3))
        write_json(path, record)

    def get(self, experiment_id: str) -> ExperimentDetail:
        record = read_json(self.ws.experiment_path(experiment_id))
        if record is None:
            raise NotFoundError(f"Experiment {experiment_id} does not exist.", code="experiment_not_found")
        return ExperimentDetail.model_validate(record)

    def list(self, dataset_id: str | None = None) -> list[ExperimentSummary]:
        records = [read_json(p) for p in self.ws.experiments_dir.glob("*.json")]
        summaries = [ExperimentSummary.model_validate(r) for r in records if r]
        if dataset_id:
            summaries = [s for s in summaries if s.dataset_id == dataset_id]
        return sorted(summaries, key=lambda s: s.created_at, reverse=True)

    def delete(self, experiment_id: str) -> None:
        path = self.ws.experiment_path(experiment_id)
        if not path.exists():
            raise NotFoundError(f"Experiment {experiment_id} does not exist.", code="experiment_not_found")
        path.unlink()
        self.ws.predictions_path(experiment_id).unlink(missing_ok=True)

    def predictions(self, experiment_id: str) -> pd.DataFrame:
        self.get(experiment_id)
        path = self.ws.predictions_path(experiment_id)
        if not path.exists():
            raise NotFoundError("This experiment has no predictions (it did not complete).",
                                code="predictions_not_found")
        return pd.read_parquet(path)
