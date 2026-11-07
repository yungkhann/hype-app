"""Ingestion: staging, detection, import, limits, and file safety."""

from __future__ import annotations

import hashlib
import io

import pandas as pd

from tests.conftest import SAMPLES, csv_bytes, import_frame, upload


def test_health_reports_limits(client):
    body = client.get("/api/v1/health").json()
    assert body["status"] == "ok"
    assert ".csv" in body["accepted_formats"] and ".xlsx" in body["accepted_formats"]
    assert body["limits"]["max_upload_mb"] == 5


def test_stage_detects_semicolon_cp1251_and_previews_without_importing(client):
    frame = pd.DataFrame({"город": ["Алматы", "Астана", "Шымкент"] * 10, "сумма": range(30)})
    content = csv_bytes(frame, encoding="cp1251", sep=";")
    staged = upload(client, content, "регион.csv").json()
    detected = staged["dataset"]["detected"]
    assert detected["delimiter"] == ";"
    assert detected["encoding"].replace("_", "").lower() in {"cp1251", "windows1251"}
    assert staged["columns"] == ["город", "сумма"]
    assert staged["rows"][0][0] == "Алматы"
    assert staged["dataset"]["status"] == "staged"
    # Nothing is parsed into the workspace until import.
    dataset_id = staged["dataset"]["id"]
    assert client.get(f"/api/v1/datasets/{dataset_id}/preview").status_code == 404


def test_import_parses_iso_dates_and_discloses_it(client):
    frame = pd.DataFrame({"day": pd.date_range("2025-01-01", periods=40).strftime("%Y-%m-%d"),
                          "value": range(40)})
    dataset_id = import_frame(client, frame)
    detail = client.get(f"/api/v1/datasets/{dataset_id}").json()
    kinds = {c["name"]: c["kind"] for c in detail["columns"]}
    assert kinds == {"day": "datetime", "value": "numeric"}
    assert any("'day' parsed as datetime" in note for note in detail["notes"])
    assert detail["n_rows"] == 40 and detail["status"] == "ready"


def test_original_file_is_preserved_byte_for_byte(client):
    content = csv_bytes(pd.DataFrame({"a": [1, 2, 3], "b": ["x", "y", "z"]}))
    staged = upload(client, content).json()
    dataset_id = staged["dataset"]["id"]
    client.post(f"/api/v1/datasets/{dataset_id}/import")
    original = client.get(f"/api/v1/datasets/{dataset_id}/download", params={"format": "original"})
    assert original.content == content
    assert staged["dataset"]["original"]["sha256"] == hashlib.sha256(content).hexdigest()


def test_excel_sheet_selection(client):
    content = (SAMPLES / "accounts_messy.xlsx").read_bytes()
    staged = upload(client, content, "accounts.xlsx").json()
    assert staged["dataset"]["detected"]["sheets"] == ["notes", "accounts"]
    assert staged["columns"] == ["note"]  # first sheet by default
    dataset_id = staged["dataset"]["id"]
    preview = client.post(f"/api/v1/datasets/{dataset_id}/stage-preview", json={"sheet": "accounts"}).json()
    assert "account_no" in preview["columns"]
    detail = client.post(f"/api/v1/datasets/{dataset_id}/import", json={"sheet": "accounts"}).json()
    assert detail["n_rows"] == 2_460
    missing = client.post(f"/api/v1/datasets/{dataset_id}/stage-preview", json={"sheet": "nope"}).json()
    assert any("does not exist" in w for w in missing["warnings"])


def test_parquet_import(client):
    content = (SAMPLES / "branches.parquet").read_bytes()
    staged = upload(client, content, "branches.parquet").json()
    detail = client.post(f"/api/v1/datasets/{staged['dataset']['id']}/import").json()
    assert detail["n_rows"] == 420
    assert {c["name"]: c["kind"] for c in detail["columns"]}["opened"] == "datetime"


def test_rejects_unsupported_and_mismatched_files(client):
    response = upload(client, b"MZ\x90\x00", "tool.exe")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "unsupported_format"
    fake_excel = upload(client, b"a,b\n1,2\n", "fake.xlsx")
    assert fake_excel.status_code == 422
    assert fake_excel.json()["error"]["code"] == "format_mismatch"
    empty = upload(client, b"", "empty.csv")
    assert empty.status_code == 422 and empty.json()["error"]["code"] == "empty_file"


