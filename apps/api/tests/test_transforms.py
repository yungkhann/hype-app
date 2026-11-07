"""Preparation recipes: reproducibility, no silent changes, and train-only fitting."""

from __future__ import annotations

import numpy as np
import pandas as pd

from tests.conftest import import_frame


def _transform(client, dataset_id, steps, **extra):
    return client.post(f"/api/v1/datasets/{dataset_id}/transform", json={"steps": steps, **extra})


def test_preview_creates_nothing_and_original_is_untouched(client):
    dataset_id = import_frame(client, pd.DataFrame({"a": [1.0, None, 3.0], "b": ["x", "y", "x"]}))
    body = _transform(client, dataset_id, [{"op": "fill_missing", "columns": ["a"], "strategy": "mean"}],
                      preview=True).json()
    assert body["preview"] is True and body["dataset_id"] is None
    assert body["rows"][1][0] == 2.0
    assert len(client.get("/api/v1/datasets").json()) == 1
    original = client.get(f"/api/v1/datasets/{dataset_id}/preview").json()
    assert original["rows"][1][0] is None


def test_saved_recipe_creates_derived_dataset_with_lineage(client):
    dataset_id = import_frame(client, pd.DataFrame({"a": [1, 1, 2], "b": ["x", "x", "y"]}), name="raw")
    body = _transform(client, dataset_id, [{"op": "drop_duplicates"}], name="deduped").json()
    derived = client.get(f"/api/v1/datasets/{body['dataset_id']}").json()
    assert derived["name"] == "deduped" and derived["n_rows"] == 2
    assert derived["source"] == "transform"
    assert derived["lineage"]["parent_id"] == dataset_id
    assert derived["lineage"]["log"][0]["description"].startswith("Removed 1 duplicate row")


def test_split_makes_fitted_steps_learn_from_train_only(client):
    rng = np.random.default_rng(1)
    values = rng.normal(100, 30, 400)
    values[rng.random(400) < 0.2] = np.nan
    frame = pd.DataFrame({"v": values, "t": pd.date_range("2025-01-01", periods=400).strftime("%Y-%m-%d")})
    dataset_id = import_frame(client, frame)
    body = _transform(client, dataset_id,
                      [{"op": "fill_missing", "columns": ["v"], "strategy": "median"},
                       {"op": "scale", "columns": ["v"], "method": "standard"}],
                      split={"strategy": "chronological", "time_column": "t", "test_size": 0.25},
                      preview=True).json()
    split_log, fill_log, scale_log = body["log"]
    assert split_log["op"] == "split" and "300 train / 100 validation" in split_log["description"]
    train = frame.iloc[:300]["v"]
    assert fill_log["fit_scope"] == "train_only"
    assert float(fill_log["fitted"]["v"]) == round(float(train.median()), 6) or \
        abs(float(fill_log["fitted"]["v"]) - train.median()) < 1e-6
    assert abs(float(fill_log["fitted"]["v"]) - frame["v"].median()) > 1e-9  # not the all-rows median
    assert scale_log["fit_scope"] == "train_only"
    assert not body["warnings"]  # nothing fitted on all rows


def test_fitting_without_split_is_flagged(client):
    dataset_id = import_frame(client, pd.DataFrame({"v": [1.0, 2.0, 3.0, 4.0]}))
    body = _transform(client, dataset_id, [{"op": "scale", "columns": ["v"]}], preview=True).json()
    assert body["log"][0]["fit_scope"] == "all_rows"
    assert any("learned its parameters from all rows" in w for w in body["warnings"])


def test_cast_and_parse_dates_report_failures(client):
    frame = pd.DataFrame({"amount": ["1 234,50", "2,5", "abc", "1,000.25"],
                          "opened": ["31.12.2024", "01.02.2025", "bad", "15.06.2025"]})
    dataset_id = import_frame(client, frame)
    body = _transform(client, dataset_id, [
        {"op": "cast", "columns": ["amount"], "to": "numeric"},
        {"op": "parse_dates", "columns": ["opened"], "format": "%d.%m.%Y"},
    ], preview=True).json()
    rows = body["rows"]
    assert [r[0] for r in rows] == [1234.5, 2.5, None, 1000.25]
    assert rows[0][1].startswith("2024-12-31") and rows[2][1] is None
    assert any("could not be cast to numeric" in w for w in body["warnings"])
    assert any("Unparseable dates" in w for w in body["warnings"])


def test_one_hot_derive_and_errors(client):
    frame = pd.DataFrame({"c": ["a", "b", "a"], "n": [2.0, 0.0, 4.0], "d": [1.0, 0.0, 2.0]})
    dataset_id = import_frame(client, frame)
    body = _transform(client, dataset_id, [
        {"op": "one_hot", "columns": ["c"]},
        {"op": "derive_ratio", "numerator": "n", "denominator": "d", "new_column": "ratio"},
    ], preview=True).json()
    names = [c["name"] for c in body["columns"]]
    assert "c=a" in names and "c=b" in names and "c" not in names
    assert [r[names.index("ratio")] for r in body["rows"]] == [2.0, None, 2.0]
    bad = _transform(client, dataset_id, [{"op": "scale", "columns": ["c"]}], preview=True)
    assert bad.status_code == 422 and bad.json()["error"]["message"].startswith("Step 1 (scale)")
    everything = _transform(client, dataset_id, [{"op": "drop_columns", "columns": ["c", "n", "d"]}],
                            preview=True)
    assert everything.status_code == 422
