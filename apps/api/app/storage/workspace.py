"""Local filesystem workspace.

Layout under ``settings.data_dir``::

    datasets/<id>/manifest.json     metadata (DatasetManifest)
    datasets/<id>/original.<ext>    the untouched uploaded file
    datasets/<id>/data.parquet      canonical parsed table used by every service
    datasets/<id>/profile.json      cached profile
    experiments/<id>.json           experiment record
    experiments/<id>.predictions.parquet
    findings.json, pitch.json, views.json
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

import pandas as pd

from app.core.config import Settings
from app.core.errors import NotFoundError
from app.storage.paths import check_id, safe_child


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=path.suffix)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write_json(path: Path, payload: Any) -> None:
    atomic_write_text(path, json.dumps(payload, ensure_ascii=False, indent=2, default=str))


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


class Workspace:
    """Owns every path the API reads or writes, plus a small DataFrame cache."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.root = Path(settings.data_dir)
        self.datasets_dir = self.root / "datasets"
        self.experiments_dir = self.root / "experiments"
        for directory in (self.datasets_dir, self.experiments_dir):
            directory.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._frames: OrderedDict[tuple[str, float], pd.DataFrame] = OrderedDict()

    # ---- datasets -------------------------------------------------------
    def dataset_dir(self, dataset_id: str) -> Path:
        return safe_child(self.datasets_dir, check_id(dataset_id))

    def manifest_path(self, dataset_id: str) -> Path:
        return self.dataset_dir(dataset_id) / "manifest.json"

    def data_path(self, dataset_id: str) -> Path:
        return self.dataset_dir(dataset_id) / "data.parquet"

    def profile_path(self, dataset_id: str) -> Path:
        return self.dataset_dir(dataset_id) / "profile.json"

    def original_path(self, dataset_id: str, extension: str) -> Path:
        return self.dataset_dir(dataset_id) / f"original{extension}"

    def read_manifest(self, dataset_id: str) -> dict[str, Any]:
        manifest = read_json(self.manifest_path(dataset_id))
        if manifest is None:
            raise NotFoundError(f"Dataset {dataset_id} does not exist.", code="dataset_not_found")
        return manifest

    def write_manifest(self, dataset_id: str, manifest: dict[str, Any]) -> None:
        write_json(self.manifest_path(dataset_id), manifest)

    def list_manifests(self) -> list[dict[str, Any]]:
        manifests = []
        for child in self.datasets_dir.iterdir():
            manifest = read_json(child / "manifest.json") if child.is_dir() else None
            if manifest:
                manifests.append(manifest)
        return sorted(manifests, key=lambda m: m.get("created_at", ""), reverse=True)

    def delete_dataset(self, dataset_id: str) -> None:
        directory = self.dataset_dir(dataset_id)
        if not directory.exists():
            raise NotFoundError(f"Dataset {dataset_id} does not exist.", code="dataset_not_found")
        self.evict(dataset_id)
        shutil.rmtree(directory)

    # ---- frames ---------------------------------------------------------
    def save_frame(self, dataset_id: str, frame: pd.DataFrame) -> Path:
        path = self.data_path(dataset_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".parquet.tmp")
        frame.to_parquet(tmp, index=False)
        os.replace(tmp, path)
        self.evict(dataset_id)
        return path

    def load_frame(self, dataset_id: str) -> pd.DataFrame:
        """Return the dataset table. Callers must treat it as read-only (copy before mutating)."""
        path = self.data_path(dataset_id)
        if not path.exists():
            manifest = self.read_manifest(dataset_id)
            raise NotFoundError(
                f"Dataset '{manifest.get('name')}' has not been imported yet.",
                code="dataset_not_ready",
            )
        key = (dataset_id, path.stat().st_mtime)
        with self._lock:
            if key in self._frames:
                self._frames.move_to_end(key)
                return self._frames[key]
        frame = pd.read_parquet(path)
        with self._lock:
            self._frames[key] = frame
            while len(self._frames) > self.settings.dataframe_cache_size:
                self._frames.popitem(last=False)
        return frame

    def evict(self, dataset_id: str) -> None:
        with self._lock:
            for key in [k for k in self._frames if k[0] == dataset_id]:
                del self._frames[key]

    # ---- singletons (findings, pitch, saved views) ------------------------
    def doc_path(self, name: str) -> Path:
        return safe_child(self.root, f"{name}.json")

    def read_doc(self, name: str, default: Any) -> Any:
        return read_json(self.doc_path(name), default)

    def write_doc(self, name: str, payload: Any) -> None:
        write_json(self.doc_path(name), payload)

    # ---- experiments ----------------------------------------------------
    def experiment_path(self, experiment_id: str) -> Path:
        return safe_child(self.experiments_dir, f"{check_id(experiment_id)}.json")

    def predictions_path(self, experiment_id: str) -> Path:
        return safe_child(self.experiments_dir, f"{check_id(experiment_id)}.predictions.parquet")
