"""Built-in, schema-agnostic analyses. Each one is also a template for case-specific modules."""

from __future__ import annotations

from typing import Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field
from scipy import stats

from app.core.errors import ValidationFailed
from app.extensions.registry import AnalysisContext, column_param, register_analysis
from app.schemas.analysis import ChartSpec
from app.schemas.common import LabelValue
from app.schemas.extensions import AnalysisResult
from app.utils.frames import clean_float, display_value, infer_kind, is_numeric, sample_frame, to_records


def _fmt(value: float | None, digits: int = 3) -> str:
    if value is None or not np.isfinite(value):
        return "—"
    return f"{value:,.{digits}f}"


# ---- 1. Value concentration (the worked example in docs/architecture.md) ----------------

class ConcentrationParams(BaseModel):
    group: str = column_param(kinds=["categorical", "boolean", "text"], title="Group by",
                              description="Entities to rank, e.g. customer, merchant, region.")
    value: str | None = column_param(kinds=["numeric"], default=None, title="Value",
                                     description="Quantity to sum. Leave empty to count rows.")
    threshold: float = Field(default=0.8, ge=0.1, le=0.99, title="Share threshold",
                             description="Report how many groups account for this share of the total.")


@register_analysis("value_concentration", title="Value concentration (Pareto)",
                   description="How concentrated a total is across groups: cumulative share, the number of "
                               "groups that make up a threshold, and the Gini coefficient.",
                   params=ConcentrationParams)
def value_concentration(ctx: AnalysisContext, p: ConcentrationParams) -> AnalysisResult:
    ctx.require(p.group)
    if p.value:
        ctx.require(p.value, kinds={"numeric"})
    frame = ctx.frame
    totals = (frame.groupby(frame[p.group].astype("str"), observed=True)[p.value].sum() if p.value
              else frame.groupby(frame[p.group].astype("str"), observed=True).size())
    totals = totals[totals > 0].sort_values(ascending=False)
    if totals.empty:
        raise ValidationFailed("No positive totals to analyze.", code="empty_selection")
    grand = float(totals.sum())
    share = totals / grand
    cumulative = share.cumsum()
    needed = int((cumulative < p.threshold).sum() + 1)
    sorted_values = np.sort(totals.to_numpy(dtype=float))
    n = len(sorted_values)
    gini = float((2 * np.arange(1, n + 1) - n - 1).dot(sorted_values) / (n * sorted_values.sum()))
    measure = f"sum of {p.value}" if p.value else "row count"

    table = pd.DataFrame({p.group: totals.index, measure: totals.to_numpy(),
                          "share": share.round(6).to_numpy(), "cumulative_share": cumulative.round(6).to_numpy()})
    top = table.head(25)
    chart = ctx.chart(ChartSpec(type="bar", x=p.group, y=p.value, agg="sum" if p.value else "count"),
                      to_records(top.rename(columns={p.group: "x", measure: "value"})[["x", "value"]]),
                      series=["value"], x_label=p.group, y_label=measure,
                      aggregation=f"{measure} by {p.group}, top 25")
    return ctx.result(
        "value_concentration", "Value concentration",
        summary=[
            LabelValue(label="Groups", value=f"{n:,}"),
            LabelValue(label=f"Groups making {p.threshold:.0%}", value=f"{needed:,}",
                       hint=f"{needed / n:.1%} of groups"),
            LabelValue(label="Top group share", value=f"{share.iloc[0]:.1%}", hint=display_value(totals.index[0])),
            LabelValue(label="Gini coefficient", value=_fmt(gini), hint="0 = equal, 1 = one group holds all"),
        ],
        table=ctx.table(table), chart=chart, aggregation=f"{measure} by {p.group}",
        notes=["Groups with zero or negative totals are excluded from shares."],
    )


# ---- 2. Group comparison ------------------------------------------------------------------

class GroupComparisonParams(BaseModel):
    metric: str = column_param(kinds=["numeric"], title="Metric")
    group: str = column_param(kinds=["categorical", "boolean"], title="Group by")
    max_groups: int = Field(default=12, ge=2, le=30, title="Max groups")


@register_analysis("group_comparison", title="Group comparison",
                   description="Compare a numeric metric across groups with descriptive statistics and a "
                               "Kruskal–Wallis test (a non-parametric test of whether distributions differ).",
                   params=GroupComparisonParams)
