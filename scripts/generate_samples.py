"""Generate the synthetic practice datasets in data/samples/.

Every file is SYNTHETIC: produced from a fixed random seed by the formulas below. None of it is
sponsor or customer data, and no pattern in it is a real-world finding.

    apps/api/.venv/bin/python scripts/generate_samples.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "samples"
RNG = np.random.default_rng(20261107)
CITIES = ["Almaty", "Astana", "Shymkent", "Karaganda", "Aktobe", "Pavlodar"]
CITY_P = [0.32, 0.26, 0.14, 0.11, 0.09, 0.08]


def sigmoid(x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-x))


def customers(n: int = 6_000) -> pd.DataFrame:
    """Classification: whether a synthetic customer churned."""
    tenure = RNG.integers(1, 96, n)
    products = RNG.choice([1, 2, 3, 4], n, p=[0.45, 0.32, 0.17, 0.06])
    app = RNG.random(n) < 0.68
    calls = RNG.poisson(1.4, n)
    last_login = np.round(RNG.exponential(12, n)).astype(int)
    segment = RNG.choice(["retail", "premium", "business"], n, p=[0.7, 0.2, 0.1])
    fee = np.round(np.where(segment == "premium", 4_900, np.where(segment == "business", 9_900, 990))
                   * RNG.uniform(0.9, 1.1, n), -1)
    age = RNG.normal(38, 11, n).clip(18, 80).round()
    balance = np.round(RNG.lognormal(12.3, 1.1, n), -2)
    logit = (-1.2 - 0.025 * tenure - 0.45 * (products - 1) - 0.7 * app + 0.35 * calls
             + 0.045 * last_login - 0.25 * (segment == "premium") + RNG.normal(0, 0.6, n))
    churned = (RNG.random(n) < sigmoid(logit)).astype(int)
    signup = pd.Timestamp("2026-10-01") - pd.to_timedelta(tenure * 30 + RNG.integers(0, 30, n), unit="D")
    frame = pd.DataFrame({
        "customer_id": [f"C{100000 + i}" for i in range(n)],
        "signup_date": signup.strftime("%Y-%m-%d"),
        "city": RNG.choice(CITIES, n, p=CITY_P),
        "segment": segment, "age": age, "tenure_months": tenure, "monthly_fee_kzt": fee,
        "num_products": products, "has_mobile_app": app, "support_calls_90d": calls,
        "days_since_login": last_login, "balance_kzt": balance, "churned": churned,
    })
    frame.loc[RNG.random(n) < 0.04, "age"] = np.nan
    frame.loc[RNG.random(n) < 0.02, "balance_kzt"] = np.nan
    return frame


def credit_limits(n: int = 5_000) -> pd.DataFrame:
    """Regression: an approved credit limit set by a synthetic scoring formula plus noise."""
    income = np.round(RNG.lognormal(13.1, 0.55, n), -3)
    age = RNG.integers(21, 66, n)
    employment = np.clip(RNG.normal((age - 21) * 0.45, 3), 0, None).round(1)
    score = np.clip(RNG.normal(640, 70, n), 350, 850).round()
    existing = RNG.poisson(0.9, n)
    education = RNG.choice(["secondary", "vocational", "bachelor", "master"], n, p=[0.2, 0.3, 0.38, 0.12])
    edu_bonus = pd.Series(education).map({"secondary": 0, "vocational": 0.04, "bachelor": 0.1,
                                          "master": 0.16}).to_numpy()
    limit = (income * (1.2 + 0.004 * (score - 600) + edu_bonus) * (1 - 0.08 * existing)
             + 9_000 * employment) * RNG.lognormal(0, 0.12, n)
    return pd.DataFrame({
        "application_id": np.arange(1, n + 1), "city": RNG.choice(CITIES, n, p=CITY_P),
        "age": age, "monthly_income_kzt": income, "employment_years": employment,
        "credit_score": score, "existing_loans": existing, "education": education,
        "approved_limit_kzt": np.round(np.clip(limit, 50_000, None), -3),
    })


def transactions(days: int = 730, per_day: float = 60) -> pd.DataFrame:
    """Time series: card/app/transfer transactions with weekly seasonality and growth."""
    dates = pd.date_range("2024-10-01", periods=days, freq="D")
    weekday_factor = np.array([0.95, 0.97, 1.0, 1.02, 1.15, 1.25, 0.86])
    counts = RNG.poisson(per_day * (1 + np.arange(days) / days * 0.6) * weekday_factor[dates.day_of_week])
    offsets = pd.to_timedelta(RNG.integers(0, 86_400, counts.sum()), unit="s")
    stamps = pd.DatetimeIndex(np.repeat(dates.to_numpy(), counts)) + offsets
    n = len(stamps)
    category = RNG.choice(["groceries", "transport", "restaurants", "electronics", "utilities", "travel"], n,
                          p=[0.34, 0.18, 0.17, 0.08, 0.15, 0.08])
    base = pd.Series(category).map({"groceries": 9.0, "transport": 7.6, "restaurants": 8.8, "electronics": 11.2,
                                    "utilities": 9.6, "travel": 11.6}).to_numpy()
    amount = np.round(RNG.lognormal(base, 0.7), 0)
    frame = pd.DataFrame({
        "transaction_id": [f"T{i:07d}" for i in range(n)],
        "timestamp": stamps.strftime("%Y-%m-%dT%H:%M:%S"),
        "customer_id": [f"C{100000 + i}" for i in RNG.integers(0, 6_000, n)],
        "city": RNG.choice(CITIES, n, p=CITY_P), "category": category,
        "channel": RNG.choice(["card", "app", "transfer"], n, p=[0.55, 0.35, 0.10]),
        "amount_kzt": amount,
    })
    frame["is_flagged"] = (amount > np.quantile(amount, 0.995)) & (RNG.random(n) < 0.5)
    return frame.sort_values("timestamp").reset_index(drop=True)


def messy_accounts(n: int = 2_400) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Mixed types with deliberate quality problems for profiling and preparation practice."""
    city = RNG.choice(CITIES, n, p=CITY_P).astype(object)
    variants = RNG.random(n)
    lower = variants < 0.05
    upper = (variants >= 0.05) & (variants < 0.08)
    city[lower] = [c.lower() for c in city[lower]]
    city[upper] = [c.upper() + " " for c in city[upper]]
    opened = pd.Timestamp("2015-01-01") + pd.to_timedelta(RNG.integers(0, 4_000, n), unit="D")
    balance = RNG.lognormal(12, 1.2, n)
    balance[RNG.random(n) < 0.01] *= 60  # extreme but plausible values
    frame = pd.DataFrame({
        "account_no": [f"KZ{v}" for v in RNG.integers(10**9, 10**10, n)],
        "opened_on": opened.strftime("%d.%m.%Y"),
        "city": city,
        "product": RNG.choice(np.array(["deposit", "card", "loan", "brokerage", None], dtype=object), n,
                              p=[0.3, 0.35, 0.2, 0.1, 0.05]),
        "balance_text": [f"{v:,.2f}".replace(",", " ").replace(".", ",") for v in balance],
        "risk_grade": RNG.choice(np.array(["A", "B", "C", "D", None], dtype=object), n,
                                 p=[0.3, 0.32, 0.2, 0.08, 0.1]),
        "monthly_turnover": np.round(RNG.gamma(2, 150_000, n), 2),
        "relationship_manager": RNG.choice(np.array(["Aigerim", "Daniyar", "Madina", "Yerlan", None], dtype=object),
                                           n, p=[0.25, 0.25, 0.2, 0.15, 0.15]),
        "source_system": "core-v2",
        "comment": RNG.choice(np.array(["", "VIP", "requested callback", "address change pending", None],
                                       dtype=object), n, p=[0.6, 0.05, 0.1, 0.05, 0.2]),
    })
    frame.loc[RNG.random(n) < 0.12, "monthly_turnover"] = np.nan
    frame = pd.concat([frame, frame.sample(60, random_state=1)], ignore_index=True)  # duplicate rows
    notes = pd.DataFrame({"note": ["Synthetic workbook for ATLAS practice.",
                                   "Sheet 'accounts' holds the data; this sheet tests sheet selection."]})
    return frame, notes


