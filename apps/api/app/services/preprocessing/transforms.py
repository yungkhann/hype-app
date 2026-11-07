"""Reproducible transformation recipes.

A recipe is an ordered list of ``TransformStep``s applied to a copy of the dataset; the original is
never modified. Each step logs what it did and, for fitted steps (fill with mean/median/mode, one-hot,
scale, quantile bins), the exact parameters it learned. When a split is configured, fitted steps learn
from the training rows only and are then applied to every row — test data never informs a fit.
"""

from __future__ import annotations

import re
import warnings
from collections.abc import Callable
from typing import Any

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split

from app.core.errors import ValidationFailed
from app.schemas.analysis import SplitConfig, StepLog, TransformStep
from app.services.filters import apply_filters, describe_filters
from app.utils.frames import clean_float, display_value, is_numeric, require_columns

SPLIT_COLUMN = "split"
MAX_ONE_HOT_CATEGORIES = 50


class Recipe:
    def __init__(self, frame: pd.DataFrame, split: SplitConfig | None) -> None:
        self.frame = frame.copy()
        self.split = split
        self.split_column: str | None = None
        self.logs: list[StepLog] = []
        self.warnings: list[str] = []
        if split:
            self._assign_split(split)

    # ---- split ---------------------------------------------------------------------
    def _assign_split(self, split: SplitConfig) -> None:
        frame = self.frame
        name = SPLIT_COLUMN
        while name in frame.columns:
            name = f"{name}_"
        labels = pd.Series("train", index=frame.index, dtype="str")
        if split.strategy == "chronological":
            if not split.time_column:
                raise ValidationFailed("A chronological split needs a time column.", code="invalid_split")
            require_columns(frame, [split.time_column])
            time = frame[split.time_column]
            if not (pd.api.types.is_datetime64_any_dtype(time) or is_numeric(time)):
                raise ValidationFailed(f"'{split.time_column}' is not a date or number. Parse it as a "
                                       "date first, then split chronologically.", code="invalid_split")
            cutoff = time.quantile(1 - split.test_size)
            labels[time > cutoff] = "validation"
            labels[time.isna()] = "validation"
            detail = f"rows after {display_value(cutoff)} in '{split.time_column}' are validation"
        else:
            stratify = None
            if split.strategy == "stratified":
                if not split.stratify_column:
                    raise ValidationFailed("A stratified split needs a column to stratify on.",
                                           code="invalid_split")
                require_columns(frame, [split.stratify_column])
                stratify = frame[split.stratify_column].astype("str").fillna("∅")
                if stratify.value_counts().min() < 2:
                    raise ValidationFailed(f"'{split.stratify_column}' has classes with a single row; "
                                           "stratification is impossible.", code="invalid_split")
            _, test_index = train_test_split(frame.index, test_size=split.test_size,
                                             random_state=split.random_state, stratify=stratify)
            labels[test_index] = "validation"
            detail = f"{split.strategy} split, seed {split.random_state}"
        self.frame[name] = labels
        self.split_column = name
        n_valid = int((labels == "validation").sum())
        self.logs.append(StepLog(op="split", description=f"Assigned '{name}': {len(frame) - n_valid:,} "
                                 f"train / {n_valid:,} validation ({detail}).",
                                 rows_before=len(frame), rows_after=len(frame), columns_added=[name]))

    def fit_rows(self) -> tuple[pd.DataFrame, str]:
        """Rows a fitted step may learn from, and the scope label for its log."""
        if self.split_column:
            return self.frame[self.frame[self.split_column] == "train"], "train_only"
        return self.frame, "all_rows"

    # ---- run -----------------------------------------------------------------------
    def apply(self, step: TransformStep) -> None:
        before_rows, before_cols = len(self.frame), list(self.frame.columns)
        handler = STEPS[step.op]
        description, fitted, scope = handler(self, step)
        after_cols = list(self.frame.columns)
        self.logs.append(StepLog(
            op=step.op, description=description, rows_before=before_rows, rows_after=len(self.frame),
            columns_added=[c for c in after_cols if c not in before_cols],
            columns_removed=[c for c in before_cols if c not in after_cols],
            fitted=fitted, fit_scope=scope,
        ))
        if scope == "all_rows":
            self.warnings.append(f"'{step.op}' learned its parameters from all rows. Use a split "
                                 "before evaluating a model on this data, or let Model Lab fit "
                                 "preprocessing inside its training split.")