def group_comparison(ctx: AnalysisContext, p: GroupComparisonParams) -> AnalysisResult:
    ctx.require(p.metric, kinds={"numeric"})
    ctx.require(p.group)
    frame = ctx.frame[[p.group, p.metric]].dropna()
    labels = frame[p.group].astype("str")
    keep = labels.value_counts().index[: p.max_groups]
    frame, labels = frame[labels.isin(keep)], labels[labels.isin(keep)]
    grouped = frame.groupby(labels, observed=True)[p.metric]
    table = grouped.agg(["count", "mean", "median", "std", "min", "max"]).sort_values("mean", ascending=False)
    table = table.reset_index().rename(columns={p.group: "group", "index": "group"})
    samples = [g.to_numpy(dtype=float) for _, g in grouped if len(g) >= 2]
    p_value = statistic = epsilon = None
    if len(samples) >= 2:
        try:
            statistic, p_value = stats.kruskal(*samples)
            n_total = sum(len(s) for s in samples)
            epsilon = float(statistic) / ((n_total**2 - 1) / (n_total + 1)) if n_total > 1 else None
        except ValueError:
            pass
    chart_rows = to_records(table.rename(columns={"group": "x", "mean": "value"})[["x", "value"]])
    chart = ctx.chart(ChartSpec(type="bar", x=p.group, y=p.metric, agg="mean"), chart_rows, series=["value"],
                      x_label=p.group, y_label=f"mean of {p.metric}",
                      aggregation=f"mean of {p.metric} by {p.group}")
    notes = ["A small p-value says the groups' distributions differ; it does not say why or by how much "
             "in business terms, and it does not establish causation."]
    if len(keep) < ctx.frame[p.group].nunique():
        notes.append(f"Only the {len(keep)} largest groups are compared.")
    return ctx.result(
        "group_comparison", f"{p.metric} by {p.group}",
        summary=[
            LabelValue(label="Groups compared", value=f"{len(table):,}"),
            LabelValue(label="Highest mean", value=_fmt(table["mean"].iloc[0], 2), hint=str(table["group"].iloc[0])),
            LabelValue(label="Lowest mean", value=_fmt(table["mean"].iloc[-1], 2), hint=str(table["group"].iloc[-1])),
            LabelValue(label="Kruskal–Wallis p", value=_fmt(clean_float(p_value), 4) if p_value is not None else "—",
                       hint=f"ε² = {_fmt(epsilon)}" if epsilon is not None else None),
        ],
        table=ctx.table(table.round(4)), chart=chart, notes=notes,
        aggregation=f"{p.metric} by {p.group}",
    )


# ---- 3. Association ranking -------------------------------------------------------------

def _cramers_v(x: pd.Series, y: pd.Series) -> float | None:
    table = pd.crosstab(x, y)
    if table.shape[0] < 2 or table.shape[1] < 2:
        return None
    chi2 = stats.chi2_contingency(table, correction=False)[0]
    n = table.to_numpy().sum()
    return float(np.sqrt(chi2 / (n * (min(table.shape) - 1))))


def _correlation_ratio(categories: pd.Series, values: pd.Series) -> float | None:
    frame = pd.DataFrame({"c": categories, "v": values.astype(float)}).dropna()
    if frame["c"].nunique() < 2:
        return None
    overall = frame["v"].mean()
    groups = frame.groupby("c", observed=True)["v"]
    between = (groups.count() * (groups.mean() - overall) ** 2).sum()
    total = ((frame["v"] - overall) ** 2).sum()
    return float(np.sqrt(between / total)) if total > 0 else None


class AssociationParams(BaseModel):
    target: str = column_param(kinds=["numeric", "categorical", "boolean"], title="Target",
                               description="The outcome to rank other columns against.")
    max_categories: int = Field(default=50, ge=2, le=500, title="Max categories per column")


@register_analysis("association_ranking", title="Association ranking",
                   description="Rank every column by the strength of its association with a target: "
                               "Spearman |ρ|, correlation ratio η, or Cramér's V depending on column types.",
                   params=AssociationParams)
