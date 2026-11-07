from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.api.deps import DatasetIdPath, DatasetsDep, SettingsDep, attachment, csv_stream
from app.core.errors import ValidationFailed
from app.schemas.analysis import (
    AggregateRequest,
    AggregateResponse,
    ChartData,
    ChartSpec,
    QueryRequest,
    QueryResponse,
    TransformRequest,
    TransformResult,
)
from app.services.analytics.charts import build_chart
from app.services.analytics.query import query_frame, run_aggregate, run_query
from app.services.preprocessing.transforms import run_recipe
from app.utils.frames import column_infos, to_rows

router = APIRouter(prefix="/datasets/{dataset_id}", tags=["analysis"])


@router.post("/query", response_model=QueryResponse)
def query(dataset_id: DatasetIdPath, request: QueryRequest, datasets: DatasetsDep) -> QueryResponse:
    """Filter, search, sort, and page records. At most ``limit`` (≤ 500) rows are returned."""
    return run_query(datasets.frame(dataset_id), request)


@router.post("/aggregate", response_model=AggregateResponse)
def aggregate(dataset_id: DatasetIdPath, request: AggregateRequest, datasets: DatasetsDep) -> AggregateResponse:
    return run_aggregate(datasets.frame(dataset_id), request, dataset_id=dataset_id,
                         dataset_name=datasets.name(dataset_id))


@router.post("/visualize", response_model=ChartData)
def visualize(dataset_id: DatasetIdPath, spec: ChartSpec, datasets: DatasetsDep,
              settings: SettingsDep) -> ChartData:
    """Build an aggregated, chart-ready series server-side."""
    return build_chart(datasets.frame(dataset_id), spec, dataset_id=dataset_id,
                       dataset_name=datasets.name(dataset_id), settings=settings)


@router.post("/transform", response_model=TransformResult)
def transform(dataset_id: DatasetIdPath, request: TransformRequest, datasets: DatasetsDep) -> TransformResult:
    """Apply a recipe to a copy of the dataset. ``preview`` returns the result without saving it;
    otherwise a new derived dataset is created and the source is left untouched."""
    frame = datasets.frame(dataset_id)
    recipe = run_recipe(frame, request.steps, request.split)
    result = recipe.frame
    if result.shape[1] == 0:
        raise ValidationFailed("The recipe removes every column.", code="empty_result")
    new_id = None
    if not request.preview:
        parent_name = datasets.name(dataset_id)
        derived = datasets.create_derived(
            dataset_id, result.reset_index(drop=True),
            name=request.name or f"{parent_name} · prepared",
            lineage={"steps": [s.model_dump(exclude_defaults=True) for s in request.steps],
                     "log": [log.model_dump() for log in recipe.logs],
                     "split": request.split.model_dump() if request.split else None})
        new_id = derived.id
    return TransformResult(preview=request.preview, dataset_id=new_id, n_rows_before=len(frame),
                           n_rows_after=len(result), n_cols_before=frame.shape[1], n_cols_after=result.shape[1],
                           log=recipe.logs, columns=column_infos(result), rows=to_rows(result.head(20)),
                           warnings=recipe.warnings)


@router.post("/export", response_class=StreamingResponse,
             responses={200: {"content": {"text/csv": {}}}})
def export_filtered(dataset_id: DatasetIdPath, request: QueryRequest, datasets: DatasetsDep):
    """Download every row matching the filters/search/sort as CSV (paging is ignored)."""
    frame = query_frame(datasets.frame(dataset_id), request)
    return StreamingResponse(csv_stream(frame), media_type="text/csv; charset=utf-8",
                             headers=attachment(f"{datasets.name(dataset_id)} · filtered.csv"))