StepResult = tuple[str, dict[str, Any], str]


def _cols(recipe: Recipe, step: TransformStep, *, required: bool = True) -> list[str]:
    if required and not step.columns:
        raise ValidationFailed(f"'{step.op}' needs at least one column.", code="invalid_step")
    require_columns(recipe.frame, step.columns)
    if recipe.split_column and recipe.split_column in step.columns:
        raise ValidationFailed("The split column cannot be transformed.", code="invalid_step")
    return step.columns


def _drop_columns(r: Recipe, s: TransformStep) -> StepResult:
    columns = _cols(r, s)
    r.frame = r.frame.drop(columns=columns)
    return f"Dropped {len(columns)} column(s): {', '.join(columns)}.", {}, "none"


def _select_columns(r: Recipe, s: TransformStep) -> StepResult:
    columns = _cols(r, s)
    keep = columns + ([r.split_column] if r.split_column else [])
    dropped = [c for c in r.frame.columns if c not in keep]
    r.frame = r.frame[keep]
    return f"Kept {len(columns)} column(s); removed {len(dropped)}.", {}, "none"


def _rename(r: Recipe, s: TransformStep) -> StepResult:
    if not s.mapping:
        raise ValidationFailed("'rename' needs a mapping of old → new names.", code="invalid_step")
    require_columns(r.frame, list(s.mapping))
    targets = [t.strip() for t in s.mapping.values()]
    if any(not t for t in targets) or len(set(targets)) != len(targets):
        raise ValidationFailed("New names must be non-empty and unique.", code="invalid_step")
    clashes = [t for t in targets if t in r.frame.columns and t not in s.mapping]
    if clashes:
        raise ValidationFailed(f"Column(s) already exist: {', '.join(clashes)}.", code="invalid_step")
    r.frame = r.frame.rename(columns={k: v.strip() for k, v in s.mapping.items()})
    return "Renamed " + ", ".join(f"{k} → {v}" for k, v in s.mapping.items()) + ".", {}, "none"


def _drop_duplicates(r: Recipe, s: TransformStep) -> StepResult:
    subset = _cols(r, s, required=False) or [c for c in r.frame.columns if c != r.split_column]
    before = len(r.frame)
    r.frame = r.frame.drop_duplicates(subset=subset, keep="first")
    scope = "all columns" if not s.columns else ", ".join(subset)
    return f"Removed {before - len(r.frame):,} duplicate row(s) (compared on {scope}; kept first).", {}, "none"


def _fill_missing(r: Recipe, s: TransformStep) -> StepResult:
    columns = _cols(r, s)
    strategy = s.strategy or "median"
    fit, scope = r.fit_rows()
    fitted: dict[str, Any] = {}
    filled_total = 0
    for column in columns:
        series = r.frame[column]
        if strategy == "constant":
            value = s.value
        elif strategy in {"mean", "median"}:
            if not is_numeric(series):
                raise ValidationFailed(f"'{strategy}' fill needs a numeric column; '{column}' is not.",
                                       code="invalid_step")
            value = clean_float(getattr(fit[column], strategy)())
        else:
            modes = fit[column].mode(dropna=True)
            value = modes.iloc[0] if not modes.empty else None
        if value is None:
            raise ValidationFailed(f"Cannot compute a {strategy} for '{column}' (no values).",
                                   code="invalid_step")
        if is_numeric(series) and strategy == "constant":
            try:
                value = float(value)
            except (TypeError, ValueError) as exc:
                raise ValidationFailed(f"'{value}' is not a number for '{column}'.",
                                       code="invalid_step") from exc
        filled_total += int(series.isna().sum())
        r.frame[column] = series.fillna(value)
        fitted[column] = display_value(value)
    scope_final = "none" if strategy == "constant" else scope
    return (f"Filled {filled_total:,} missing value(s) in {len(columns)} column(s) using {strategy}.",
            fitted, scope_final)


def _drop_missing(r: Recipe, s: TransformStep) -> StepResult:
    subset = _cols(r, s, required=False) or None
    before = len(r.frame)
    r.frame = r.frame.dropna(subset=subset)
    where = ", ".join(subset) if subset else "any column"
    return f"Removed {before - len(r.frame):,} row(s) with missing values in {where}.", {}, "none"