def branches(n: int = 420) -> pd.DataFrame:
    """Unlabeled operational data: no target, for business analytics without ML."""
    city = RNG.choice(CITIES, n, p=CITY_P)
    staff = RNG.integers(4, 40, n)
    visits = np.round(staff * RNG.normal(410, 80, n)).clip(300)
    wait = np.round(np.clip(RNG.normal(4 + visits / staff / 120, 2.5), 0.5, None), 1)
    satisfaction = np.round(np.clip(RNG.normal(4.6 - 0.12 * wait, 0.35), 1, 5), 2)
    return pd.DataFrame({
        "branch_id": [f"B{i:04d}" for i in range(n)], "city": city,
        "format": RNG.choice(["flagship", "standard", "express"], n, p=[0.1, 0.6, 0.3]),
        "opened": pd.Timestamp("2008-01-01") + pd.to_timedelta(RNG.integers(0, 6_500, n), unit="D"),
        "staff": staff, "monthly_visits": visits, "avg_wait_minutes": wait,
        "satisfaction_score": satisfaction,
        "digital_share": np.round(RNG.beta(4, 3, n), 3),
    })


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    customers().to_csv(OUT / "customers_churn.csv", index=False)
    credit_limits().to_csv(OUT / "credit_limits.csv", index=False, sep=";")
    transactions().to_csv(OUT / "transactions.csv", index=False)
    accounts, notes = messy_accounts()
    with pd.ExcelWriter(OUT / "accounts_messy.xlsx", engine="openpyxl") as writer:
        notes.to_excel(writer, sheet_name="notes", index=False)
        accounts.to_excel(writer, sheet_name="accounts", index=False)
    branches().to_parquet(OUT / "branches.parquet", index=False)
    catalog = [
        {"filename": "customers_churn.csv", "task": "classification",
         "description": "Synthetic customers with a binary churned target (6,000 rows)."},
        {"filename": "credit_limits.csv", "task": "regression",
         "description": "Synthetic credit applications with an approved limit to predict; semicolon-delimited."},
        {"filename": "transactions.csv", "task": "time series",
         "description": "Two years of synthetic daily transactions with weekly seasonality and growth."},
        {"filename": "accounts_messy.xlsx", "task": "data quality",
         "description": "Synthetic accounts with spelling variants, duplicates, text-encoded numbers and "
                        "dates, missing values. Two sheets."},
        {"filename": "branches.parquet", "task": "analytics (no target)",
         "description": "Synthetic branch operations with no label, for analysis without ML."},
    ]
    (OUT / "catalog.json").write_text(json.dumps(catalog, indent=2), encoding="utf-8")
    for entry in catalog:
        path = OUT / entry["filename"]
        print(f"{path.relative_to(ROOT)}  {path.stat().st_size / 1024:,.0f} KB")


if __name__ == "__main__":
    main()
