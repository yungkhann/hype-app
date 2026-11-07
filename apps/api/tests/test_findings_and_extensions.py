"""Findings, pitch deck, saved views, the analysis registry, and the challenge module."""

from __future__ import annotations

import pandas as pd
import pytest

from tests.conftest import import_frame, load_sample


def test_finding_lifecycle_with_chart_snapshot(client):
    dataset_id = load_sample(client, "customers_churn.csv")
    chart = client.post(f"/api/v1/datasets/{dataset_id}/visualize", json={"type": "bar", "x": "segment"}).json()
    created = client.post("/api/v1/findings", json={
        "title": "Retail dominates the base", "chart": chart, "dataset_id": dataset_id,
        "evidence": [{"label": "Retail share", "value": "70%"}], "limitations": "Synthetic data."}).json()
    assert created["chart"]["meta"]["n_rows_used"] == 6_000
    second = client.post("/api/v1/findings", json={"title": "Second"}).json()

    updated = client.patch(f"/api/v1/findings/{created['id']}", json={"interpretation": "Descriptive only."}).json()
    assert updated["interpretation"] == "Descriptive only." and updated["title"] == "Retail dominates the base"

    order = client.put("/api/v1/findings/order", json={"ids": [second["id"], created["id"]]}).json()
    assert [f["id"] for f in order] == [second["id"], created["id"]]
    assert client.put("/api/v1/findings/order", json={"ids": [second["id"]]}).status_code == 422

    markdown = client.get("/api/v1/findings/export.md").text
    assert "## 2. Retail dominates the base" in markdown and "n = 6,000 of 6,000 rows" in markdown

    # Charts survive dataset deletion because findings store a snapshot.
    client.delete(f"/api/v1/datasets/{dataset_id}")
    assert client.get(f"/api/v1/findings/{created['id']}").json()["chart"]["rows"]


def test_pitch_defaults_and_finding_references(client):
    deck = client.get("/api/v1/pitch").json()
    assert [s["section"] for s in deck["slides"]] == ["title", "problem", "observations", "solution",
                                                       "methodology", "results", "impact"]
    finding = client.post("/api/v1/findings", json={"title": "F"}).json()
    deck["slides"][2]["finding_ids"] = [finding["id"], "0" * 32]
    saved = client.put("/api/v1/pitch", json=deck).json()
    assert saved["slides"][2]["finding_ids"] == [finding["id"]]  # unknown ids dropped
    client.delete(f"/api/v1/findings/{finding['id']}")
    assert client.get("/api/v1/pitch").json()["slides"][2]["finding_ids"] == []


def test_saved_views(client):
    view = client.post("/api/v1/views", json={"name": "By city", "dataset_id": "a" * 32, "kind": "chart",
                                              "spec": {"type": "bar", "x": "city"}}).json()
    assert client.get("/api/v1/views", params={"dataset_id": "a" * 32}).json()[0]["id"] == view["id"]
    client.delete(f"/api/v1/views/{view['id']}")
    assert client.get("/api/v1/views").json() == []


def test_registry_lists_schemas_with_column_widgets(client):
    analyses = {a["id"]: a for a in client.get("/api/v1/analyses").json()}
    assert {"value_concentration", "group_comparison", "association_ranking", "kmeans_segments",
            "anomaly_scores", "time_trend"} <= set(analyses)
    group = analyses["value_concentration"]["params_schema"]["properties"]["group"]
    assert group["x-widget"] == "column"


def test_value_concentration_matches_hand_calculation(client):
    frame = pd.DataFrame({"merchant": ["a"] * 6 + ["b"] * 3 + ["c"], "amount": [10.0] * 10})
    dataset_id = import_frame(client, frame)
    result = client.post(f"/api/v1/datasets/{dataset_id}/analyses/value_concentration",
                         json={"params": {"group": "merchant", "value": "amount", "threshold": 0.8}}).json()
    summary = {s["label"]: s["value"] for s in result["summary"]}
    assert summary["Groups"] == "3"
    assert summary["Groups making 80%"] == "2"  # 60% + 30% = 90% ≥ 80%
    assert summary["Top group share"] == "60.0%"
    # Gini of (10, 30, 60) = (2*1-4)*10 + (2*2-4)*30 + (2*3-4)*60 / (3*100) = 100/300
    assert summary["Gini coefficient"] == "0.333"
    assert result["table"]["rows"][0][:2] == ["a", 60.0]


@pytest.mark.parametrize("analysis_id,params", [
    ("group_comparison", {"metric": "approved_limit_kzt", "group": "education"}),
    ("association_ranking", {"target": "approved_limit_kzt"}),
    ("kmeans_segments", {"features": ["monthly_income_kzt", "credit_score"], "k": 3}),
    ("anomaly_scores", {"features": ["monthly_income_kzt", "approved_limit_kzt"]}),
])
def test_builtin_analyses_run(client, analysis_id, params):
    dataset_id = load_sample(client, "credit_limits.csv")
    response = client.post(f"/api/v1/datasets/{dataset_id}/analyses/{analysis_id}", json={"params": params})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["summary"] and body["meta"]["n_rows_used"] == 5_000


def test_time_trend_and_invalid_params(client):
    dataset_id = load_sample(client, "transactions.csv")
    trend = client.post(f"/api/v1/datasets/{dataset_id}/analyses/time_trend",
                        json={"params": {"date": "timestamp", "value": "amount_kzt", "period": "quarter"}}).json()
    assert len(trend["table"]["rows"]) == 8  # 2024-10-01 … 2026-09-30 spans Q4-2024 to Q3-2026
    wrong = client.post(f"/api/v1/datasets/{dataset_id}/analyses/time_trend", json={"params": {"date": "city"}})
    assert wrong.status_code == 422
    missing = client.post(f"/api/v1/datasets/{dataset_id}/analyses/nope", json={"params": {}})
    assert missing.status_code == 404


def test_challenge_module_exposes_template(client):
    info = client.get("/api/v1/challenge/info").json()
    assert info["status"] == "awaiting case"
    assert [a["id"] for a in info["analyses"]] == ["challenge_template_segment_kpis"]