def _parse_dates(r: Recipe, s: TransformStep) -> StepResult:
    columns = _cols(r, s)
    failures: dict[str, int] = {}
    for column in columns:
        series = r.frame[column]
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            if s.format:
                parsed = pd.to_datetime(series, errors="coerce", format=s.format)
            else:
                parsed = pd.to_datetime(series, errors="coerce", format="mixed", dayfirst=True)
        failures[column] = int(parsed.isna().sum() - series.isna().sum())
        r.frame[column] = parsed
    lost = {c: n for c, n in failures.items() if n}
    if lost:
        r.warnings.append("Unparseable dates became missing: " +
                          ", ".join(f"{c} ({n:,})" for c, n in lost.items()))
    fmt = f"format '{s.format}'" if s.format else "inferred format (day-first when ambiguous)"
    return f"Parsed {len(columns)} column(s) as dates using {fmt}.", {"failed": failures}, "none"


_NUMBER_JUNK = re.compile(r"[\s %]")


def _to_number(series: pd.Series) -> pd.Series:
    if is_numeric(series):
        return series
    text = series.astype("str").str.replace(_NUMBER_JUNK, "", regex=True)
    both = text.str.contains(",", regex=False) & text.str.contains(".", regex=False)
    text = text.where(~both, text.str.replace(",", "", regex=False))
    text = text.str.replace(",", ".", regex=False)
    return pd.to_numeric(text, errors="coerce")


def _cast(r: Recipe, s: TransformStep) -> StepResult:
    columns = _cols(r, s)
    if not s.to:
        raise ValidationFailed("'cast' needs a target type.", code="invalid_step")
    failures: dict[str, int] = {}
    for column in columns:
        series = r.frame[column]
        if s.to == "numeric":
            out = _to_number(series)
        elif s.to == "string":
            out = series.astype("str")
        elif s.to == "category":
            out = series.astype("category")
        elif s.to == "boolean":
            mapping = {"true": True, "1": True, "yes": True, "y": True,
                       "false": False, "0": False, "no": False, "n": False}
            out = series.astype("str").str.strip().str.lower().map(mapping).astype("boolean")
        else:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                out = pd.to_datetime(series, errors="coerce", format="mixed", dayfirst=True)
        failures[column] = int(out.isna().sum() - series.isna().sum())
        r.frame[column] = out
    lost = {c: n for c, n in failures.items() if n > 0}
    if lost:
        r.warnings.append(f"Values that could not be cast to {s.to} became missing: " +
                          ", ".join(f"{c} ({n:,})" for c, n in lost.items()))
    return f"Cast {len(columns)} column(s) to {s.to}.", {"failed": failures}, "none"


def _filter_rows(r: Recipe, s: TransformStep) -> StepResult:
    if not s.filters:
        raise ValidationFailed("'filter_rows' needs at least one filter.", code="invalid_step")
    before = len(r.frame)
    r.frame = apply_filters(r.frame, s.filters)
    return (f"Kept {len(r.frame):,} of {before:,} rows matching: {describe_filters(s.filters)}.",
            {}, "none")


def _derive_date_parts(r: Recipe, s: TransformStep) -> StepResult:
    columns = _cols(r, s)
    added = []
    for column in columns:
        series = r.frame[column]
        if not pd.api.types.is_datetime64_any_dtype(series):
            raise ValidationFailed(f"'{column}' is not a datetime. Parse it as a date first.",
                                   code="invalid_step")
        parts = {"year": series.dt.year, "month": series.dt.month, "day": series.dt.day,
                 "dayofweek": series.dt.day_of_week, "quarter": series.dt.quarter}
        if (series.dt.hour.fillna(0) != 0).any():
            parts["hour"] = series.dt.hour
        for part, values in parts.items():
            name = f"{column}_{part}"
            r.frame[name] = values.astype("Int64")
            added.append(name)
    return f"Derived {len(added)} date-part column(s).", {}, "none"


def _derive_ratio(r: Recipe, s: TransformStep) -> StepResult:
    if not (s.numerator and s.denominator):
        raise ValidationFailed("'derive_ratio' needs a numerator and a denominator.", code="invalid_step")
    require_columns(r.frame, [s.numerator, s.denominator])
    num, den = _to_number(r.frame[s.numerator]), _to_number(r.frame[s.denominator])
    name = (s.new_column or f"{s.numerator}_per_{s.denominator}").strip()
    zero = int((den == 0).sum())
    r.frame[name] = (num / den.replace(0, np.nan)).astype(float)
    if zero:
        r.warnings.append(f"'{name}': {zero:,} zero denominator(s) produced missing values.")
    return f"Derived '{name}' = {s.numerator} / {s.denominator}.", {}, "none"