def test_upload_size_limit(client):
    big = b"a,b\n" + b"1234567890,1234567890\n" * 300_000  # ~6.6 MB > 5 MB limit
    response = upload(client, big, "big.csv")
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "payload_too_large"


def test_filename_is_sanitized_and_ids_are_validated(client, settings):
    staged = upload(client, b"a\n1\n2\n", "../../../etc/passwd.csv").json()
    assert staged["dataset"]["original"]["filename"] == "passwd.csv"
    files = list(settings.data_dir.rglob("*"))
    assert all(settings.data_dir in f.parents for f in files)
    assert client.get("/api/v1/datasets/..%2F..%2Fetc").status_code in {404, 422}
    assert client.get("/api/v1/datasets/" + "f" * 32).status_code == 404
    assert client.post("/api/v1/datasets/samples/..%2F..%2Fpyproject.toml").status_code == 404


def test_list_rename_replace_delete(client):
    dataset_id = import_frame(client, pd.DataFrame({"a": [1, 2, 3]}), name="first")
    assert [d["name"] for d in client.get("/api/v1/datasets").json()] == ["first"]
    assert client.patch(f"/api/v1/datasets/{dataset_id}", json={"name": "renamed"}).json()["name"] == "renamed"

    replacement = csv_bytes(pd.DataFrame({"a": [1, 2], "b": [3, 4]}))
    staged = client.post(f"/api/v1/datasets/{dataset_id}/replace",
                         files={"file": ("v2.csv", replacement, "text/csv")}).json()
    assert staged["dataset"]["id"] == dataset_id and staged["dataset"]["name"] == "renamed"
    detail = client.post(f"/api/v1/datasets/{dataset_id}/import").json()
    assert detail["n_cols"] == 2

    assert client.delete(f"/api/v1/datasets/{dataset_id}").json()["deleted"] is True
    assert client.get(f"/api/v1/datasets/{dataset_id}").status_code == 404


def test_download_processed_csv_round_trips(client):
    frame = pd.DataFrame({"name": ["Алия", "Бек"], "amount": [1.5, 2.0]})
    dataset_id = import_frame(client, frame)
    response = client.get(f"/api/v1/datasets/{dataset_id}/download")
    assert response.headers["content-type"].startswith("text/csv")
    restored = pd.read_csv(io.BytesIO(response.content), encoding="utf-8-sig")
    pd.testing.assert_frame_equal(restored, frame)


def test_samples_are_listed_and_labeled_synthetic(client):
    samples = {s["filename"] for s in client.get("/api/v1/datasets/samples").json()}
    assert {"customers_churn.csv", "credit_limits.csv", "transactions.csv", "accounts_messy.xlsx",
            "branches.parquet"} <= samples
    detail = client.post("/api/v1/datasets/samples/credit_limits.csv").json()
    assert detail["is_synthetic"] is True and detail["name"].endswith("(synthetic)")
    assert detail["n_cols"] == 9  # semicolon delimiter detected


def test_replace_keeps_previous_version_until_confirmed(client, settings):
    original = csv_bytes(pd.DataFrame({"a": [1, 2, 3]}))
    staged = upload(client, original, "v1.csv").json()
    dataset_id = staged["dataset"]["id"]
    client.post(f"/api/v1/datasets/{dataset_id}/import")

    replacement = csv_bytes(pd.DataFrame({"a": [9], "b": [8]}))
    pending = client.post(f"/api/v1/datasets/{dataset_id}/replace",
                          files={"file": ("v2.csv", replacement, "text/csv")}).json()
    assert pending["dataset"]["replacing"] is True and pending["dataset"]["status"] == "staged"
    assert (settings.data_dir / "datasets" / dataset_id / "previous" / "data.parquet").exists()

    restored = client.post(f"/api/v1/datasets/{dataset_id}/replace/cancel").json()
    assert restored["status"] == "ready" and restored["n_rows"] == 3 and restored["replacing"] is False
    download = client.get(f"/api/v1/datasets/{dataset_id}/download", params={"format": "original"})
    assert download.content == original
    assert client.post(f"/api/v1/datasets/{dataset_id}/replace/cancel").status_code == 409

    client.post(f"/api/v1/datasets/{dataset_id}/replace", files={"file": ("v2.csv", replacement, "text/csv")})
    confirmed = client.post(f"/api/v1/datasets/{dataset_id}/import").json()
    assert confirmed["n_rows"] == 1 and confirmed["n_cols"] == 2
    assert not (settings.data_dir / "datasets" / dataset_id / "previous").exists()