def association_ranking(ctx: AnalysisContext, p: AssociationParams) -> AnalysisResult:
    ctx.require(p.target)
    frame, sampled = sample_frame(ctx.frame, ctx.settings.profile_sample_rows)
    target = frame[p.target]
    target_numeric = is_numeric(target) and target.nunique() > 15
    rows = []
    for column in frame.columns:
        if column == p.target:
            continue
        series = frame[column]
        kind = infer_kind(series)
        if kind in {"text", "datetime"} or series.nunique() <= 1:
            continue
        numeric = kind == "numeric"
        if not numeric and series.nunique() > p.max_categories:
            continue
        if numeric and target_numeric:
            score, method = series.corr(target, method="spearman"), "Spearman |ρ|"
            score = abs(score) if pd.notna(score) else None
        elif numeric:
            score, method = _correlation_ratio(target.astype("str"), series), "correlation ratio η"
        elif target_numeric:
            score, method = _correlation_ratio(series.astype("str"), target), "correlation ratio η"
        else:
            pair = pd.DataFrame({"x": series.astype("str"), "y": target.astype("str")}).dropna()
            score, method = _cramers_v(pair["x"], pair["y"]), "Cramér's V"
        if score is not None and np.isfinite(score):
            rows.append({"column": column, "kind": kind, "method": method, "association": round(float(score), 4)})
    if not rows:
        raise ValidationFailed("No columns could be compared with the target.", code="empty_selection")
    table = pd.DataFrame(rows).sort_values("association", ascending=False)
    top = table.head(20)
    chart = ctx.chart(ChartSpec(type="bar", x="column", y="association", agg="max"),
                      to_records(top.rename(columns={"column": "x", "association": "value"})[["x", "value"]]),
                      series=["value"], x_label="column", y_label="association (0–1)",
                      aggregation=f"association with {p.target}")
    return ctx.result(
        "association_ranking", f"Association with {p.target}",
        summary=[LabelValue(label="Columns ranked", value=f"{len(table):,}"),
                 LabelValue(label="Strongest", value=str(table["column"].iloc[0]),
                            hint=f"{table['association'].iloc[0]:.3f} ({table['method'].iloc[0]})")],
        table=ctx.table(table), chart=chart, sampled=sampled, sample_size=len(frame) if sampled else None,
        notes=["Scores are comparable within one method only. Association is not causation, and a very "
               "strong score can signal leakage (a column derived from the outcome)."],
        aggregation=f"pairwise association with {p.target}",
    )


# ---- 4. K-means segmentation --------------------------------------------------------------

class SegmentParams(BaseModel):
    features: list[str] = column_param(kinds=["numeric"], multiple=True, title="Features")
    k: int = Field(default=4, ge=2, le=12, title="Segments (k)")
    random_state: int = Field(default=42, title="Random seed")


@register_analysis("kmeans_segments", title="K-means segmentation",
                   description="Group rows into k segments on standardized numeric features and profile each "
                               "segment. Descriptive: segments are a lens, not ground truth.",
                   params=SegmentParams)
def kmeans_segments(ctx: AnalysisContext, p: SegmentParams) -> AnalysisResult:
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score
    from sklearn.preprocessing import StandardScaler

    if len(p.features) < 1:
        raise ValidationFailed("Choose at least one numeric feature.", code="invalid_param")
    ctx.require(*p.features, kinds={"numeric"})
    data = ctx.frame[p.features].dropna()
    if len(data) < p.k * 5:
        raise ValidationFailed(f"Only {len(data)} complete rows; need at least {p.k * 5}.", code="too_few_rows")
    scaled = StandardScaler().fit_transform(data.astype(float))
    model = KMeans(n_clusters=p.k, n_init=10, random_state=p.random_state).fit(scaled)
    labels = model.labels_
    probe = np.random.default_rng(p.random_state).choice(len(scaled), min(len(scaled), 5_000), replace=False)
    silhouette = float(silhouette_score(scaled[probe], labels[probe])) if len(set(labels[probe])) > 1 else None
    profile = data.assign(segment=[f"S{i + 1}" for i in labels]).groupby("segment")
    table = profile[p.features].mean().round(4)
    table.insert(0, "rows", profile.size())
    table.insert(1, "share", (profile.size() / len(data)).round(4))
    table = table.reset_index()
    chart = ctx.chart(ChartSpec(type="bar", x="segment", agg="count"),
                      to_records(table.rename(columns={"segment": "x", "rows": "value"})[["x", "value"]]),
                      series=["value"], x_label="segment", y_label="rows", aggregation=f"k-means, k={p.k}")
    dropped = len(ctx.frame) - len(data)
    notes = ["Segment means are in original units; clustering used standardized features."]
    if dropped:
        notes.append(f"{dropped:,} rows with missing feature values were not segmented.")
    return ctx.result(
        "kmeans_segments", f"{p.k} segments",
        summary=[LabelValue(label="Rows segmented", value=f"{len(data):,}"),
                 LabelValue(label="Silhouette", value=_fmt(silhouette),
                            hint="-1 to 1; higher means better-separated segments")],
        table=ctx.table(table), chart=chart, notes=notes, aggregation=f"k-means on {', '.join(p.features)}",
    )


# ---- 5. Anomaly scoring --------------------------------------------------------------------

class AnomalyParams(BaseModel):
    features: list[str] = column_param(kinds=["numeric"], multiple=True, title="Features")
    contamination: float = Field(default=0.01, ge=0.001, le=0.2, title="Expected anomaly share")
    top_n: int = Field(default=50, ge=5, le=500, title="Rows to list")


@register_analysis("anomaly_scores", title="Anomaly scoring (Isolation Forest)",
                   description="Score rows by how isolated they are in the selected numeric features and list "
                               "the most unusual ones. Unusual is not the same as wrong.",
                   params=AnomalyParams)
