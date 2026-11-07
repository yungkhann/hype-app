"""Model pipelines. Every preprocessing step lives inside the estimator pipeline, so it is fitted on the
training partition only and merely applied to the test partition.

Add a model: extend ``MODEL_OPTIONS`` and ``build_estimator``.
"""

from __future__ import annotations

import importlib.util
from typing import Any

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.dummy import DummyClassifier, DummyRegressor
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression, LogisticRegression, Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from app.core.errors import ValidationFailed
from app.schemas.experiments import ModelName, ModelOption, TaskType
from app.utils.frames import infer_kind

MISSING_TOKEN = "__missing__"
MAX_ONE_HOT = 30

CATBOOST_AVAILABLE = importlib.util.find_spec("catboost") is not None

MODEL_OPTIONS: list[ModelOption] = [
    ModelOption(name="dummy", label="Dummy baseline", tasks=["classification", "regression"],
                available=True, note="Predicts the training prior (classification) or mean (regression)."),
    ModelOption(name="logistic_regression", label="Logistic regression", tasks=["classification"],
                available=True),
    ModelOption(name="linear_regression", label="Linear regression", tasks=["regression"], available=True),
    ModelOption(name="ridge", label="Ridge regression", tasks=["regression"], available=True),
    ModelOption(name="random_forest", label="Random forest", tasks=["classification", "regression"],
                available=True),
    ModelOption(name="catboost", label="CatBoost", tasks=["classification", "regression"],
                available=CATBOOST_AVAILABLE,
                note=None if CATBOOST_AVAILABLE else "Install requirements-optional.txt to enable."),
]

# Accepted hyperparameters with (min, max) bounds. Anything else in ``params`` is rejected.
PARAM_BOUNDS: dict[str, tuple[float, float]] = {
    "n_estimators": (10, 1000), "max_depth": (1, 50), "min_samples_leaf": (1, 500),
    "C": (1e-4, 1e4), "alpha": (1e-6, 1e4), "iterations": (10, 3000), "depth": (1, 10),
    "learning_rate": (1e-3, 1.0),
}
CHOICE_PARAMS: dict[str, set[Any]] = {"class_weight": {None, "balanced"}}


def validate_params(params: dict[str, Any]) -> dict[str, Any]:
    clean: dict[str, Any] = {}
    for key, value in params.items():
        if key in CHOICE_PARAMS:
            if value not in CHOICE_PARAMS[key]:
                raise ValidationFailed(f"'{key}' must be one of {sorted(map(str, CHOICE_PARAMS[key]))}.",
                                       code="invalid_param")
            clean[key] = value
        elif key in PARAM_BOUNDS:
            if value is None:
                continue
            low, high = PARAM_BOUNDS[key]
            try:
                number = float(value)
            except (TypeError, ValueError) as exc:
                raise ValidationFailed(f"'{key}' must be a number.", code="invalid_param") from exc
            if not low <= number <= high:
                raise ValidationFailed(f"'{key}' must be between {low:g} and {high:g}.", code="invalid_param")
            clean[key] = int(number) if key in {"n_estimators", "max_depth", "min_samples_leaf",
                                                "iterations", "depth"} else number
        else:
            raise ValidationFailed(f"Unknown hyperparameter '{key}'.", code="invalid_param")
    return clean


def expand_dates(frame: pd.DataFrame) -> pd.DataFrame:
    """Stateless: datetime columns become numeric calendar parts; booleans become 0/1."""
    out = frame.copy()
    for column in list(out.columns):
        series = out[column]
        if pd.api.types.is_datetime64_any_dtype(series):
            out[f"{column}__year"] = series.dt.year.astype(float)
            out[f"{column}__month"] = series.dt.month.astype(float)
            out[f"{column}__day"] = series.dt.day.astype(float)
            out[f"{column}__dayofweek"] = series.dt.day_of_week.astype(float)
            out = out.drop(columns=[column])
        elif pd.api.types.is_bool_dtype(series):
            out[column] = series.astype(float)
    return out


def split_kinds(frame: pd.DataFrame) -> tuple[list[str], list[str]]:
    numeric, categorical = [], []
    for column in frame.columns:
        (numeric if infer_kind(frame[column]) == "numeric" else categorical).append(column)
    return numeric, categorical


def prepare_categoricals(frame: pd.DataFrame, categorical: list[str]) -> pd.DataFrame:
    out = frame.copy()
    for column in categorical:
        out[column] = out[column].astype("str").where(out[column].notna(), MISSING_TOKEN)
        out[column] = out[column].fillna(MISSING_TOKEN).astype(object)
    return out


def _preprocessor(numeric: list[str], categorical: list[str], scale: bool) -> ColumnTransformer:
    numeric_steps: list[tuple[str, Any]] = [("impute", SimpleImputer(strategy="median"))]
    if scale:
        numeric_steps.append(("scale", StandardScaler()))
    categorical_steps = [
        ("impute", SimpleImputer(strategy="constant", fill_value=MISSING_TOKEN)),
        ("encode", OneHotEncoder(handle_unknown="infrequent_if_exist", max_categories=MAX_ONE_HOT,
                                 sparse_output=False)),
    ]
    transformers = []
    if numeric:
        transformers.append(("num", Pipeline(numeric_steps), numeric))
    if categorical:
        transformers.append(("cat", Pipeline(categorical_steps), categorical))
    return ColumnTransformer(transformers, remainder="drop", verbose_feature_names_out=True)


