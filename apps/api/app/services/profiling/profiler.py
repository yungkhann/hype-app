"""Automated dataset profiling.

Quality flags carry a ``basis``: ``detected`` for measured facts (missing values, duplicates, constant
columns) and ``heuristic`` for assumptions the team must verify (identifiers, outliers, date-like
text, inconsistent spellings). Unusual values are never declared errors.
"""

from __future__ import annotations

import re
import warnings

import numpy as np
import pandas as pd

from app.core.config import Settings
from app.schemas.profile import (
    CategoryCount,
    ColumnProfile,
    Correlation,
    DatasetProfile,
    DatetimeStats,
    Histogram,
    NumericStats,
    ProfileOverview,
    QualityFlag,
    Sampling,
)
from app.utils.frames import clean_float, display_value, infer_kind, now_iso, sample_frame

HIGH_CARDINALITY_RATIO = 0.9
HIGH_MISSING_PCT = 50.0
ID_NAME_HINTS = ("id", "uuid", "guid", "key", "code", "number", "num", "no")
TOP_N = 10


def _pct(part: int | float, whole: int | float) -> float:
    return round(100.0 * part / whole, 2) if whole else 0.0


def _histogram(values: np.ndarray, bins: int = 30) -> Histogram | None:
    values = values[np.isfinite(values)]
    if values.size == 0:
        return None
    unique = np.unique(values)
    if unique.size <= bins and unique.size <= 25 and np.all(np.mod(unique, 1) == 0):
        # Few integer values: one bar per value reads better than arbitrary bins.
        edges = np.append(unique - 0.5, unique[-1] + 0.5)
        counts = np.array([(values == v).sum() for v in unique])
        return Histogram(edges=[float(e) for e in edges], counts=[int(c) for c in counts])
    counts, edges = np.histogram(values, bins=bins)
    return Histogram(edges=[float(e) for e in edges], counts=[int(c) for c in counts])


def _numeric_stats(series: pd.Series) -> NumericStats:
    values = pd.to_numeric(series, errors="coerce").astype("float64")
    finite = values[np.isfinite(values)]
    if finite.empty:
        return NumericStats(min=None, max=None, mean=None, median=None, std=None, q1=None, q3=None,
                            skew=None, zeros=0, negatives=0, outliers_iqr=0, lower_fence=None,
                            upper_fence=None)
    q1, median, q3 = finite.quantile([0.25, 0.5, 0.75]).tolist()
    iqr = q3 - q1
    lower, upper = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    outliers = int(((finite < lower) | (finite > upper)).sum()) if iqr > 0 else 0
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        skew = finite.skew() if len(finite) > 2 else None
    return NumericStats(
        min=clean_float(finite.min()), max=clean_float(finite.max()),
        mean=clean_float(finite.mean()), median=clean_float(median),
        std=clean_float(finite.std()), q1=clean_float(q1), q3=clean_float(q3),
        skew=clean_float(skew), zeros=int((finite == 0).sum()), negatives=int((finite < 0).sum()),
        outliers_iqr=outliers, lower_fence=clean_float(lower), upper_fence=clean_float(upper),
    )


def _top_categories(series: pd.Series) -> tuple[list[CategoryCount], int]:
    counts = series.dropna().astype("str").value_counts()
    top = [CategoryCount(value=display_value(v), count=int(c)) for v, c in counts.head(TOP_N).items()]
    return top, int(counts.iloc[TOP_N:].sum()) if len(counts) > TOP_N else 0


def _looks_like_identifier(name: str, series: pd.Series, unique: int, non_null: int) -> bool:
    """Near-unique per row. A name hint (``*_id``, ``*_no``, ``key``…) tolerates duplicated rows."""
    if non_null < 20:
        return False
    lowered = name.lower().replace("-", "_")
    tokens = set(lowered.split("_")) | {lowered}
    named_like_id = any(h in tokens or lowered.endswith(h) for h in ID_NAME_HINTS)
    ratio = unique / non_null
    if named_like_id:
        return ratio >= 0.9
    if ratio < 0.99 or pd.api.types.is_float_dtype(series):
        return False
    return pd.api.types.is_integer_dtype(series) or pd.api.types.is_string_dtype(series)


