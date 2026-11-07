"""Evaluation metrics computed on the held-out test partition only."""

from __future__ import annotations

import warnings

import numpy as np
import pandas as pd
from sklearn import metrics as skm

from app.schemas.experiments import Confusion, MetricValue, PredPoint
from app.schemas.profile import Histogram
from app.utils.frames import clean_float

MAX_CONFUSION_LABELS = 20
MAX_SCATTER_POINTS = 1_000


def classification_metrics(y_true: pd.Series, y_pred: np.ndarray, proba: np.ndarray | None,
                           classes: list[str], positive: str | None) -> dict[str, float | None]:
    y_true = y_true.astype("str").to_numpy()
    y_pred = np.asarray(y_pred).astype(str)
    result: dict[str, float | None] = {
        "accuracy": skm.accuracy_score(y_true, y_pred),
        "balanced_accuracy": skm.balanced_accuracy_score(y_true, y_pred),
    }
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if positive is not None:
            result["precision"] = skm.precision_score(y_true, y_pred, pos_label=positive, zero_division=0)
            result["recall"] = skm.recall_score(y_true, y_pred, pos_label=positive, zero_division=0)
            result["f1"] = skm.f1_score(y_true, y_pred, pos_label=positive, zero_division=0)
        result["precision_macro"] = skm.precision_score(y_true, y_pred, average="macro", zero_division=0)
        result["recall_macro"] = skm.recall_score(y_true, y_pred, average="macro", zero_division=0)
        result["f1_macro"] = skm.f1_score(y_true, y_pred, average="macro", zero_division=0)
        result["f1_weighted"] = skm.f1_score(y_true, y_pred, average="weighted", zero_division=0)
        if proba is not None and len(set(y_true)) > 1:
            if positive is not None:
                scores = proba[:, classes.index(positive)]
                binary = (y_true == positive).astype(int)
                result["roc_auc"] = skm.roc_auc_score(binary, scores)
                result["pr_auc"] = skm.average_precision_score(binary, scores)
            elif set(y_true) <= set(classes):
                try:
                    result["roc_auc_ovr_macro"] = skm.roc_auc_score(y_true, proba, multi_class="ovr",
                                                                    average="macro", labels=classes)
                except ValueError:
                    result["roc_auc_ovr_macro"] = None
    return {k: clean_float(v, 6) for k, v in result.items()}


def primary_classification(metrics: dict[str, float | None], binary: bool) -> MetricValue:
    if binary and metrics.get("roc_auc") is not None:
        return MetricValue(name="roc_auc", value=metrics["roc_auc"])
    if binary:
        return MetricValue(name="f1", value=metrics.get("f1"))
    return MetricValue(name="f1_macro", value=metrics.get("f1_macro"))


def confusion(y_true: pd.Series, y_pred: np.ndarray, classes: list[str]) -> Confusion | None:
    if len(classes) > MAX_CONFUSION_LABELS:
        return None
    matrix = skm.confusion_matrix(y_true.astype("str"), np.asarray(y_pred).astype(str), labels=classes)
    return Confusion(labels=classes, matrix=matrix.astype(int).tolist())


def regression_metrics(y_true: pd.Series, y_pred: np.ndarray) -> dict[str, float | None]:
    actual = y_true.to_numpy(dtype=float)
    predicted = np.asarray(y_pred, dtype=float)
    result: dict[str, float | None] = {
        "mae": skm.mean_absolute_error(actual, predicted),
        "rmse": float(np.sqrt(skm.mean_squared_error(actual, predicted))),
        "r2": skm.r2_score(actual, predicted) if len(actual) > 1 else None,
        "median_ae": skm.median_absolute_error(actual, predicted),
        "mape": skm.mean_absolute_percentage_error(actual, predicted) if np.all(actual != 0) else None,
    }
    return {k: clean_float(v, 6) for k, v in result.items()}


def primary_regression(metrics: dict[str, float | None]) -> MetricValue:
    return MetricValue(name="rmse", value=metrics.get("rmse"), higher_is_better=False)


def pred_vs_actual(y_true: pd.Series, y_pred: np.ndarray, seed: int) -> list[PredPoint]:
    actual = y_true.to_numpy(dtype=float)
    predicted = np.asarray(y_pred, dtype=float)
    index = np.arange(len(actual))
    if len(index) > MAX_SCATTER_POINTS:
        index = np.random.default_rng(seed).choice(index, MAX_SCATTER_POINTS, replace=False)
    return [PredPoint(actual=float(actual[i]), predicted=float(predicted[i])) for i in index]


def residual_histogram(y_true: pd.Series, y_pred: np.ndarray) -> Histogram | None:
    residuals = y_true.to_numpy(dtype=float) - np.asarray(y_pred, dtype=float)
    residuals = residuals[np.isfinite(residuals)]
    if residuals.size == 0:
        return None
    counts, edges = np.histogram(residuals, bins=30)
    return Histogram(edges=[float(e) for e in edges], counts=[int(c) for c in counts])