class CatBoostWrapper:
    """Adapter so CatBoost uses native categorical handling but shares the sklearn interface."""

    def __init__(self, task: TaskType, categorical: list[str], params: dict[str, Any], seed: int) -> None:
        from catboost import CatBoostClassifier, CatBoostRegressor

        base = {"iterations": params.get("iterations", 500), "depth": params.get("depth", 6),
                "random_seed": seed, "verbose": 0, "allow_writing_files": False, "thread_count": -1}
        if "learning_rate" in params:
            base["learning_rate"] = params["learning_rate"]
        if task == "classification" and params.get("class_weight") == "balanced":
            base["auto_class_weights"] = "Balanced"
        self.model = (CatBoostClassifier if task == "classification" else CatBoostRegressor)(**base)
        self.categorical = categorical
        self.columns: list[str] = []

    def fit(self, X: pd.DataFrame, y: pd.Series) -> CatBoostWrapper:
        self.columns = list(X.columns)
        self.model.fit(X, y, cat_features=[c for c in self.categorical if c in X.columns])
        return self

    def predict(self, X: pd.DataFrame) -> np.ndarray:
        prediction = self.model.predict(X)
        return np.asarray(prediction).reshape(-1)

    def predict_proba(self, X: pd.DataFrame) -> np.ndarray:
        return self.model.predict_proba(X)

    @property
    def classes_(self) -> np.ndarray:
        return np.asarray(self.model.classes_)

    def importances(self) -> dict[str, float]:
        values = self.model.get_feature_importance()
        return {c: float(v) for c, v in zip(self.columns, values, strict=True)}


def build_estimator(model: ModelName, task: TaskType, numeric: list[str], categorical: list[str],
                    params: dict[str, Any], seed: int) -> Any:
    if model == "catboost":
        if not CATBOOST_AVAILABLE:
            raise ValidationFailed("CatBoost is not installed. Install requirements-optional.txt.",
                                   code="model_unavailable")
        return CatBoostWrapper(task, categorical, params, seed)
    if model == "dummy":
        estimator: Any = DummyClassifier(strategy="prior") if task == "classification" \
            else DummyRegressor(strategy="mean")
        scale = False
    elif model == "logistic_regression":
        if task != "classification":
            raise ValidationFailed("Logistic regression is for classification.", code="model_task_mismatch")
        estimator = LogisticRegression(max_iter=2000, C=params.get("C", 1.0),
                                       class_weight=params.get("class_weight"))
        scale = True
    elif model in {"linear_regression", "ridge"}:
        if task != "regression":
            raise ValidationFailed(f"{model} is for regression.", code="model_task_mismatch")
        estimator = LinearRegression() if model == "linear_regression" else Ridge(alpha=params.get("alpha", 1.0))
        scale = True
    elif model == "random_forest":
        common = {"n_estimators": params.get("n_estimators", 200), "max_depth": params.get("max_depth"),
                  "min_samples_leaf": params.get("min_samples_leaf", 1), "n_jobs": -1, "random_state": seed}
        estimator = RandomForestClassifier(class_weight=params.get("class_weight"), **common) \
            if task == "classification" else RandomForestRegressor(**common)
        scale = False
    else:  # pragma: no cover - guarded by the schema Literal
        raise ValidationFailed(f"Unknown model '{model}'.", code="unknown_model")
    return Pipeline([("prep", _preprocessor(numeric, categorical, scale)), ("model", estimator)])


def importances(estimator: Any, model: ModelName, source_columns: list[str]) -> tuple[dict[str, float], str | None]:
    """Importance per *source* column (one-hot and date parts are summed back to their origin)."""
    if model == "catboost":
        raw, method = estimator.importances(), "CatBoost prediction-value change"
    elif model == "dummy":
        return {}, None
    else:
        prep, fitted = estimator.named_steps["prep"], estimator.named_steps["model"]
        names = prep.get_feature_names_out()
        if hasattr(fitted, "feature_importances_"):
            values, method = fitted.feature_importances_, "impurity-based importance (random forest)"
        elif hasattr(fitted, "coef_"):
            coef = np.atleast_2d(fitted.coef_)
            values, method = np.abs(coef).mean(axis=0), "|coefficient| on standardized features"
        else:
            return {}, None
        raw = {str(n): float(v) for n, v in zip(names, values, strict=True)}

    totals: dict[str, float] = {}
    for name, value in raw.items():
        base = name.split("__", 1)[1] if name.startswith(("num__", "cat__")) else name
        origin = next((c for c in sorted(source_columns, key=len, reverse=True)
                       if base == c or base.startswith(f"{c}_") or base.startswith(f"{c}__")), base)
        totals[origin] = totals.get(origin, 0.0) + value
    total = sum(totals.values()) or 1.0
    return {k: v / total for k, v in totals.items()}, method
