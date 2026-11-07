"""Dataset lifecycle: stage an upload → preview with detected options → import → profile."""

from __future__ import annotations

import hashlib
import shutil
import tempfile
from pathlib import Path
from typing import Any

import pandas as pd
from fastapi import UploadFile

from app.core.config import Settings
from app.core.errors import ConflictError, NotFoundError, PayloadTooLarge, ValidationFailed
from app.schemas.datasets import (
    DatasetDetail,
    DatasetSummary,
    DetectedFormat,
    IngestOptions,
    PreviewResponse,
    SampleInfo,
    StagedPreview,
)
from app.schemas.profile import DatasetProfile
from app.services.ingestion import readers
from app.services.profiling.profiler import build_profile
from app.storage.paths import new_id, safe_child, sanitize_filename
from app.storage.workspace import Workspace, read_json
from app.utils.frames import column_infos, now_iso, to_rows

BACKUP_DIR = "previous"

STAGE_PREVIEW_ROWS = 20
CHUNK = 1024 * 1024


async def receive_upload(upload: UploadFile, directory: Path, max_bytes: int) -> tuple[Path, int, str, bytes]:
    """Stream an upload to a temp file, enforcing the size limit without buffering it in memory."""
    directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    head = b""
    fd, tmp_name = tempfile.mkstemp(dir=directory, prefix=".upload-")
    tmp = Path(tmp_name)
    try:
        with open(fd, "wb") as handle:
            while chunk := await upload.read(CHUNK):
                size += len(chunk)
                if size > max_bytes:
                    raise PayloadTooLarge(
                        f"File exceeds the {max_bytes // (1024 * 1024)} MB limit "
                        "(raise ATLAS_MAX_UPLOAD_MB to allow larger files).")
                if len(head) < 8192:
                    head += chunk[: 8192 - len(head)]
                digest.update(chunk)
                handle.write(chunk)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    if size == 0:
        tmp.unlink(missing_ok=True)
        raise ValidationFailed("The uploaded file is empty.", code="empty_file")
    return tmp, size, digest.hexdigest(), head


