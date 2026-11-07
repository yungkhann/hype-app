"""Pre-training validation: target compatibility, feature eligibility, and leakage hazards.

Leakage checks are heuristics. They warn; they never silently drop a feature the user selected,
except columns that cannot carry signal (constant, all-missing) or that baselines cannot use (free text).
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from app.core.errors import ValidationFailed
from app.schemas.analysis import SplitConfig
from app.schemas.experiments import DroppedFeature, ModelCheckResponse, ModelWarning, TaskType
from app.schemas.profile import CategoryCount
from app.utils.frames import display_value, infer_kind, is_numeric, require_columns

MAX_CLASSES = 50
CLASSIFICATION_MAX_INT_LEVELS = 15
MIN_ROWS = 20
LEAKAGE_CORR = 0.98
LEAKAGE_PURITY = 0.995
ID_HINTS = ("id", "uuid", "guid", "key")


def suggest_task(target: pd.Series) -> TaskType | None:
    kind = infer_kind(target)
    if kind in {"boolean", "categorical"}:
        return "classification"
    if kind == "numeric":
        unique = target.nunique(dropna=True)
        integer_like = bool(np.all(np.mod(target.dropna().to_numpy(dtype=float), 1) == 0))
        if integer_like and unique <= CLASSIFICATION_MAX_INT_LEVELS:
            return "classification"
        return "regression"
    return None


def _is_identifier(name: str, series: pd.Series) -> bool:
    non_null = series.dropna()
    if len(non_null) < MIN_ROWS:
        return False
    if non_null.nunique() / len(non_null) < 0.98:
        return False
    lowered = name.lower()
    hinted = any(lowered == h or lowered.endswith(f"_{h}") or lowered.startswith(f"{h}_")
                 or lowered.endswith(h) for h in ID_HINTS)
    return hinted or not pd.api.types.is_float_dtype(series)


def select_features(frame: pd.DataFrame, target: str, features: list[str] | None,
                    exclude: list[str]) -> tuple[list[str], list[DroppedFeature], list[ModelWarning]]:
    candidates = features if features is not None else [c for c in frame.columns if c != target]
    require_columns(frame, list(candidates) + list(exclude))
    candidates = [c for c in candidates if c != target and c not in exclude]
    usable: list[str] = []
    dropped: list[DroppedFeature] = []
    warnings: list[ModelWarning] = []
    explicit = features is not None
    for column in candidates:
        series = frame[column]
        kind = infer_kind(series)
        if series.notna().sum() == 0:
            dropped.append(DroppedFeature(column=column, reason="all values missing"))
        elif series.nunique(dropna=True) <= 1:
            dropped.append(DroppedFeature(column=column, reason="constant"))
        elif kind != "datetime" and _is_identifier(column, series):
            if explicit and kind != "text":
                usable.append(column)
                warnings.append(ModelWarning(code="identifier_feature", severity="warning", column=column,
                                             message=f"'{column}' is unique per row and looks like an "
                                                     "identifier; models can memorize it."))
            else:
                dropped.append(DroppedFeature(column=column, reason="looks like an identifier"))
        elif kind == "text":
            dropped.append(DroppedFeature(column=column, reason="free text is not supported by baselines"))
        else:
            usable.append(column)
            if kind == "datetime":
                warnings.append(ModelWarning(code="datetime_feature", severity="info", column=column,
                                             message=f"'{column}' is expanded into year/month/day/weekday "
                                                     "features."))
    return usable, dropped, warnings


def _leakage(frame: pd.DataFrame, target: str, task: TaskType, usable: list[str]) -> list[ModelWarning]:
    warnings: list[ModelWarning] = []
    sample = frame if len(frame) <= 100_000 else frame.sample(100_000, random_state=0)
    y = sample[target]
    lowered_target = target.lower()
    for column in usable:
        x = sample[column]
        if lowered_target in column.lower() and column.lower() != lowered_target:
            warnings.append(ModelWarning(code="name_overlap", severity="info", column=column,
                                         message=f"'{column}' contains the target's name. Confirm it is "
                                                 "known before the outcome."))
        if task == "regression" and is_numeric(x) and is_numeric(y):
            corr = x.corr(y)
            if pd.notna(corr) and abs(corr) >= LEAKAGE_CORR:
                warnings.append(ModelWarning(
                    code="leakage_correlation", severity="critical", column=column,
                    message=f"'{column}' correlates almost perfectly with the target (r = {corr:.3f}). "
                            "It may be derived from the outcome."))
        elif task == "classification":
            groups = x.astype("str") if not is_numeric(x) else x
            n_unique = groups.nunique(dropna=True)
            if 1 < n_unique <= 5_000 and n_unique < len(sample) * 0.5:
                crosstab = pd.crosstab(groups, y.astype("str"))
                purity = float(crosstab.max(axis=1).sum() / max(crosstab.to_numpy().sum(), 1))
                majority = float(y.astype("str").value_counts(normalize=True).iloc[0])
                if purity >= LEAKAGE_PURITY and purity > majority + 0.05:
                    warnings.append(ModelWarning(
                        code="leakage_purity", severity="critical", column=column,
                        message=f"Each value of '{column}' maps to a single target class "
                                f"({purity:.1%} purity). It may encode the outcome."))
    return warnings


def check_problem(frame: pd.DataFrame, *, target: str, task: TaskType | None,
                  features: list[str] | None, exclude: list[str], split: SplitConfig | None,
                  lineage: dict[str, Any] | None = None) -> ModelCheckResponse:
    require_columns(frame, [target])
    y = frame[target]
    target_kind = infer_kind(y)
    suggested = suggest_task(y)
    task = task or suggested
    warnings: list[ModelWarning] = []
    n_missing = int(y.isna().sum())
    if n_missing:
        warnings.append(ModelWarning(code="target_missing", severity="warning", column=target,
                                     message=f"{n_missing:,} rows have no target and are excluded."))
    labelled = frame[y.notna()]
    n_classes = None
    balance = None

    if task is None:
        warnings.append(ModelWarning(code="target_unsupported", severity="critical", column=target,
                                     message=f"'{target}' is {target_kind}; it cannot be a "
                                             "classification or regression target."))
    elif task == "regression":
        if not is_numeric(y):
            warnings.append(ModelWarning(code="target_not_numeric", severity="critical", column=target,
                                         message=f"Regression needs a numeric target; '{target}' is "
                                                 f"{target_kind}."))
        elif suggested == "classification":
            warnings.append(ModelWarning(code="target_few_levels", severity="info", column=target,
                                         message=f"'{target}' has only {y.nunique()} distinct values; "
                                                 "classification may fit better."))
    else:
        counts = labelled[target].astype("str").value_counts()
        n_classes = int(len(counts))
        balance = [CategoryCount(value=display_value(v), count=int(c)) for v, c in counts.head(20).items()]
        if n_classes < 2:
            warnings.append(ModelWarning(code="single_class", severity="critical", column=target,
                                         message="The target has fewer than two classes."))
        elif n_classes > MAX_CLASSES:
            warnings.append(ModelWarning(code="too_many_classes", severity="critical", column=target,
                                         message=f"{n_classes} classes exceeds the limit of {MAX_CLASSES}. "
                                                 "Is this really a classification target?"))
        else:
            minority_share = counts.iloc[-1] / counts.sum()
            if minority_share < 0.05:
                warnings.append(ModelWarning(
                    code="class_imbalance", severity="warning", column=target,
                    message=f"The smallest class is {minority_share:.1%} of rows. Accuracy will look "
                            "high by default; judge models by F1, recall, and PR-AUC."))
            if (counts < 2).any():
                warnings.append(ModelWarning(code="tiny_class", severity="warning", column=target,
                                             message="Some classes have a single row; stratification is "
                                                     "disabled for them."))

    usable, dropped, feature_warnings = select_features(frame, target, features, exclude)
    warnings.extend(feature_warnings)
    if task is not None:
        warnings.extend(_leakage(labelled, target, task, usable))
    if not usable:
        warnings.append(ModelWarning(code="no_features", severity="critical",
                                     message="No usable feature columns remain."))
    if len(labelled) < MIN_ROWS:
        warnings.append(ModelWarning(code="too_few_rows", severity="critical",
                                     message=f"Only {len(labelled)} labelled rows; at least {MIN_ROWS} are "
                                             "needed."))
    if split:
        if split.strategy == "chronological":
            if not split.time_column:
                warnings.append(ModelWarning(code="split_time_missing", severity="critical",
                                             message="Choose a time column for a chronological split."))
            elif split.time_column not in frame.columns:
                raise ValidationFailed(f"Unknown time column '{split.time_column}'.", code="unknown_column")
            elif infer_kind(frame[split.time_column]) not in {"datetime", "numeric"}:
                warnings.append(ModelWarning(code="split_time_type", severity="critical",
                                             column=split.time_column,
                                             message=f"'{split.time_column}' is not a date or number."))
        if split.strategy == "stratified" and task == "regression":
            warnings.append(ModelWarning(code="stratify_regression", severity="info",
                                         message="Stratification applies to classification only; a random "
                                                 "split is used."))
    if lineage:
        all_rows_fits = [log["op"] for log in lineage.get("log", []) if log.get("fit_scope") == "all_rows"]
        if all_rows_fits:
            warnings.append(ModelWarning(
                code="upstream_fit_leakage", severity="warning",
                message="This dataset was prepared with steps fitted on all rows "
                        f"({', '.join(sorted(set(all_rows_fits)))}). Test rows influenced that "
                        "preprocessing, so scores may be optimistic."))

    can_train = task is not None and not any(w.severity == "critical" and not w.code.startswith("leakage")
                                             for w in warnings)
    return ModelCheckResponse(target=target, target_kind=target_kind, suggested_task=suggested, task=task,
                              n_rows=int(len(frame)), n_target_missing=n_missing, n_classes=n_classes,
                              class_balance=balance, usable_features=usable, dropped_features=dropped,
                              warnings=warnings, can_train=can_train)
