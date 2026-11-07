"""Profiling facts vs heuristics, queries, aggregation, and chart construction."""

from __future__ import annotations

import numpy as np
import pandas as pd

from tests.conftest import import_frame, load_sample


def _quality(profile: dict) -> dict[tuple[str, str | None], dict]:
    return {(q["code"], q["column"]): q for q in profile["quality"]}


def test_profile_overview_counts_are_exact(client):
    frame = pd.DataFrame({"a": [1, 2, 2, np.nan, 5], "b": ["x", "y", "y", "z", None]})
    dataset_id = import_frame(client, frame)
    overview = client.get(f"/api/v1/datasets/{dataset_id}/profile").json()["overview"]
    assert overview["n_rows"] == 5 and overview["n_cols"] == 2
    assert overview["duplicate_rows"] == 1  # row 3 repeats row 2
    assert overview["missing_cells"] == 2
    assert overview["missing_pct"] == 20.0


def test_profile_separates_detected_facts_from_heuristics(client):
    dataset_id = load_sample(client, "accounts_messy.xlsx")
    # Default sheet is "notes"; re-import the data sheet.
    client.post(f"/api/v1/datasets/{dataset_id}/import", json={"sheet": "accounts"})
    profile = client.post(f"/api/v1/datasets/{dataset_id}/profile/refresh").json()
    quality = _quality(profile)
    assert quality[("duplicate_rows", None)]["basis"] == "detected"
    assert quality[("constant", "source_system")]["basis"] == "detected"
    assert quality[("inconsistent_spelling", "city")]["basis"] == "heuristic"
    assert quality[("potential_date", "opened_on")]["basis"] == "heuristic"
    assert quality[("numeric_as_text", "balance_text")]["basis"] == "heuristic"
    assert quality[("suspected_identifier", "account_no")]["basis"] == "heuristic"
    turnover = next(c for c in profile["columns"] if c["name"] == "monthly_turnover")
    assert turnover["kind"] == "numeric" and turnover["histogram"]["counts"]
    assert turnover["numeric"]["median"] is not None


def test_profile_outliers_and_correlation(client):
    rng = np.random.default_rng(0)
    x = rng.normal(0, 1, 500)
    frame = pd.DataFrame({"x": np.append(x, [40.0]), "y": np.append(2 * x + rng.normal(0, 0.1, 500), [80.0])})
    dataset_id = import_frame(client, frame)
    profile = client.get(f"/api/v1/datasets/{dataset_id}/profile").json()
    assert ("potential_outliers", "x") in _quality(profile)
    corr = profile["correlation"]
    assert corr["columns"] == ["x", "y"] and corr["matrix"][0][1] > 0.95


def test_query_filters_search_sort_and_page(client):
    frame = pd.DataFrame({"city": ["Almaty", "Astana", "Almaty", "Aktobe"] * 25,
                          "amount": np.arange(100, dtype=float)})
    dataset_id = import_frame(client, frame)
    body = client.post(f"/api/v1/datasets/{dataset_id}/query", json={
        "filters": [{"column": "city", "op": "in", "value": ["Almaty"]},
                    {"column": "amount", "op": "between", "value": [10, 60]}],
        "sort": [{"column": "amount", "desc": True}], "limit": 5}).json()
    assert body["total_rows"] == 100
    assert body["filtered_rows"] == 26  # Almaty sits at every even index; even amounts 10..60
    assert [r[1] for r in body["rows"]] == [60.0, 58.0, 56.0, 54.0, 52.0]
    search = client.post(f"/api/v1/datasets/{dataset_id}/query", json={"search": "akto"}).json()
    assert search["filtered_rows"] == 25
    too_big = client.post(f"/api/v1/datasets/{dataset_id}/query", json={"limit": 501})
    assert too_big.status_code == 422
    bad = client.post(f"/api/v1/datasets/{dataset_id}/query",
                      json={"filters": [{"column": "city", "op": "gt", "value": 3}]})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "invalid_filter_op"


def test_aggregate_group_by(client):
    frame = pd.DataFrame({"g": ["a", "a", "b"], "v": [1.0, 3.0, 10.0]})
    dataset_id = import_frame(client, frame)
    body = client.post(f"/api/v1/datasets/{dataset_id}/aggregate", json={
        "group_by": ["g"], "metrics": [{"agg": "count"}, {"column": "v", "agg": "mean"}],
        "sort": {"column": "g"}}).json()
    assert body["columns"] == ["g", "count", "mean_v"]
    assert body["rows"] == [["a", 2, 2.0], ["b", 1, 10.0]]
    assert body["meta"]["aggregation"] == "count(rows), mean(v) by g"


