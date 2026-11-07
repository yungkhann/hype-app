from __future__ import annotations

from fastapi import APIRouter, status
from fastapi.responses import JSONResponse, StreamingResponse

from app.api.deps import ExperimentIdPath, ExperimentsDep, attachment, csv_stream
from app.schemas.common import Deleted
from app.schemas.experiments import (
    ExperimentDetail,
    ExperimentRequest,
    ExperimentSummary,
    ModelCheckRequest,
    ModelCheckResponse,
    ModelOption,
)
from app.services.modeling.pipelines import MODEL_OPTIONS

router = APIRouter(tags=["models"])


@router.get("/models", response_model=list[ModelOption])
def list_models() -> list[ModelOption]:
    return MODEL_OPTIONS


@router.post("/experiments/check", response_model=ModelCheckResponse)
def check(request: ModelCheckRequest, experiments: ExperimentsDep) -> ModelCheckResponse:
    """Validate a target/feature setup and report leakage hazards before training."""
    return experiments.check(request)


@router.post("/experiments", response_model=ExperimentDetail, status_code=status.HTTP_202_ACCEPTED)
def create_experiment(request: ExperimentRequest, experiments: ExperimentsDep) -> ExperimentDetail:
    """Queue training in the background. Poll ``GET /experiments/{id}`` for status."""
    return experiments.submit(request)


@router.get("/experiments", response_model=list[ExperimentSummary])
def list_experiments(experiments: ExperimentsDep, dataset_id: str | None = None) -> list[ExperimentSummary]:
    return experiments.list(dataset_id)


@router.get("/experiments/{experiment_id}", response_model=ExperimentDetail)
def get_experiment(experiment_id: ExperimentIdPath, experiments: ExperimentsDep) -> ExperimentDetail:
    return experiments.get(experiment_id)


@router.delete("/experiments/{experiment_id}", response_model=Deleted)
def delete_experiment(experiment_id: ExperimentIdPath, experiments: ExperimentsDep) -> Deleted:
    experiments.delete(experiment_id)
    return Deleted(id=experiment_id)


@router.get("/experiments/{experiment_id}/predictions.csv", response_class=StreamingResponse,
            responses={200: {"content": {"text/csv": {}}}})
def predictions_csv(experiment_id: ExperimentIdPath, experiments: ExperimentsDep):
    """Test-partition predictions: original row index, actual, predicted, and class probabilities."""
    frame = experiments.predictions(experiment_id)
    name = experiments.get(experiment_id).name
    return StreamingResponse(csv_stream(frame), media_type="text/csv; charset=utf-8",
                             headers=attachment(f"{name} · predictions.csv"))


@router.get("/experiments/{experiment_id}/metrics.json")
def metrics_json(experiment_id: ExperimentIdPath, experiments: ExperimentsDep) -> JSONResponse:
    detail = experiments.get(experiment_id)
    payload = detail.model_dump(mode="json", include={
        "id", "name", "dataset_id", "dataset_name", "target", "task", "model", "request", "split_info",
        "features_used", "dropped_features", "metrics", "baseline_metrics", "primary_metric",
        "baseline_metric", "positive_label", "confusion", "feature_importance", "importance_method",
        "warnings", "created_at", "finished_at", "duration_s",
    })
    return JSONResponse(payload, headers=attachment(f"{detail.name} · metrics.json"))
