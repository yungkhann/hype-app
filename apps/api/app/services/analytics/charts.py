"""Server-side chart construction.

Every chart is aggregated, binned, or sampled here so the browser receives at most a few thousand
points. Invalid column combinations raise ``ValidationFailed`` with a message the UI shows as-is.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from app.core.config import Settings
from app.core.errors import ValidationFailed
from app.schemas.analysis import BoxStats, ChartData, ChartSpec, HeatmapData
from app.schemas.common import ColumnKind
from app.services.analytics.query import NUMERIC_AGGS, source_meta
from app.services.filters import apply_filters, describe_filters
from app.utils.frames import clean_float, display_value, infer_kind, require_columns, to_records

OTHER = "Other"
VALUE = "value"
SCATTER_MAX_GROUPS = 3
FREQ = {"day": "D", "week": "W", "month": "M", "quarter": "Q", "year": "Y"}


class ChartContext:
    def __init__(self, frame: pd.DataFrame, spec: ChartSpec, dataset_id: str, dataset_name: str,
                 settings: Settings) -> None:
        require_columns(frame, [spec.x, spec.y, spec.group, *(spec.columns or [])])
        self.full = frame
        self.spec = spec
        self.frame = apply_filters(frame, spec.filters)
        self.dataset_id = dataset_id
        self.dataset_name = dataset_name
        self.settings = settings
        self.warnings: list[str] = []
        self.notes: list[str] = []
        self.sampled = False
        self.sample_size: int | None = None
        if spec.filters:
            self.notes.append(f"Filters: {describe_filters(spec.filters)}")

    def kind(self, column: str | None) -> ColumnKind | None:
        return infer_kind(self.frame[column]) if column else None

    def finish(self, aggregation: str, **fields) -> ChartData:
        meta = source_meta(self.dataset_id, self.dataset_name, len(self.full), len(self.frame),
                           self.spec.filters, sampled=self.sampled, sample_size=self.sample_size,
                           aggregation=aggregation, notes=self.notes)
        if len(self.frame) == 0:
            self.warnings.append("No rows match the current filters.")
        return ChartData(spec=self.spec, meta=meta, warnings=self.warnings, **fields)


# ---- helpers ---------------------------------------------------------------------

def epoch_ms(values: pd.Series) -> pd.Series:
    """Datetimes as epoch milliseconds, independent of the stored unit (us/ns) and timezone."""
    if getattr(values.dt, "tz", None) is not None:
        values = values.dt.tz_convert("UTC").dt.tz_localize(None)
    return (values - pd.Timestamp("1970-01-01")) // pd.Timedelta(milliseconds=1)


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationFailed(message, code="invalid_chart")


def _value_label(spec: ChartSpec) -> str:
    return "count of rows" if spec.agg == "count" or not spec.y else f"{spec.agg} of {spec.y}"


def _check_measure(ctx: ChartContext) -> None:
    spec = ctx.spec
    if spec.agg == "count":
        return
    _require(spec.y is not None, f"Aggregation '{spec.agg}' needs a Y column.")
    if spec.agg in NUMERIC_AGGS or spec.agg in {"min", "max"}:
        _require(ctx.kind(spec.y) in {"numeric", "boolean"},
                 f"'{spec.agg}' needs a numeric Y; '{spec.y}' is {ctx.kind(spec.y)}.")


def _aggregate(frame: pd.DataFrame, keys: list[str], spec: ChartSpec) -> pd.Series:
    grouped = frame.groupby(keys, dropna=False, observed=True, sort=False)
    if spec.agg == "count" or not spec.y:
        return grouped.size()
    column = grouped[spec.y]
    if pd.api.types.is_bool_dtype(frame[spec.y]) and spec.agg in NUMERIC_AGGS:
        column = frame.assign(**{spec.y: frame[spec.y].astype(float)}).groupby(
            keys, dropna=False, observed=True, sort=False)[spec.y]
    return getattr(column, spec.agg)()


def _labels(series: pd.Series) -> pd.Series:
    return series.map(display_value).astype("str")


def _collapse_groups(ctx: ChartContext, column: str, limit: int | None = None) -> pd.Series:
    """Keep the most frequent groups (``max_series`` by default); fold the rest into 'Other' (disclosed)."""
    labels = _labels(ctx.frame[column])
    counts = labels.value_counts()
    keep = counts.index[: limit or ctx.settings.max_series]
    if len(counts) > len(keep):
        ctx.notes.append(f"'{column}': top {len(keep)} of {len(counts)} groups shown; "
                         f"the remaining {len(counts) - len(keep)} are combined as '{OTHER}'.")
        labels = labels.where(labels.isin(keep), OTHER)
    return labels


def _time_bucket(ctx: ChartContext, column: str) -> pd.Series:
    values = ctx.frame[column]
    bucket = ctx.spec.time_bucket
    if bucket == "auto":
        valid = values.dropna()
        span = (valid.max() - valid.min()).days if len(valid) else 0
        bucket = "day" if span <= 120 else "week" if span <= 730 else "month" if span <= 3650 else "year"
    tz = getattr(values.dt, "tz", None)
    naive = values.dt.tz_localize(None) if tz is not None else values
    ctx.notes.append(f"'{column}' grouped by {bucket}.")
    return naive.dt.to_period(FREQ[bucket]).dt.start_time


def _wide(series: pd.Series, x_name: str, group_name: str | None) -> tuple[list[dict], list[str]]:
    frame = series.rename(VALUE).reset_index()
    if group_name:
        pivot = frame.pivot_table(index=x_name, columns=group_name, values=VALUE, aggfunc="first",
                                  observed=True, sort=False)
        names = [str(c) for c in pivot.columns]
        pivot.columns = names
        pivot = pivot.reset_index().rename(columns={x_name: "x"})
        return to_records(pivot), names
    frame = frame.rename(columns={x_name: "x"})
    return to_records(frame[["x", VALUE]]), [VALUE]


# ---- chart builders ----------------------------------------------------------------

def _bar(ctx: ChartContext) -> ChartData:
    spec = ctx.spec
    _require(spec.x is not None, "Bar charts need an X column.")
    _check_measure(ctx)
    x_kind = ctx.kind(spec.x)
    frame = ctx.frame.copy()
    if x_kind == "datetime":
        frame["__x"] = _time_bucket(ctx, spec.x)
    else:
        if x_kind == "numeric" and frame[spec.x].nunique() > spec.limit:
            ctx.warnings.append(f"'{spec.x}' is numeric with many values; a histogram may suit it better.")
        frame["__x"] = _labels(frame[spec.x])
    keys = ["__x"]
    if spec.group:
        _require(spec.group != spec.x, "Group by must differ from X.")
        frame["__g"] = _collapse_groups(ctx, spec.group).loc[frame.index]
        keys.append("__g")
    values = _aggregate(frame, keys, spec)

    totals = values.groupby(level=0).sum() if spec.group else values
    if x_kind == "datetime" or spec.sort == "label":
        order = totals.sort_index()
    else:
        order = totals.sort_values(ascending=spec.sort == "value_asc")
    kept = order.index[: spec.limit]
    if len(order) > len(kept):
        ctx.warnings.append(f"Showing {len(kept)} of {len(order)} '{spec.x}' values "
                            f"(by {'label' if spec.sort == 'label' else 'value'}); the rest are omitted.")
    values = values[values.index.get_level_values(0).isin(kept)]
    rows, series = _wide(values, "__x", "__g" if spec.group else None)
    position = {k: i for i, k in enumerate(kept)}
    rows.sort(key=lambda r: position.get(pd.Timestamp(r["x"]) if x_kind == "datetime" else r["x"], 0))
    return ctx.finish(f"{_value_label(spec)} by {spec.x}" + (f" and {spec.group}" if spec.group else ""),
                      x_label=spec.x, y_label=_value_label(spec), x_kind=x_kind, series=series, rows=rows)


def _line(ctx: ChartContext) -> ChartData:
    spec = ctx.spec
    _require(spec.x is not None, "Line charts need an X column (usually a date).")
    _check_measure(ctx)
    x_kind = ctx.kind(spec.x)
    frame = ctx.frame.copy()
    if x_kind == "datetime":
        frame["__x"] = _time_bucket(ctx, spec.x)
    elif x_kind == "numeric":
        unique = frame[spec.x].nunique()
        if unique > 200:
            bins = pd.cut(frame[spec.x], bins=100)
            frame["__x"] = bins.map(lambda iv: float(iv.mid) if pd.notna(iv) else np.nan).astype(float)
            ctx.notes.append(f"'{spec.x}' binned into 100 equal-width intervals (midpoints shown).")
        else:
            frame["__x"] = frame[spec.x]
    else:
        frame["__x"] = _labels(frame[spec.x])
        ctx.warnings.append(f"'{spec.x}' is {x_kind}; points are ordered by label.")
    frame = frame[frame["__x"].notna()]
    keys = ["__x"]
    if spec.group:
        frame["__g"] = _collapse_groups(ctx, spec.group).loc[frame.index]
        keys.append("__g")
    values = _aggregate(frame, keys, spec).sort_index()
    rows, series = _wide(values, "__x", "__g" if spec.group else None)
    if len(rows) > ctx.settings.max_chart_points:
        step = int(np.ceil(len(rows) / ctx.settings.max_chart_points))
        rows = rows[::step]
        ctx.sampled, ctx.sample_size = True, len(rows)
        ctx.notes.append(f"Every {step}th point shown to stay under {ctx.settings.max_chart_points:,} points.")
    return ctx.finish(f"{_value_label(spec)} over {spec.x}" + (f" by {spec.group}" if spec.group else ""),
                      x_label=spec.x, y_label=_value_label(spec), x_kind=x_kind, series=series, rows=rows)


def _scatter(ctx: ChartContext) -> ChartData:
    spec = ctx.spec
    _require(spec.x is not None and spec.y is not None, "Scatter plots need both X and Y columns.")
    x_kind, y_kind = ctx.kind(spec.x), ctx.kind(spec.y)
    _require(x_kind in {"numeric", "datetime"},
             f"Scatter needs a numeric or date X; '{spec.x}' is {x_kind}. Try a box plot instead.")
    _require(y_kind == "numeric", f"Scatter needs a numeric Y; '{spec.y}' is {y_kind}.")
    frame = ctx.frame[[spec.x, spec.y] + ([spec.group] if spec.group else [])].dropna(subset=[spec.x, spec.y])
    dropped = len(ctx.frame) - len(frame)
    if dropped:
        ctx.notes.append(f"{dropped:,} rows with a missing X or Y are not plotted.")
    if len(frame) > ctx.settings.max_chart_points:
        frame = frame.sample(ctx.settings.max_chart_points, random_state=0)
        ctx.sampled, ctx.sample_size = True, len(frame)
        ctx.notes.append(f"Random sample of {len(frame):,} points plotted.")
    out = pd.DataFrame({"x": frame[spec.x], "y": frame[spec.y]})
    if x_kind == "datetime":
        out["x"] = epoch_ms(frame[spec.x])
    series = ["points"]
    if spec.group:
        # Overlapping point clouds are compared all-pairs: only three hues stay CVD-distinct.
        group_labels = _collapse_groups(ctx, spec.group, limit=SCATTER_MAX_GROUPS)
        out["series"] = group_labels.loc[frame.index].to_numpy()
        series = sorted(out["series"].unique().tolist(), key=lambda s: (s == OTHER, s))
    else:
        out["series"] = "points"
    corr = clean_float(frame[spec.x].corr(frame[spec.y]), 4) if x_kind == "numeric" and len(frame) > 2 else None
    if corr is not None:
        ctx.notes.append(f"Pearson r = {corr:.3f} on plotted points (association, not causation).")
    return ctx.finish(f"{spec.y} vs {spec.x}", x_label=spec.x, y_label=spec.y, x_kind=x_kind,
                      series=series, rows=to_records(out))


def _histogram(ctx: ChartContext) -> ChartData:
    spec = ctx.spec
    _require(spec.x is not None, "Histograms need a numeric X column.")
    x_kind = ctx.kind(spec.x)
    _require(x_kind == "numeric", f"Histograms need a numeric X; '{spec.x}' is {x_kind}. "
             "Use a bar chart for category counts.")
    values = pd.to_numeric(ctx.frame[spec.x], errors="coerce")
    finite = values[np.isfinite(values)]
    if finite.empty:
        return ctx.finish(f"distribution of {spec.x}", x_label=spec.x, y_label="rows", x_kind=x_kind)
    edges = np.histogram_bin_edges(finite, bins=spec.bins)
    series_names = ["count"]
    rows = [{"x": clean_float((lo + hi) / 2, 6), "x0": clean_float(lo, 6), "x1": clean_float(hi, 6)}
            for lo, hi in zip(edges[:-1], edges[1:], strict=True)]
    if spec.group:
        labels = _collapse_groups(ctx, spec.group).loc[finite.index]
        series_names = sorted(labels.unique().tolist(), key=lambda s: (s == OTHER, s))
        for name in series_names:
            counts, _ = np.histogram(finite[labels == name], bins=edges)
            for row, count in zip(rows, counts, strict=True):
                row[name] = int(count)
    else:
        counts, _ = np.histogram(finite, bins=edges)
        for row, count in zip(rows, counts, strict=True):
            row["count"] = int(count)
    missing = len(values) - len(finite)
    if missing:
        ctx.notes.append(f"{missing:,} missing or non-finite values excluded.")
    return ctx.finish(f"distribution of {spec.x} ({spec.bins} bins)", x_label=spec.x, y_label="rows",
                      x_kind=x_kind, series=series_names, rows=rows)


def _box_stats(name: str, values: pd.Series) -> BoxStats | None:
    finite = values[np.isfinite(values)]
    if finite.empty:
        return None
    q1, median, q3 = finite.quantile([0.25, 0.5, 0.75]).tolist()
    iqr = q3 - q1
    inside = finite[(finite >= q1 - 1.5 * iqr) & (finite <= q3 + 1.5 * iqr)]
    return BoxStats(group=name, n=int(len(finite)), min=float(finite.min()), q1=float(q1),
                    median=float(median), q3=float(q3), max=float(finite.max()),
                    whisker_low=float(inside.min()), whisker_high=float(inside.max()),
                    outliers=int(len(finite) - len(inside)), mean=float(finite.mean()))


def _box(ctx: ChartContext) -> ChartData:
    spec = ctx.spec
    _require(spec.y is not None, "Box plots need a numeric Y column (and optionally an X to group by).")
    y_kind = ctx.kind(spec.y)
    _require(y_kind == "numeric", f"Box plots need a numeric Y; '{spec.y}' is {y_kind}.")
    values = pd.to_numeric(ctx.frame[spec.y], errors="coerce").astype(float)
    boxes: list[BoxStats] = []
    if spec.x:
        _require(ctx.kind(spec.x) != "numeric" or ctx.frame[spec.x].nunique() <= spec.limit,
                 f"Grouping by numeric '{spec.x}' creates too many boxes; choose a categorical X.")
        labels = _labels(ctx.frame[spec.x])
        counts = labels.value_counts()
        keep = counts.index[: spec.limit]
        if len(counts) > len(keep):
            ctx.warnings.append(f"Showing the {len(keep)} largest of {len(counts)} '{spec.x}' groups.")
        for name in keep:
            stats = _box_stats(str(name), values[labels == name])
            if stats:
                boxes.append(stats)
        if spec.sort == "label":
            boxes.sort(key=lambda b: b.group)
        else:
            boxes.sort(key=lambda b: b.median, reverse=spec.sort == "value_desc")
    else:
        stats = _box_stats(spec.y, values)
        boxes = [stats] if stats else []
    ctx.notes.append("Whiskers extend to the furthest values within 1.5×IQR.")
    return ctx.finish(f"distribution of {spec.y}" + (f" by {spec.x}" if spec.x else ""),
                      x_label=spec.x, y_label=spec.y, x_kind=ctx.kind(spec.x), box=boxes)


def _heatmap(ctx: ChartContext) -> ChartData:
    spec = ctx.spec
    if spec.x and spec.y:
        for column in (spec.x, spec.y):
            _require(ctx.kind(column) != "numeric" or ctx.frame[column].nunique() <= spec.limit,
                     f"'{column}' is numeric with many values; heatmaps need categories on both axes.")
        _check_measure(ctx)
        frame = ctx.frame.copy()
        frame["__x"] = _labels(frame[spec.x])
        frame["__y"] = _labels(frame[spec.y])
        top_x = frame["__x"].value_counts().index[: spec.limit]
        top_y = frame["__y"].value_counts().index[: spec.limit]
        if frame["__x"].nunique() > len(top_x) or frame["__y"].nunique() > len(top_y):
            ctx.warnings.append(f"Only the {spec.limit} most frequent values per axis are shown.")
        frame = frame[frame["__x"].isin(top_x) & frame["__y"].isin(top_y)]
        values = _aggregate(frame, ["__y", "__x"], spec).unstack("__x")
        x_labels = sorted(values.columns.astype(str).tolist())
        y_labels = sorted(values.index.astype(str).tolist())
        values = values.reindex(index=y_labels, columns=x_labels)
        matrix = [[clean_float(v, 6) for v in row] for row in values.to_numpy()]
        return ctx.finish(f"{_value_label(spec)} by {spec.y} × {spec.x}", x_label=spec.x, y_label=spec.y,
                          heatmap=HeatmapData(x_labels=x_labels, y_labels=y_labels, values=matrix,
                                              value_label=_value_label(spec)))
    columns = spec.columns or [c for c in ctx.frame.columns if ctx.kind(c) == "numeric"]
    columns = [c for c in columns if ctx.kind(c) == "numeric"][: ctx.settings.max_correlation_columns]
    _require(len(columns) >= 2, "A correlation heatmap needs at least two numeric columns.")
    frame = ctx.frame[columns]
    if len(frame) > ctx.settings.profile_sample_rows:
        frame = frame.sample(ctx.settings.profile_sample_rows, random_state=0)
        ctx.sampled, ctx.sample_size = True, len(frame)
    matrix = frame.astype(float).corr(min_periods=10)
    ctx.notes.append("Pearson correlation; it measures linear association, not causation.")
    return ctx.finish("Pearson correlation", heatmap=HeatmapData(
        x_labels=columns, y_labels=columns,
        values=[[clean_float(v, 4) for v in row] for row in matrix.to_numpy()],
        value_label="Pearson r"))


BUILDERS = {"bar": _bar, "line": _line, "scatter": _scatter, "histogram": _histogram, "box": _box,
            "heatmap": _heatmap}


def build_chart(frame: pd.DataFrame, spec: ChartSpec, *, dataset_id: str, dataset_name: str,
                settings: Settings) -> ChartData:
    ctx = ChartContext(frame, spec, dataset_id, dataset_name, settings)
    return BUILDERS[spec.type](ctx)
