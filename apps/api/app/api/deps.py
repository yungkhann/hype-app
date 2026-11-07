"""Request-scoped access to the long-lived services created in the app lifespan."""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Annotated
from urllib.parse import quote

import pandas as pd
from fastapi import Depends, Path, Request

from app.core.config import Settings
from app.services.datasets import DatasetService
from app.services.modeling.runner import ExperimentManager
from app.services.reporting.store import ReportStore
from app.storage.paths import ID_PATTERN

DatasetIdPath = Annotated[str, Path(pattern=ID_PATTERN, description="32-character dataset id")]
ExperimentIdPath = Annotated[str, Path(pattern=ID_PATTERN)]
ItemIdPath = Annotated[str, Path(pattern=ID_PATTERN)]


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_datasets(request: Request) -> DatasetService:
    return request.app.state.datasets


def get_experiments(request: Request) -> ExperimentManager:
    return request.app.state.experiments


def get_reports(request: Request) -> ReportStore:
    return request.app.state.reports


SettingsDep = Annotated[Settings, Depends(get_settings)]
DatasetsDep = Annotated[DatasetService, Depends(get_datasets)]
ExperimentsDep = Annotated[ExperimentManager, Depends(get_experiments)]
ReportsDep = Annotated[ReportStore, Depends(get_reports)]


_FORMULA_START = r"^[=+\-@\t\r]"


def neutralize_formulas(frame: pd.DataFrame) -> pd.DataFrame:
    """Prefix ``'`` to text cells a spreadsheet would execute as a formula (=, +, -, @, tab, CR).

    Only text columns are touched, and text that is a plain number ("-5") is left alone. Exact values remain
    available as Parquet or as the original upload.
    """
    out = None
    for column in frame.columns:
        series = frame[column]
        if not (pd.api.types.is_object_dtype(series) or pd.api.types.is_string_dtype(series)
                or isinstance(series.dtype, pd.CategoricalDtype)):
            continue
        text = series.astype("string")
        risky = text.str.contains(_FORMULA_START, regex=True, na=False)
        if not risky.any():
            continue
        risky &= pd.to_numeric(text.where(risky), errors="coerce").isna()
        if risky.any():
            out = frame.copy() if out is None else out
            out[column] = series.astype("object").where(~risky, "'" + text[risky].astype("object"))
    return frame if out is None else out


def csv_stream(frame: pd.DataFrame, chunk_rows: int = 50_000) -> Iterator[bytes]:
    """Stream a DataFrame as UTF-8 CSV (with BOM so Excel opens Cyrillic text correctly).

    Text that a spreadsheet would run as a formula is neutralized (see ``neutralize_formulas``).
    """
    yield "﻿".encode()
    if frame.empty:
        yield frame.to_csv(index=False).encode("utf-8")
        return
    for start in range(0, len(frame), chunk_rows):
        chunk = neutralize_formulas(frame.iloc[start:start + chunk_rows])
        yield chunk.to_csv(index=False, header=start == 0, date_format="%Y-%m-%dT%H:%M:%S").encode("utf-8")


def attachment(filename: str) -> dict[str, str]:
    """Content-Disposition for any dataset name (RFC 6266 / RFC 5987).

    HTTP headers are Latin-1, so a Cyrillic or Kazakh name cannot go in `filename` as-is. `filename` gets an
    ASCII-only fallback and `filename*` the real UTF-8 name, percent-encoded. Quotes, CR/LF and path separators
    never reach the header either way.
    """
    cleaned = "".join(ch if ch.isalnum() or ch in "._- ·()" else "_" for ch in filename).strip() or "export"
    stem, dot, extension = cleaned.rpartition(".") if "." in cleaned else (cleaned, "", "")
    ascii_stem = re.sub(r"_+", "_", re.sub(r"[^A-Za-z0-9._ -]", "_", stem)).strip("_ .") or "export"
    ascii_extension = re.sub(r"[^A-Za-z0-9]", "", extension)
    fallback = f"{ascii_stem}.{ascii_extension}" if dot and ascii_extension else ascii_stem
    return {"Content-Disposition": f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(cleaned, safe='')}"}
