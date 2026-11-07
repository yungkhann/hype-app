from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, File, Form, Query, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, StreamingResponse

from app.api.deps import DatasetIdPath, DatasetsDep, SettingsDep, attachment, csv_stream
from app.schemas.common import Deleted
from app.schemas.datasets import (
    DatasetDetail,
    DatasetSummary,
    DatasetUpdate,
    IngestOptions,
    PreviewResponse,
    SampleInfo,
    StagedPreview,
)
from app.schemas.profile import DatasetProfile
from app.services.datasets import receive_upload

router = APIRouter(prefix="/datasets", tags=["datasets"])


@router.get("", response_model=list[DatasetSummary])
def list_datasets(datasets: DatasetsDep) -> list[DatasetSummary]:
    return datasets.list()


@router.post("", response_model=StagedPreview, status_code=status.HTTP_201_CREATED)
async def upload_dataset(datasets: DatasetsDep, settings: SettingsDep,
                         file: Annotated[UploadFile, File(description="CSV, XLSX, or Parquet file")],
                         name: Annotated[str | None, Form(max_length=120)] = None) -> StagedPreview:
    """Stage an upload: store the original untouched, detect its format, and preview the first rows."""
    tmp, size, sha256, head = await receive_upload(file, datasets.ws.root / "tmp", settings.max_upload_bytes)
    return await run_in_threadpool(datasets.stage, tmp, filename=file.filename or "upload", size=size,
                                   sha256=sha256, head=head, name=name)


@router.get("/samples", response_model=list[SampleInfo])
def list_samples(datasets: DatasetsDep) -> list[SampleInfo]:
    return datasets.samples()


@router.post("/samples/{filename}", response_model=DatasetDetail, status_code=status.HTTP_201_CREATED)
def load_sample(filename: str, datasets: DatasetsDep) -> DatasetDetail:
    return datasets.load_sample(filename)


@router.get("/{dataset_id}", response_model=DatasetDetail)
def get_dataset(dataset_id: DatasetIdPath, datasets: DatasetsDep) -> DatasetDetail:
    return datasets.get(dataset_id)


@router.patch("/{dataset_id}", response_model=DatasetDetail)
def rename_dataset(dataset_id: DatasetIdPath, body: DatasetUpdate, datasets: DatasetsDep) -> DatasetDetail:
    return datasets.rename(dataset_id, body.name)


@router.delete("/{dataset_id}", response_model=Deleted)
def delete_dataset(dataset_id: DatasetIdPath, datasets: DatasetsDep) -> Deleted:
    datasets.delete(dataset_id)
    return Deleted(id=dataset_id)


@router.post("/{dataset_id}/stage-preview", response_model=StagedPreview)
def stage_preview(dataset_id: DatasetIdPath, options: IngestOptions, datasets: DatasetsDep) -> StagedPreview:
    """Re-parse the first rows of a staged upload with different options (sheet, delimiter, encoding)."""
    return datasets.stage_preview(dataset_id, options)


@router.post("/{dataset_id}/import", response_model=DatasetDetail)
def import_dataset(dataset_id: DatasetIdPath, datasets: DatasetsDep,
                   options: IngestOptions | None = None) -> DatasetDetail:
    """Parse the whole staged file, store the canonical table, and profile it."""
    return datasets.import_dataset(dataset_id, options)


@router.post("/{dataset_id}/replace", response_model=StagedPreview)
async def replace_dataset(dataset_id: DatasetIdPath, datasets: DatasetsDep, settings: SettingsDep,
                          file: Annotated[UploadFile, File()]) -> StagedPreview:
    """Swap in a new file under the same dataset id and name; it must be imported again."""
    datasets.get(dataset_id)
    tmp, size, sha256, head = await receive_upload(file, datasets.ws.root / "tmp", settings.max_upload_bytes)
    return await run_in_threadpool(datasets.stage, tmp, filename=file.filename or "upload", size=size,
                                   sha256=sha256, head=head, name=None, dataset_id=dataset_id)


@router.post("/{dataset_id}/replace/cancel", response_model=DatasetDetail)
def cancel_replace(dataset_id: DatasetIdPath, datasets: DatasetsDep) -> DatasetDetail:
    """Discard a staged replacement and restore the previous version unchanged."""
    return datasets.cancel_replace(dataset_id)


@router.get("/{dataset_id}/preview", response_model=PreviewResponse)
def preview(dataset_id: DatasetIdPath, datasets: DatasetsDep,
            limit: Annotated[int, Query(ge=1, le=500)] = 50) -> PreviewResponse:
    return datasets.preview(dataset_id, limit)


@router.get("/{dataset_id}/profile", response_model=DatasetProfile)
def profile(dataset_id: DatasetIdPath, datasets: DatasetsDep, refresh: bool = False) -> DatasetProfile:
    return datasets.profile(dataset_id, refresh=refresh)


@router.post("/{dataset_id}/profile/refresh", response_model=DatasetProfile)
def refresh_profile(dataset_id: DatasetIdPath, datasets: DatasetsDep) -> DatasetProfile:
    return datasets.profile(dataset_id, refresh=True)


@router.get("/{dataset_id}/download", response_class=StreamingResponse,
            responses={200: {"content": {"text/csv": {}, "application/octet-stream": {}}}})
def download(dataset_id: DatasetIdPath, datasets: DatasetsDep,
             format: Literal["csv", "parquet", "original"] = "csv"):
    """Download the processed table (CSV/Parquet) or the untouched original upload."""
    detail = datasets.get(dataset_id)
    if format == "original":
        path, filename = datasets.original_file(dataset_id)
        return FileResponse(path, headers=attachment(filename), media_type="application/octet-stream")
    if format == "parquet":
        return FileResponse(datasets.ws.data_path(dataset_id), headers=attachment(f"{detail.name}.parquet"),
                            media_type="application/octet-stream")
    frame = datasets.frame(dataset_id)
    return StreamingResponse(csv_stream(frame), media_type="text/csv; charset=utf-8",
                             headers=attachment(f"{detail.name}.csv"))