def test_filtered_export_returns_every_matching_row(client):
    frame = pd.DataFrame({"g": ["a", "b"] * 600, "v": range(1200)})
    dataset_id = import_frame(client, frame)
    response = client.post(f"/api/v1/datasets/{dataset_id}/export",
                           json={"filters": [{"column": "g", "op": "eq", "value": "a"}], "limit": 10})
    lines = response.content.decode("utf-8-sig").strip().splitlines()
    assert len(lines) == 601  # header + all 600 matches, paging ignored


class TestCharts:
    def _chart(self, client, dataset_id, **spec):
        return client.post(f"/api/v1/datasets/{dataset_id}/visualize", json=spec)

    def test_bar_with_group_and_top_n(self, client):
        dataset_id = load_sample(client, "customers_churn.csv")
        body = self._chart(client, dataset_id, type="bar", x="city", y="balance_kzt", agg="mean",
                           group="segment").json()
        assert len(body["rows"]) == 6 and set(body["series"]) == {"retail", "premium", "business"}
        assert body["meta"]["n_rows_used"] == 6_000
        assert body["meta"]["aggregation"] == "mean of balance_kzt by city and segment"

    def test_line_buckets_time_and_discloses(self, client):
        dataset_id = load_sample(client, "transactions.csv")
        body = self._chart(client, dataset_id, type="line", x="timestamp", y="amount_kzt", agg="sum",
                           time_bucket="month").json()
        assert 24 <= len(body["rows"]) <= 25
        assert any("grouped by month" in n for n in body["meta"]["notes"])

    def test_scatter_samples_and_discloses(self, client):
        dataset_id = load_sample(client, "credit_limits.csv")
        body = self._chart(client, dataset_id, type="scatter", x="monthly_income_kzt",
                           y="approved_limit_kzt").json()
        assert len(body["rows"]) == 500  # settings.max_chart_points
        assert body["meta"]["sampled"] is True and body["meta"]["sample_size"] == 500

    def test_histogram_box_heatmap(self, client):
        dataset_id = load_sample(client, "credit_limits.csv")
        hist = self._chart(client, dataset_id, type="histogram", x="credit_score", bins=20).json()
        assert sum(r["count"] for r in hist["rows"]) == 5_000
        box = self._chart(client, dataset_id, type="box", x="education", y="approved_limit_kzt").json()
        assert {b["group"] for b in box["box"]} == {"secondary", "vocational", "bachelor", "master"}
        assert all(b["q1"] <= b["median"] <= b["q3"] for b in box["box"])
        corr = self._chart(client, dataset_id, type="heatmap").json()
        assert corr["heatmap"]["value_label"] == "Pearson r"
        cross = self._chart(client, dataset_id, type="heatmap", x="city", y="education").json()
        assert sum(v for row in cross["heatmap"]["values"] for v in row if v) == 5_000

    def test_invalid_combinations_explain_themselves(self, client):
        dataset_id = load_sample(client, "customers_churn.csv")
        scatter = self._chart(client, dataset_id, type="scatter", x="city", y="age")
        assert scatter.status_code == 422 and "numeric or date X" in scatter.json()["error"]["message"]
        hist = self._chart(client, dataset_id, type="histogram", x="segment")
        assert hist.status_code == 422 and "bar chart" in hist.json()["error"]["message"]
        mean_of_text = self._chart(client, dataset_id, type="bar", x="city", y="segment", agg="mean")
        assert mean_of_text.status_code == 422
        unknown = self._chart(client, dataset_id, type="bar", x="nope")
        assert unknown.status_code == 422 and unknown.json()["error"]["code"] == "unknown_column"

    def test_filters_flow_into_provenance(self, client):
        dataset_id = load_sample(client, "customers_churn.csv")
        body = self._chart(client, dataset_id, type="bar", x="segment",
                           filters=[{"column": "city", "op": "eq", "value": "Almaty"}]).json()
        assert body["meta"]["n_rows_used"] < body["meta"]["n_rows_total"]
        assert sum(r["value"] for r in body["rows"]) == body["meta"]["n_rows_used"]
        assert body["meta"]["filters"][0]["column"] == "city"


def test_date_heuristic_ignores_codes_that_pandas_happens_to_parse():
    """Regression: 'T0000045' parses as 2045-01-01 under format='mixed'; it must not be called a date."""
    from app.services.profiling.profiler import _date_like_share

    codes = pd.Series([f"T{i:07d}" for i in range(200)])
    assert _date_like_share(codes) == 0.0
    assert _date_like_share(pd.Series([str(20240000 + i) for i in range(200)])) == 0.0  # bare digit runs

    dotted = pd.Series([f"{(i % 28) + 1:02d}.03.2026" for i in range(200)])
    iso = pd.Series([f"2026-03-{(i % 28) + 1:02d}T10:15:00" for i in range(200)])
    named = pd.Series([f"{(i % 28) + 1} March 2026" for i in range(200)])
    assert _date_like_share(dotted) >= 0.9
    assert _date_like_share(iso) >= 0.9
    assert _date_like_share(named) >= 0.9
