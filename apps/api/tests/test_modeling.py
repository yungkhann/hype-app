"""Model Lab: honest evaluation against a baseline, leakage warnings, and split correctness."""

from __future__ import annotations

import io

import numpy as np
import pandas as pd
import pytest

from app.services.modeling.pipelines import CATBOOST_AVAILABLE
from tests.conftest import import_frame, load_sample, wait_for


def _run(client, **request):
    response = client.post("/api/v1/experiments", json=request)
    assert response.status_code == 202, response.text
    return wait_for(client, response.json()["id"])


def test_check_suggests_task_and_drops_identifiers(client):
    dataset_id = load_sample(client, "customers_churn.csv")
    body = client.post("/api/v1/experiments/check", json={"dataset_id": dataset_id, "target": "churned"}).json()
    assert body["suggested_task"] == "classification" and body["n_classes"] == 2
    assert {"column": "customer_id", "reason": "looks like an identifier"} in body["dropped_features"]
    assert "customer_id" not in body["usable_features"]
    assert body["can_train"] is True


def test_classification_beats_dummy_baseline(client):
    dataset_id = load_sample(client, "customers_churn.csv")
    record = _run(client, dataset_id=dataset_id, target="churned", task="classification",
                  model="logistic_regression", split={"strategy": "stratified", "test_size": 0.25})
    assert record["status"] == "completed", record.get("error")
    assert record["split_info"]["n_test"] == 1_500 and record["split_info"]["n_train"] == 4_500
    assert record["primary_metric"]["name"] == "roc_auc"
    assert record["baseline_metrics"]["roc_auc"] == pytest.approx(0.5)
    assert record["metrics"]["roc_auc"] > 0.7
    assert sum(sum(row) for row in record["confusion"]["matrix"]) == 1_500
    assert record["positive_label"] == "1"  # minority class
    assert record["feature_importance"]

    predictions = client.get(f"/api/v1/experiments/{record['id']}/predictions.csv")
    frame = pd.read_csv(io.BytesIO(predictions.content), encoding="utf-8-sig")
    assert len(frame) == 1_500 and {"row_index", "actual", "predicted", "proba_1"} <= set(frame.columns)
    metrics = client.get(f"/api/v1/experiments/{record['id']}/metrics.json").json()
    assert metrics["metrics"]["roc_auc"] == record["metrics"]["roc_auc"]


def test_regression_random_forest_and_residuals(client):
    dataset_id = load_sample(client, "credit_limits.csv")
    record = _run(client, dataset_id=dataset_id, target="approved_limit_kzt", task="regression",
                  model="random_forest", exclude=["application_id"], params={"n_estimators": 60})
    assert record["status"] == "completed", record.get("error")
    assert record["metrics"]["r2"] > 0.7
    assert abs(record["baseline_metrics"]["r2"]) < 0.02  # mean predictor
    assert record["metrics"]["rmse"] < record["baseline_metrics"]["rmse"]
    assert record["primary_metric"] == {"name": "rmse", "value": record["metrics"]["rmse"],
                                        "higher_is_better": False}
    assert len(record["pred_vs_actual"]) == 1_000
    assert sum(record["residual_histogram"]["counts"]) == 1_000


def test_chronological_split_keeps_test_after_train(client):
    rng = np.random.default_rng(3)
    n = 400
    frame = pd.DataFrame({"when": pd.date_range("2024-01-01", periods=n).strftime("%Y-%m-%d"),
                          "x": rng.normal(size=n)})
    frame["y"] = 3 * frame["x"] + rng.normal(size=n)
    dataset_id = import_frame(client, frame)
    record = _run(client, dataset_id=dataset_id, target="y", task="regression", model="linear_regression",
                  split={"strategy": "chronological", "time_column": "when", "test_size": 0.25})
    info = record["split_info"]
    assert info["train_period"][1] < info["test_period"][0]
    assert info["n_test"] == 100


def test_leakage_is_flagged_not_hidden(client):
    rng = np.random.default_rng(4)
    target = rng.normal(size=300)
    frame = pd.DataFrame({"target_copy": target * 2 + 1, "noise": rng.normal(size=300), "y": target})
    dataset_id = import_frame(client, frame)
    body = client.post("/api/v1/experiments/check", json={"dataset_id": dataset_id, "target": "y",
                                                           "task": "regression"}).json()
    leak = [w for w in body["warnings"] if w["code"] == "leakage_correlation"]
    assert leak and leak[0]["column"] == "target_copy" and leak[0]["severity"] == "critical"
    assert body["can_train"] is True  # warned, not silently dropped


def test_untrainable_setups_are_rejected_with_reasons(client):
    frame = pd.DataFrame({"y": ["only"] * 50, "x": range(50)})
    dataset_id = import_frame(client, frame)
    response = client.post("/api/v1/experiments", json={"dataset_id": dataset_id, "target": "y",
                                                        "task": "classification", "model": "random_forest"})
    assert response.status_code == 422
    assert "fewer than two classes" in response.json()["error"]["message"]
    bad_param = client.post("/api/v1/experiments", json={"dataset_id": dataset_id, "target": "x",
                                                         "task": "regression", "model": "ridge",
                                                         "params": {"evil": 1}})
    assert bad_param.status_code == 422 and bad_param.json()["error"]["code"] == "invalid_param"
    mismatch = client.post("/api/v1/experiments", json={"dataset_id": dataset_id, "target": "x",
                                                        "task": "regression", "model": "logistic_regression"})
    assert mismatch.status_code == 422 and mismatch.json()["error"]["code"] == "model_task_mismatch"
    no_features = client.post("/api/v1/experiments", json={"dataset_id": dataset_id, "target": "x",
                                                           "task": "regression", "model": "ridge"})
    assert no_features.status_code == 422 and "No usable feature" in no_features.json()["error"]["message"]


def test_experiment_list_and_delete(client):
    dataset_id = load_sample(client, "credit_limits.csv")
    record = _run(client, dataset_id=dataset_id, target="approved_limit_kzt", task="regression", model="dummy")
    listed = client.get("/api/v1/experiments", params={"dataset_id": dataset_id}).json()
    assert [e["id"] for e in listed] == [record["id"]]
    assert client.delete(f"/api/v1/experiments/{record['id']}").json()["deleted"] is True
    assert client.get(f"/api/v1/experiments/{record['id']}").status_code == 404


@pytest.mark.skipif(not CATBOOST_AVAILABLE, reason="CatBoost not installed")
def test_catboost_classification(client):
    dataset_id = load_sample(client, "customers_churn.csv")
    record = _run(client, dataset_id=dataset_id, target="churned", task="classification", model="catboost",
                  params={"iterations": 80})
    assert record["status"] == "completed", record.get("error")
    assert record["metrics"]["roc_auc"] > record["baseline_metrics"]["roc_auc"]
    assert record["importance_method"] == "CatBoost prediction-value change"
