"""Case-specific analyses. Copy the template below, rename it, and implement the case logic.

The template is deliberately generic (it assumes nothing about the case) so the Challenge page has a
working example end to end. Delete or replace it once real case analyses exist.
"""

from __future__ import annotations

from pydantic import BaseModel

from app.extensions.registry import AnalysisContext, column_param, register_analysis
from app.schemas.analysis import ChartSpec
from app.schemas.common import LabelValue
from app.schemas.extensions import AnalysisResult
from app.utils.frames import to_records


class SegmentKpiParams(BaseModel):
    segment: str = column_param(kinds=["categorical", "boolean"], title="Segment column")
    metric: str = column_param(kinds=["numeric"], title="Metric column")


@register_analysis("challenge_template_segment_kpis", category="challenge",
                   title="Template · KPIs by segment",
                   description="Example challenge module: rows, total, mean, and share of total per segment. "
                               "Replace with the case's own logic.",
                   params=SegmentKpiParams)
def segment_kpis(ctx: AnalysisContext, p: SegmentKpiParams) -> AnalysisResult:
    ctx.require(p.segment)
    ctx.require(p.metric, kinds={"numeric"})
    frame = ctx.frame
    grouped = frame.groupby(frame[p.segment].astype("str"), observed=True)[p.metric]
    table = grouped.agg(rows="count", total="sum", mean="mean").sort_values("total", ascending=False)
    grand_total = float(table["total"].sum())
    table["share_of_total"] = (table["total"] / grand_total).round(4) if grand_total else 0.0
    table = table.round(4).reset_index().rename(columns={p.segment: "segment"})
    chart = ctx.chart(ChartSpec(type="bar", x=p.segment, y=p.metric, agg="sum"),
                      to_records(table.rename(columns={"segment": "x", "total": "value"})[["x", "value"]].head(20)),
                      series=["value"], x_label=p.segment, y_label=f"sum of {p.metric}",
                      aggregation=f"sum of {p.metric} by {p.segment}")
    return ctx.result(
        "challenge_template_segment_kpis", f"{p.metric} by {p.segment}",
        summary=[LabelValue(label="Segments", value=f"{len(table):,}"),
                 LabelValue(label=f"Total {p.metric}", value=f"{grand_total:,.2f}")],
        table=ctx.table(table), chart=chart, aggregation=f"{p.metric} by {p.segment}",
        notes=["Template output. Interpretation belongs in a Finding, written by the team."],
    )
