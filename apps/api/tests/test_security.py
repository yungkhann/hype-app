"""Local-API hardening: foreign pages and hostile files must not be able to read, change, or crash the workspace."""

from __future__ import annotations

import io
import zipfile

import pandas as pd
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app
from tests.conftest import SAMPLES, import_frame, upload


def test_unknown_host_header_is_rejected(client):
    """DNS rebinding: a page whose hostname now resolves to 127.0.0.1 still sends its own Host header."""
    assert client.get("/api/v1/health", headers={"host": "evil.example"}).status_code == 400
    assert client.get("/api/v1/health", headers={"host": "127.0.0.1:8000"}).status_code == 200
    assert client.get("/api/v1/health", headers={"host": "localhost:8000"}).status_code == 200


def test_foreign_origin_cannot_change_state(client):
    """CORS hides responses from other sites but does not stop a simple cross-site POST from executing."""
    blocked = client.post("/api/v1/datasets/samples/branches.parquet", headers={"origin": "http://evil.example"})
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "forbidden_origin"
    assert client.get("/api/v1/datasets").json() == []

    null_origin = client.post("/api/v1/datasets/samples/branches.parquet", headers={"origin": "null"})
    assert null_origin.status_code == 403

    allowed = client.post("/api/v1/datasets/samples/branches.parquet", headers={"origin": "http://127.0.0.1:3000"})
    assert allowed.status_code == 201
    # Same-origin requests (the API's own /docs page) and requests without Origin (curl, tests) pass.
    same = client.post("/api/v1/datasets/samples/branches.parquet",
                       headers={"origin": "http://127.0.0.1:8000", "host": "127.0.0.1:8000"})
    assert same.status_code == 201
    assert client.get("/api/v1/datasets", headers={"origin": "http://evil.example"}).status_code == 200


def test_csv_exports_neutralize_spreadsheet_formulas(client):
    frame = pd.DataFrame({"text": ["=1+2", "+SUM(A1)", "@cmd", "-x", "plain", "-5"], "number": [-1, 2, 3, 4, 5, 6]})
    dataset_id = import_frame(client, frame)

    csv = client.get(f"/api/v1/datasets/{dataset_id}/download").content.decode("utf-8-sig")
    lines = csv.strip().splitlines()
    assert lines[1:] == ["'=1+2,-1", "'+SUM(A1),2", "'@cmd,3", "'-x,4", "plain,5", "-5,6"]

    filtered = client.post(f"/api/v1/datasets/{dataset_id}/export", json={}).content.decode("utf-8-sig")
    assert "'=1+2" in filtered and "\n=1+2" not in filtered

    # Parquet stays exact: it is the format for re-use, not for opening in a spreadsheet.
    parquet = client.get(f"/api/v1/datasets/{dataset_id}/download", params={"format": "parquet"})
    assert pd.read_parquet(io.BytesIO(parquet.content))["text"].tolist()[0] == "=1+2"


def test_download_filename_cannot_inject_headers(client):
    dataset_id = import_frame(client, pd.DataFrame({"a": [1, 2, 3]}))
    renamed = client.patch(f"/api/v1/datasets/{dataset_id}", json={"name": 'q"uote\r\nX-Injected: 1'})
    assert renamed.status_code == 200
    for fmt in ("csv", "parquet", "original"):
        response = client.get(f"/api/v1/datasets/{dataset_id}/download", params={"format": fmt})
        disposition = response.headers["content-disposition"]
        assert "x-injected" not in {key.lower() for key in response.headers}
        assert disposition.count('"') == 2 and "\r" not in disposition and "\n" not in disposition


def test_oversized_files_are_rejected_before_they_are_loaded(tmp_path):
    settings = Settings(data_dir=tmp_path / "ws", samples_dir=SAMPLES, max_rows=50, max_uncompressed_mb=1,
                        allowed_hosts=["testserver"])
    with TestClient(create_app(settings)) as client:
        buffer = io.BytesIO()
        pd.DataFrame({"a": range(200)}).to_parquet(buffer)
        # Parquet declares its row count in the footer, so the upload is refused before anything is read.
        staged = upload(client, buffer.getvalue(), filename="big.parquet")
        assert staged.status_code == 422
        assert staged.json()["error"]["code"] == "too_many_rows"

        # A workbook whose parts expand far beyond the limit (a zip bomb) is refused without unpacking it.
        bomb = io.BytesIO()
        with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("xl/worksheets/sheet1.xml", "0" * (3 * 1024 * 1024))
        staged = upload(client, bomb.getvalue(), filename="bomb.xlsx")
        assert staged.status_code in {201, 413, 422}
        if staged.status_code == 201:
            dataset_id = staged.json()["dataset"]["id"]
            imported = client.post(f"/api/v1/datasets/{dataset_id}/import")
            assert imported.status_code in {413, 422}
            assert imported.json()["error"]["code"] == "file_too_large_uncompressed"
        else:
            assert staged.json()["error"]["code"] == "file_too_large_uncompressed"


def test_parse_errors_do_not_leak_local_paths(client, settings):
    staged = upload(client, b"PAR1 definitely not parquet", filename="broken.parquet")
    if staged.status_code == 201:
        dataset_id = staged.json()["dataset"]["id"]
        response = client.post(f"/api/v1/datasets/{dataset_id}/import")
    else:
        response = staged
    assert response.status_code >= 400
    assert str(settings.data_dir) not in response.text
    assert str(settings.data_dir.parent) not in response.text


def test_non_latin_dataset_names_download(client):
    """Cyrillic/Kazakh names must not break the Latin-1-only Content-Disposition header (RFC 5987 filename*)."""
    from urllib.parse import unquote

    dataset_id = import_frame(client, pd.DataFrame({"a": [1, 2, 3]}))
    assert client.patch(f"/api/v1/datasets/{dataset_id}", json={"name": "Клиенты Қазақстан"}).status_code == 200
    for fmt in ("csv", "parquet", "original"):
        response = client.get(f"/api/v1/datasets/{dataset_id}/download", params={"format": fmt})
        assert response.status_code == 200, fmt
        disposition = response.headers["content-disposition"]
        disposition.encode("latin-1")  # header is transmittable
        fallback = disposition.split('filename="')[1].split('"')[0]
        assert fallback.isascii() and fallback.strip("._ ")
        if fmt != "original":
            assert "Клиенты Қазақстан" in unquote(disposition.split("filename*=UTF-8''")[1])
    exported = client.post(f"/api/v1/datasets/{dataset_id}/export", json={})
    assert exported.status_code == 200