# A value must LOOK like a date before parsing counts: pandas' mixed-format parser accepts codes such as
# "T0000045" (→ 2045-01-01) and digit runs, which would turn identifiers into false "date" hints.
_DATE_SHAPE = re.compile(
    r"^\s*(?:"
    r"\d{1,4}[-./]\d{1,2}[-./]\d{1,4}"  # 2026-03-01, 01.03.2026, 1/3/26
    r"|\d{1,2}\s+[A-Za-zА-Яа-яЁё]{3,}\.?\s+\d{2,4}"  # 1 March 2026
    r"|[A-Za-zА-Яа-яЁё]{3,}\.?\s+\d{1,2},?\s+\d{4}"  # March 1, 2026
    r")(?:[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?)?\s*$"
)


def _date_like_share(series: pd.Series) -> float:
    probe = series.dropna().astype("str").head(500)
    if probe.empty or probe.str.len().mean() > 40:
        return 0.0
    shaped = probe[probe.str.match(_DATE_SHAPE)]
    if len(shaped) < 0.9 * len(probe):
        return 0.0
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        parsed = pd.to_datetime(shaped, errors="coerce", format="mixed", dayfirst=True)
    plausible = parsed.notna() & parsed.dt.year.between(1900, 2100)
    return float(plausible.sum() / len(probe))


def _numeric_like_share(series: pd.Series) -> float:
    probe = series.dropna().astype("str").head(1_000).str.strip()
    if probe.empty:
        return 0.0
    cleaned = probe.str.replace(r"[\s ,]", "", regex=True).str.replace("%", "", regex=False)
    return float(pd.to_numeric(cleaned, errors="coerce").notna().mean())


def _spelling_variants(series: pd.Series) -> int:
    """Count category groups that differ only by case or surrounding whitespace."""
    values = series.dropna().astype("str")
    distinct = pd.Series(values.unique())
    if distinct.empty or len(distinct) > 5_000:
        return 0
    normalized = distinct.str.strip().str.casefold()
    group_sizes = normalized.value_counts()
    return int((group_sizes > 1).sum())


def profile_column(name: str, series: pd.Series, n_rows: int,
                   flags_out: list[QualityFlag]) -> ColumnProfile:
    kind = infer_kind(series)
    non_null = int(series.notna().sum())
    missing = n_rows - non_null
    try:
        unique = int(series.nunique(dropna=True))
    except TypeError:
        unique = int(series.astype("str").nunique(dropna=True))
    examples = [display_value(v) for v in series.dropna().drop_duplicates().head(5).tolist()]
    profile = ColumnProfile(name=name, dtype=str(series.dtype), kind=kind, non_null=non_null,
                            missing=missing, missing_pct=_pct(missing, n_rows), unique=unique,
                            unique_pct=_pct(unique, non_null), examples=examples)

    def flag(code: str, severity: str, basis: str, message: str) -> None:
        profile.flags.append(code)
        flags_out.append(QualityFlag(code=code, severity=severity, basis=basis, column=name,
                                     message=message))

    if non_null == 0:
        flag("all_missing", "critical", "detected", f"'{name}' has no values.")
        return profile
    if missing and profile.missing_pct >= HIGH_MISSING_PCT:
        flag("high_missing", "warning", "detected",
             f"'{name}' is {profile.missing_pct:.1f}% missing ({missing:,} rows).")
    elif missing:
        flag("missing", "info", "detected", f"'{name}' has {missing:,} missing values "
             f"({profile.missing_pct:.1f}%).")
    if unique == 1:
        flag("constant", "warning", "detected", f"'{name}' has a single value; it carries no signal.")

    if kind == "numeric":
        profile.numeric = _numeric_stats(series)
        profile.histogram = _histogram(pd.to_numeric(series, errors="coerce").to_numpy(dtype="float64"))
        if profile.numeric.outliers_iqr:
            share = _pct(profile.numeric.outliers_iqr, non_null)
            flag("potential_outliers", "info", "heuristic",
                 f"'{name}' has {profile.numeric.outliers_iqr:,} values ({share:.1f}%) outside the "
                 "1.5×IQR fences. They may be legitimate; verify before removing.")
        if 2 <= unique <= 10 and pd.api.types.is_integer_dtype(series):
            flag("low_cardinality_numeric", "info", "heuristic",
                 f"'{name}' has only {unique} distinct integers; it may be a category code.")
    elif kind == "datetime":
        values = series.dropna()
        span = (values.max() - values.min()).total_seconds() / 86_400 if len(values) else None
        profile.datetime = DatetimeStats(min=values.min().isoformat(), max=values.max().isoformat(),
                                         span_days=clean_float(span, 2))
    else:
        profile.top, profile.other_count = _top_categories(series)
        if kind in {"categorical", "text"}:
            if non_null >= 20 and _date_like_share(series) >= 0.9:
                flag("potential_date", "info", "heuristic",
                     f"'{name}' is stored as text but most values parse as dates. "
                     "Use Prepare → Parse dates to convert it.")
            elif non_null >= 20 and _numeric_like_share(series) >= 0.95:
                flag("numeric_as_text", "warning", "heuristic",
                     f"'{name}' is stored as text but ≥95% of values are numbers "
                     "(possibly with separators or %). Use Prepare → Cast to numeric.")
            variants = _spelling_variants(series)
            if variants:
                flag("inconsistent_spelling", "warning", "heuristic",
                     f"'{name}' has {variants} value group(s) differing only by case or spacing "
                     "(e.g. 'North' vs 'north ').")
        if unique / max(non_null, 1) >= HIGH_CARDINALITY_RATIO and unique > 50 and kind != "boolean":
            flag("high_cardinality", "info", "detected",
                 f"'{name}' has {unique:,} distinct values ({profile.unique_pct:.0f}% of rows).")

    if kind != "datetime" and _looks_like_identifier(name, series, unique, non_null):
        flag("suspected_identifier", "warning", "heuristic",
             f"'{name}' is unique per row and looks like an identifier. Exclude it from models.")
    return profile


