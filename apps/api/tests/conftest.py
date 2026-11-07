from __future__ import annotations

import io
import time
from collections.abc import Iterator
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.core.config import REPO_ROOT, Settings
from app.main import create_app

SAMPLES = REPO_ROOT / "data" / "samples"


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "workspaces", samples_dir=SAMPLES, max_upload_mb=5,
                    max_chart_points=500, profile_sample_rows=50_000, model_workers=1,
                    allowed_hosts=["testserver", "127.0.0.1", "localhost"],
                    # Deterministic tests: never the paid GPT API, and never a key from the developer's environment.
                    cqa_evaluator="mock", cqa_openai_api_key=None)


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def csv_bytes(frame: pd.DataFrame, encoding: str = "utf-8", **kwargs) -> bytes:
    buffer = io.StringIO()
    frame.to_csv(buffer, index=False, **kwargs)
    return buffer.getvalue().encode(encoding)


def upload(client: TestClient, content: bytes, filename: str = "data.csv", name: str | None = None):
    data = {"name": name} if name else {}
    return client.post("/api/v1/datasets", files={"file": (filename, content, "application/octet-stream")},
                       data=data)


def import_frame(client: TestClient, frame: pd.DataFrame, name: str = "test") -> str:
    staged = upload(client, csv_bytes(frame), name=name)
    assert staged.status_code == 201, staged.text
    dataset_id = staged.json()["dataset"]["id"]
    imported = client.post(f"/api/v1/datasets/{dataset_id}/import")
    assert imported.status_code == 200, imported.text
    return dataset_id


def load_sample(client: TestClient, filename: str) -> str:
    response = client.post(f"/api/v1/datasets/samples/{filename}")
    assert response.status_code == 201, response.text
    return response.json()["id"]


def wait_for(client: TestClient, experiment_id: str, timeout: float = 120) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        record = client.get(f"/api/v1/experiments/{experiment_id}").json()
        if record["status"] in {"completed", "failed"}:
            return record
        time.sleep(0.2)
    raise AssertionError(f"Experiment {experiment_id} did not finish in {timeout}s")