class DatasetService:
    def __init__(self, workspace: Workspace, settings: Settings) -> None:
        self.ws = workspace
        self.settings = settings

    # ---- read ---------------------------------------------------------------
    def list(self) -> list[DatasetSummary]:
        return [DatasetSummary.model_validate(m) for m in self.ws.list_manifests()]

    def get(self, dataset_id: str) -> DatasetDetail:
        return DatasetDetail.model_validate(self.ws.read_manifest(dataset_id))

    def frame(self, dataset_id: str) -> pd.DataFrame:
        return self.ws.load_frame(dataset_id)

    def name(self, dataset_id: str) -> str:
        return str(self.ws.read_manifest(dataset_id).get("name"))

    def preview(self, dataset_id: str, limit: int) -> PreviewResponse:
        frame = self.frame(dataset_id)
        head = frame.head(min(limit, self.settings.max_page_size))
        return PreviewResponse(columns=column_infos(frame), rows=to_rows(head), n_rows=len(frame),
                               limit=limit)

    # ---- staging ------------------------------------------------------------
    def stage(self, tmp_path: Path, *, filename: str, size: int, sha256: str, head: bytes,
              name: str | None, source: str = "upload", is_synthetic: bool = False,
              dataset_id: str | None = None) -> StagedPreview:
        safe_name = sanitize_filename(filename)
        try:
            fmt = readers.format_for(safe_name, head)
        except ValidationFailed:
            tmp_path.unlink(missing_ok=True)
            raise
        extension = Path(safe_name).suffix.lower()
        replacing = dataset_id is not None
        dataset_id = dataset_id or new_id()
        directory = self.ws.dataset_dir(dataset_id)
        if replacing:
            previous = self._backup_for_replace(dataset_id)
        directory.mkdir(parents=True, exist_ok=True)
        original = self.ws.original_path(dataset_id, extension)
        shutil.move(str(tmp_path), original)
        timestamp = now_iso()
        manifest: dict[str, Any] = {
            "id": dataset_id,
            "name": (name or (previous["name"] if replacing else Path(safe_name).stem))[:120],
            "status": "staged",
            "source": source,
            "format": fmt,
            "is_synthetic": is_synthetic,
            "original": {"filename": safe_name, "extension": extension, "size_bytes": size,
                         "sha256": sha256},
            "created_at": previous["created_at"] if replacing else timestamp,
            "updated_at": timestamp,
            "n_rows": None, "n_cols": None, "columns": [], "notes": [],
            "replacing": replacing,
        }
        try:
            readers.preflight(original, fmt, **self._limits())
            detected = readers.detect(original, fmt)
        except (ValidationFailed, PayloadTooLarge) as exc:
            manifest.update(status="failed", error=exc.message)
            self.ws.write_manifest(dataset_id, manifest)
            raise
        manifest["detected"] = detected.model_dump()
        manifest["ingest_options"] = IngestOptions(sheet=detected.sheets[0] if detected.sheets else None
                                                   ).model_dump()
        self.ws.write_manifest(dataset_id, manifest)
        return self.stage_preview(dataset_id, None)

    def _backup_for_replace(self, dataset_id: str) -> dict[str, Any]:
        """Move the current version into ``previous/`` so a replacement never destroys data before
        it is confirmed. A second replacement while one is pending discards only the pending file."""
        directory = self.ws.dataset_dir(dataset_id)
        backup = directory / BACKUP_DIR
        if backup.exists():
            for child in list(directory.iterdir()):
                if child.name != BACKUP_DIR:
                    child.unlink() if child.is_file() else shutil.rmtree(child)
        else:
            backup.mkdir()
            for child in list(directory.iterdir()):
                if child.name != BACKUP_DIR:
                    shutil.move(str(child), backup / child.name)
        self.ws.evict(dataset_id)
        return read_json(backup / "manifest.json", {}) or {}

    def cancel_replace(self, dataset_id: str) -> DatasetDetail:
        """Discard a pending replacement and restore the previous version exactly."""
        directory = self.ws.dataset_dir(dataset_id)
        backup = directory / BACKUP_DIR
        if not backup.exists():
            raise ConflictError("No replacement is pending for this dataset.")
        for child in list(directory.iterdir()):
            if child.name != BACKUP_DIR:
                child.unlink() if child.is_file() else shutil.rmtree(child)
        for child in list(backup.iterdir()):
            shutil.move(str(child), directory / child.name)
        backup.rmdir()
        self.ws.evict(dataset_id)
        return self.get(dataset_id)

    def stage_preview(self, dataset_id: str, options: IngestOptions | None) -> StagedPreview:
        manifest = self.ws.read_manifest(dataset_id)
        detected = DetectedFormat.model_validate(manifest["detected"])
        options = options or IngestOptions.model_validate(manifest.get("ingest_options") or {})
        original = self.ws.original_path(dataset_id, manifest["original"]["extension"])
        warnings: list[str] = []
        columns: list[str] = []
        rows: list[list[Any]] = []
        try:
            frame = readers.READERS[detected.format](original, options, detected, STAGE_PREVIEW_ROWS)
            frame, notes = readers.normalize_columns(frame)
            warnings.extend(notes)
            columns = [str(c) for c in frame.columns]
            rows = to_rows(frame.astype("str").where(frame.notna(), None))
            if len(columns) == 1 and detected.format == "csv":
                warnings.append("Only one column was found. The delimiter may be wrong.")
        except ValidationFailed as exc:
            warnings.append(exc.message)
        if detected.encoding_confidence is not None and detected.encoding_confidence < 0.5:
            warnings.append(f"Encoding detection is uncertain (guessed {detected.encoding}). "
                            "Check that text renders correctly.")
        return StagedPreview(dataset=self.get(dataset_id), columns=columns, rows=rows,
                             warnings=warnings)

    def _limits(self) -> dict[str, int]:
        return {"max_rows": self.settings.max_rows, "max_columns": self.settings.max_columns,
                "max_uncompressed_mb": self.settings.max_uncompressed_mb}

    def import_dataset(self, dataset_id: str, options: IngestOptions | None) -> DatasetDetail:
        manifest = self.ws.read_manifest(dataset_id)
        if manifest.get("source") == "transform":
            raise ConflictError("Derived datasets are created by transforms, not imported.")
        detected = DetectedFormat.model_validate(manifest["detected"])
        options = options or IngestOptions.model_validate(manifest.get("ingest_options") or {})
        original = self.ws.original_path(dataset_id, manifest["original"]["extension"])
        try:
            readers.preflight(original, detected.format, **self._limits())
            # Read one row past the limit so an oversized CSV/workbook stops early instead of filling memory.
            nrows = None if detected.format == "parquet" else self.settings.max_rows + 1
            frame = readers.READERS[detected.format](original, options, detected, nrows)
            if len(frame) > self.settings.max_rows:
                raise ValidationFailed(
                    f"{len(frame):,} rows exceeds the {self.settings.max_rows:,}-row limit "
                    "(raise ATLAS_MAX_ROWS to allow it).", code="too_many_rows")
            if frame.shape[1] > self.settings.max_columns:
                raise ValidationFailed(f"{frame.shape[1]:,} columns exceeds the "
                                       f"{self.settings.max_columns:,}-column limit.",
                                       code="too_many_columns")
            if frame.shape[1] == 0:
                raise ValidationFailed("No columns were found in the file.", code="empty_file")
            frame, column_notes = readers.normalize_columns(frame)
            frame, value_notes = readers.normalize_values(frame)
        except (ValidationFailed, PayloadTooLarge) as exc:
            manifest.update(status="failed", error=exc.message, updated_at=now_iso())
            self.ws.write_manifest(dataset_id, manifest)
            raise
        return self._finalize(dataset_id, manifest, frame, options, column_notes + value_notes)

    def _finalize(self, dataset_id: str, manifest: dict[str, Any], frame: pd.DataFrame,
                  options: IngestOptions | None, notes: list[str]) -> DatasetDetail:
        self.ws.save_frame(dataset_id, frame)
        manifest.update(
            status="ready", error=None, updated_at=now_iso(), n_rows=int(len(frame)),
            n_cols=int(frame.shape[1]), notes=notes,
            columns=[c.model_dump() for c in column_infos(frame)],
            ingest_options=options.model_dump() if options else manifest.get("ingest_options"),
        )
        manifest["replacing"] = False
        self.ws.write_manifest(dataset_id, manifest)
        shutil.rmtree(self.ws.dataset_dir(dataset_id) / BACKUP_DIR, ignore_errors=True)
        self.profile(dataset_id, refresh=True)
        return self.get(dataset_id)

    # ---- derived datasets -----------------------------------------------------
    def create_derived(self, parent_id: str, frame: pd.DataFrame, *, name: str,
                       lineage: dict[str, Any]) -> DatasetDetail:
        parent = self.ws.read_manifest(parent_id)
        dataset_id = new_id()
        timestamp = now_iso()
        manifest = {
            "id": dataset_id, "name": name[:120], "status": "staged", "source": "transform",
            "format": "parquet", "is_synthetic": bool(parent.get("is_synthetic")),
            "original": None, "created_at": timestamp, "updated_at": timestamp,
            "lineage": {"parent_id": parent_id, "parent_name": parent["name"], **lineage},
            "detected": None, "ingest_options": None,
        }
        self.ws.dataset_dir(dataset_id).mkdir(parents=True, exist_ok=True)
        return self._finalize(dataset_id, manifest, frame, None, [])

    # ---- mutate ---------------------------------------------------------------
    def rename(self, dataset_id: str, name: str) -> DatasetDetail:
        manifest = self.ws.read_manifest(dataset_id)
        manifest.update(name=name.strip()[:120], updated_at=now_iso())
        self.ws.write_manifest(dataset_id, manifest)
        return self.get(dataset_id)

    def delete(self, dataset_id: str) -> None:
        self.ws.delete_dataset(dataset_id)

    # ---- profile ----------------------------------------------------------------
    def profile(self, dataset_id: str, refresh: bool = False) -> DatasetProfile:
        path = self.ws.profile_path(dataset_id)
        if path.exists() and not refresh:
            return DatasetProfile.model_validate_json(path.read_text(encoding="utf-8"))
        manifest = self.ws.read_manifest(dataset_id)
        frame = self.frame(dataset_id)
        original = manifest.get("original") or {}
        profile = build_profile(frame, dataset_id=dataset_id, dataset_name=manifest["name"],
                                file_size_bytes=original.get("size_bytes"), settings=self.settings)
        path.write_text(profile.model_dump_json(), encoding="utf-8")
        return profile

    # ---- files ------------------------------------------------------------------
    def original_file(self, dataset_id: str) -> tuple[Path, str]:
        manifest = self.ws.read_manifest(dataset_id)
        original = manifest.get("original")
        if not original:
            raise NotFoundError("This dataset was derived by a transform and has no original file.")
        return self.ws.original_path(dataset_id, original["extension"]), original["filename"]

    # ---- samples ----------------------------------------------------------------
    def samples(self) -> list[SampleInfo]:
        directory = Path(self.settings.samples_dir)
        if not directory.exists():
            return []
        catalog = _sample_catalog(directory)
        infos = []
        for path in sorted(directory.iterdir()):
            if path.suffix.lower() in readers.EXTENSIONS and path.is_file():
                infos.append(SampleInfo(name=path.stem, filename=path.name,
                                        description=catalog.get(path.name, "Synthetic sample dataset."),
                                        size_bytes=path.stat().st_size))
        return infos

    def load_sample(self, filename: str) -> DatasetDetail:
        directory = Path(self.settings.samples_dir)
        source = safe_child(directory, sanitize_filename(filename))
        if not source.is_file() or source.suffix.lower() not in readers.EXTENSIONS:
            raise NotFoundError(f"Sample '{filename}' does not exist.", code="sample_not_found")
        tmp_dir = self.ws.root / "tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkstemp(dir=tmp_dir, prefix=".sample-")[1])
        shutil.copyfile(source, tmp)
        data = source.read_bytes()
        staged = self.stage(tmp, filename=source.name, size=len(data),
                            sha256=hashlib.sha256(data).hexdigest(), head=data[:8192],
                            name=f"{source.stem} (synthetic)", source="sample", is_synthetic=True)
        return self.import_dataset(staged.dataset.id, None)


def _sample_catalog(directory: Path) -> dict[str, str]:
    import json

    catalog_path = directory / "catalog.json"
    if not catalog_path.exists():
        return {}
    try:
        entries = json.loads(catalog_path.read_text(encoding="utf-8"))
    except ValueError:
        return {}
    return {e["filename"]: e.get("description", "") for e in entries if "filename" in e}