def _correlation(frame: pd.DataFrame, columns: list[str], settings: Settings,
                 sampled: bool) -> Correlation | None:
    usable = [c for c in columns if frame[c].nunique(dropna=True) > 1][: settings.max_correlation_columns]
    if len(usable) < 2:
        return None
    numeric = frame[usable].apply(pd.to_numeric, errors="coerce").astype("float64")
    matrix = numeric.corr(method="pearson", min_periods=10)
    return Correlation(method="pearson", columns=usable,
                       matrix=[[clean_float(v, 4) for v in row] for row in matrix.to_numpy()],
                       n_rows_used=len(numeric), sampled=sampled)


def build_profile(frame: pd.DataFrame, *, dataset_id: str, dataset_name: str,
                  file_size_bytes: int | None, settings: Settings) -> DatasetProfile:
    n_rows, n_cols = frame.shape
    quality: list[QualityFlag] = []
    columns = [profile_column(str(c), frame[c], n_rows, quality) for c in frame.columns]

    duplicates = int(frame.duplicated().sum()) if n_rows else 0
    if duplicates:
        quality.insert(0, QualityFlag(code="duplicate_rows", severity="warning", basis="detected",
                                      message=f"{duplicates:,} rows ({_pct(duplicates, n_rows):.2f}%) "
                                              "are exact duplicates of an earlier row."))
    missing_cells = int(frame.isna().sum().sum())
    kinds: dict[str, int] = {}
    for column in columns:
        kinds[column.kind] = kinds.get(column.kind, 0) + 1

    sample, sampled = sample_frame(frame, settings.profile_sample_rows)
    numeric_columns = [c.name for c in columns if c.kind == "numeric"]
    correlation = _correlation(sample, numeric_columns, settings, sampled)

    severity_rank = {"critical": 0, "warning": 1, "info": 2}
    quality.sort(key=lambda q: (severity_rank[q.severity], q.basis != "detected"))

    return DatasetProfile(
        dataset_id=dataset_id, dataset_name=dataset_name, generated_at=now_iso(),
        overview=ProfileOverview(
            n_rows=n_rows, n_cols=n_cols, file_size_bytes=file_size_bytes,
            memory_bytes=int(frame.memory_usage(deep=True).sum()),
            duplicate_rows=duplicates, duplicate_pct=_pct(duplicates, n_rows),
            missing_cells=missing_cells, missing_pct=_pct(missing_cells, n_rows * n_cols),
            kinds=kinds,
        ),
        columns=columns,
        quality=quality,
        correlation=correlation,
        sampling=Sampling(
            sampled=sampled, sample_rows=len(sample), total_rows=n_rows,
            note=(f"Correlations computed on a random sample of {len(sample):,} of {n_rows:,} rows. "
                  "All counts and column statistics use every row.") if sampled else None,
        ),
    )