def _derive_log(r: Recipe, s: TransformStep) -> StepResult:
    columns = _cols(r, s)
    for column in columns:
        values = _to_number(r.frame[column])
        negative = int((values < 0).sum())
        r.frame[f"{column}_log1p"] = np.log1p(values.where(values >= 0))
        if negative:
            r.warnings.append(f"'{column}_log1p': {negative:,} negative value(s) became missing.")
    return f"Derived log1p of {len(columns)} column(s).", {}, "none"


def _bin_numeric(r: Recipe, s: TransformStep) -> StepResult:
    columns = _cols(r, s)
    bins = s.bins or 5
    fit, scope = r.fit_rows()
    fitted = {}
    for column in columns:
        if not is_numeric(r.frame[column]):
            raise ValidationFailed(f"'{column}' is not numeric.", code="invalid_step")
        edges = np.unique(fit[column].quantile(np.linspace(0, 1, bins + 1)).to_numpy())
        if len(edges) < 2:
            raise ValidationFailed(f"'{column}' has too few distinct values to bin.", code="invalid_step")
        edges[0], edges[-1] = -np.inf, np.inf
        r.frame[f"{column}_bin"] = pd.cut(r.frame[column], bins=edges).astype("str")
        fitted[column] = [clean_float(e, 6) for e in edges[1:-1]]
    return f"Binned {len(columns)} column(s) into up to {bins} quantile bins.", fitted, scope


def _one_hot(r: Recipe, s: TransformStep) -> StepResult:
    columns = _cols(r, s)
    fit, scope = r.fit_rows()
    fitted = {}
    for column in columns:
        categories = fit[column].dropna().astype("str").value_counts().index[:MAX_ONE_HOT_CATEGORIES]
        values = r.frame[column].astype("str")
        for category in categories:
            r.frame[f"{column}={category}"] = (values == category).astype("int8")
        fitted[column] = list(categories)
        r.frame = r.frame.drop(columns=[column])
    return f"One-hot encoded {len(columns)} column(s) (top {MAX_ONE_HOT_CATEGORIES} categories each).", \
        fitted, scope


def _scale(r: Recipe, s: TransformStep) -> StepResult:
    columns = _cols(r, s)
    method = s.method or "standard"
    fit, scope = r.fit_rows()
    fitted = {}
    for column in columns:
        if not is_numeric(r.frame[column]):
            raise ValidationFailed(f"'{column}' is not numeric.", code="invalid_step")
        values = r.frame[column].astype(float)
        if method == "standard":
            center, spread = float(fit[column].mean()), float(fit[column].std())
        else:
            center, spread = float(fit[column].min()), float(fit[column].max() - fit[column].min())
        spread = spread if spread and np.isfinite(spread) else 1.0
        r.frame[column] = (values - center) / spread
        fitted[column] = {"center": clean_float(center, 6), "scale": clean_float(spread, 6)}
    return f"Scaled {len(columns)} column(s) ({method}).", fitted, scope


STEPS: dict[str, Callable[[Recipe, TransformStep], StepResult]] = {
    "drop_columns": _drop_columns, "select_columns": _select_columns, "rename": _rename,
    "drop_duplicates": _drop_duplicates, "fill_missing": _fill_missing, "drop_missing": _drop_missing,
    "parse_dates": _parse_dates, "cast": _cast, "filter_rows": _filter_rows,
    "derive_date_parts": _derive_date_parts, "derive_ratio": _derive_ratio, "derive_log": _derive_log,
    "bin_numeric": _bin_numeric, "one_hot": _one_hot, "scale": _scale,
}


def run_recipe(frame: pd.DataFrame, steps: list[TransformStep],
               split: SplitConfig | None) -> Recipe:
    recipe = Recipe(frame, split)
    for index, step in enumerate(steps, start=1):
        try:
            recipe.apply(step)
        except ValidationFailed as exc:
            exc.message = f"Step {index} ({step.op}): {exc.message}"
            raise
    return recipe