def anomaly_scores(ctx: AnalysisContext, p: AnomalyParams) -> AnalysisResult:
    from sklearn.ensemble import IsolationForest

    if not p.features:
        raise ValidationFailed("Choose at least one numeric feature.", code="invalid_param")
    ctx.require(*p.features, kinds={"numeric"})
    data = ctx.frame[p.features].dropna().astype(float)
    if len(data) < 50:
        raise ValidationFailed("At least 50 complete rows are needed.", code="too_few_rows")
    model = IsolationForest(contamination=p.contamination, random_state=0, n_estimators=200).fit(data)
    scores = -model.score_samples(data)
    flagged = int((model.predict(data) == -1).sum())
    ranked = data.assign(anomaly_score=np.round(scores, 4)).sort_values("anomaly_score", ascending=False)
    ranked.insert(0, "row", ranked.index)
    edges = np.histogram_bin_edges(scores, bins=30)
    counts, _ = np.histogram(scores, bins=edges)
    rows = [{"x": round(float((a + b) / 2), 4), "x0": float(a), "x1": float(b), "count": int(c)}
            for a, b, c in zip(edges[:-1], edges[1:], counts, strict=True)]
    chart = ctx.chart(ChartSpec(type="histogram", x="anomaly_score"), rows, series=["count"],
                      x_label="anomaly score", y_label="rows", x_kind="numeric",
                      aggregation="Isolation Forest score distribution")
    return ctx.result(
        "anomaly_scores", "Anomaly scores",
        summary=[LabelValue(label="Rows scored", value=f"{len(data):,}"),
                 LabelValue(label="Flagged", value=f"{flagged:,}", hint=f"contamination = {p.contamination:g}")],
        table=ctx.table(ranked.head(p.top_n)), chart=chart,
        notes=["The flagged count follows directly from the contamination you set; it is not discovered "
               "from the data. Review flagged rows before treating them as errors or fraud."],
        aggregation=f"Isolation Forest on {', '.join(p.features)}",
    )


# ---- 6. Time trend -------------------------------------------------------------------------

class TrendParams(BaseModel):
    date: str = column_param(kinds=["datetime"], title="Date column")
    value: str | None = column_param(kinds=["numeric"], default=None, title="Value",
                                     description="Leave empty to count rows per period.")
    agg: Literal["sum", "mean", "median", "count"] = Field(default="sum", title="Aggregation")
    period: Literal["day", "week", "month", "quarter", "year"] = Field(default="month", title="Period")


@register_analysis("time_trend", title="Time trend",
                   description="Aggregate a value per period with period-over-period change and a 3-period "
                               "rolling mean.",
                   params=TrendParams)
def time_trend(ctx: AnalysisContext, p: TrendParams) -> AnalysisResult:
    ctx.require(p.date, kinds={"datetime"})
    if p.value:
        ctx.require(p.value, kinds={"numeric"})
    freq = {"day": "D", "week": "W", "month": "M", "quarter": "Q", "year": "Y"}[p.period]
    dates = ctx.frame[p.date]
    if getattr(dates.dt, "tz", None) is not None:
        dates = dates.dt.tz_localize(None)
    period = dates.dt.to_period(freq).dt.start_time
    if p.value and p.agg != "count":
        series = ctx.frame[p.value].groupby(period).agg(p.agg)
        measure = f"{p.agg} of {p.value}"
    else:
        series = ctx.frame.groupby(period).size()
        measure = "rows"
    series = series.sort_index()
    table = pd.DataFrame({"period": series.index, measure: series.to_numpy()})
    table["change_pct"] = (series.pct_change(fill_method=None) * 100).round(2).to_numpy()
    table["rolling_3"] = series.rolling(3, min_periods=1).mean().round(4).to_numpy()
    rows = to_records(table.rename(columns={"period": "x", measure: "value"})[["x", "value", "rolling_3"]])
    chart = ctx.chart(ChartSpec(type="line", x=p.date, y=p.value, agg=p.agg if p.value else "count",
                                time_bucket=p.period),
                      rows, series=["value", "rolling_3"], x_label=p.date, y_label=measure,
                      aggregation=f"{measure} per {p.period}", x_kind="datetime")
    last = table.iloc[-1]
    return ctx.result(
        "time_trend", f"{measure} per {p.period}",
        summary=[LabelValue(label="Periods", value=f"{len(table):,}"),
                 LabelValue(label="Latest period", value=_fmt(float(last[measure]), 2),
                            hint=display_value(last["period"])),
                 LabelValue(label="Change vs previous", value=(f"{last['change_pct']:+.1f}%"
                                                               if pd.notna(last["change_pct"]) else "—"))],
        table=ctx.table(table), chart=chart, aggregation=f"{measure} per {p.period}",
        notes=["The first and last periods may be partial; compare complete periods only."],
    )
