"""Format detection and parsing for CSV, Excel, and Parquet.

To support another format tomorrow: add its extensions to ``EXTENSIONS``, a magic-byte check to
``MAGIC`` if it has one, and a ``read_<format>`` function to ``READERS``.
"""

from __future__ import annotations

import csv
import io
import re
import warnings
import zipfile
from collections.abc import Callable
from pathlib import Path

import charset_normalizer
import numpy as np
import pandas as pd

from app.core.errors import PayloadTooLarge, ValidationFailed
from app.schemas.datasets import DetectedFormat, FileFormat, IngestOptions

EXTENSIONS: dict[str, FileFormat] = {
    ".csv": "csv", ".tsv": "csv", ".txt": "csv",
    ".xlsx": "xlsx",
    ".parquet": "parquet", ".pq": "parquet",
}
MAGIC: dict[FileFormat, bytes] = {"xlsx": b"PK\x03\x04", "parquet": b"PAR1"}
CANDIDATE_DELIMITERS = [",", ";", "\t", "|"]
# Encodings worth considering when a file is not UTF-8: Cyrillic (Kazakh/Russian) and Western.
FALLBACK_ENCODINGS = ["cp1251", "koi8_r", "utf_16", "cp1252", "latin_1"]
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$")
_SNIFF_BYTES = 256 * 1024


def format_for(filename: str, head: bytes) -> FileFormat:
    ext = Path(filename).suffix.lower()
    fmt = EXTENSIONS.get(ext)
    if fmt is None:
        allowed = ", ".join(sorted(EXTENSIONS))
        raise ValidationFailed(f"Unsupported file type '{ext or 'none'}'. Accepted: {allowed}.",
                               code="unsupported_format")
    magic = MAGIC.get(fmt)
    if magic and not head.startswith(magic):
        raise ValidationFailed(f"The file has a {ext} extension but its contents are not {fmt}.",
                               code="format_mismatch")
    if fmt == "csv" and b"\x00" in head[:4096] and not head.startswith((b"\xff\xfe", b"\xfe\xff")):
        raise ValidationFailed("The file looks binary, not a text CSV.", code="format_mismatch")
    return fmt


def detect_encoding(sample: bytes) -> tuple[str, float]:
    if sample.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig", 1.0
    if sample.startswith((b"\xff\xfe", b"\xfe\xff")):
        return "utf-16", 1.0
    try:
        # A truncated multi-byte character at the cut-off point is not a decoding failure.
        sample[: len(sample) - 4 if len(sample) == _SNIFF_BYTES else len(sample)].decode("utf-8")
        return "utf-8", 1.0
    except UnicodeDecodeError:
        pass
    best = charset_normalizer.from_bytes(sample, cp_isolation=FALLBACK_ENCODINGS).best()
    if best is None:
        return "cp1251", 0.0
    return best.encoding, round(1.0 - float(best.chaos), 3)


def detect_delimiter(text: str) -> str:
    lines = [line for line in text.splitlines()[:50] if line.strip()]
    if not lines:
        return ","
    try:
        dialect = csv.Sniffer().sniff("\n".join(lines[:20]), delimiters="".join(CANDIDATE_DELIMITERS))
        return dialect.delimiter
    except csv.Error:
        pass
    # Fallback: the candidate with the most consistent non-zero count per line.
    def score(delim: str) -> tuple[int, int]:
        counts = [line.count(delim) for line in lines]
        consistent = sum(1 for c in counts if c == counts[0] and c > 0)
        return consistent, counts[0]
    return max(CANDIDATE_DELIMITERS, key=score)


_ABSOLUTE_PATH = re.compile(r"(?:[A-Za-z]:)?(?:[\\/][^\\/\s'\"(),;:]+){2,}")


def describe_error(exc: BaseException, limit: int = 300) -> str:
    """Library error text for the user, without absolute paths (they reveal the local username)."""
    text = _ABSOLUTE_PATH.sub("<file>", str(exc)).strip()
    return (text[:limit] + "…") if len(text) > limit else text or type(exc).__name__


def preflight(path: Path, fmt: FileFormat, *, max_rows: int, max_columns: int, max_uncompressed_mb: int) -> None:
    """Refuse files that would exhaust memory, using only their metadata (nothing is decompressed or parsed).

    xlsx is a zip archive: a small upload can expand to many gigabytes (a "zip bomb"). Parquet declares its row
    and column counts in the footer.
    """
    if fmt == "xlsx":
        try:
            with zipfile.ZipFile(path) as archive:
                expanded = sum(info.file_size for info in archive.infolist())
        except zipfile.BadZipFile as exc:
            raise ValidationFailed("This is not a valid .xlsx workbook (it is not a zip archive).",
                                   code="unreadable_file") from exc
        if expanded > max_uncompressed_mb * 1024 * 1024:
            raise PayloadTooLarge(
                f"The workbook expands to {expanded / 1024 / 1024:,.0f} MB, above the "
                f"{max_uncompressed_mb:,} MB limit (ATLAS_MAX_UNCOMPRESSED_MB). Export the sheet as CSV or Parquet.",
                code="file_too_large_uncompressed")
    elif fmt == "parquet":
        import pyarrow.parquet as pq

        try:
            metadata = pq.ParquetFile(path).metadata
        except Exception as exc:  # pyarrow raises ArrowInvalid/OSError variants
            raise ValidationFailed(f"Parquet parsing failed: {describe_error(exc)}", code="parse_error") from exc
        if metadata.num_rows > max_rows:
            raise ValidationFailed(f"{metadata.num_rows:,} rows exceeds the {max_rows:,}-row limit "
                                   "(raise ATLAS_MAX_ROWS to allow it).", code="too_many_rows")
        if metadata.num_columns > max_columns:
            raise ValidationFailed(f"{metadata.num_columns:,} columns exceeds the {max_columns:,}-column limit.",
                                   code="too_many_columns")


def list_sheets(path: Path) -> list[str]:
    from openpyxl import load_workbook

    try:
        workbook = load_workbook(path, read_only=True, data_only=True)
    except Exception as exc:  # openpyxl raises many types for corrupt files
        raise ValidationFailed(f"Could not open the Excel workbook: {describe_error(exc)}",
                               code="unreadable_file") from exc
    try:
        return list(workbook.sheetnames)
    finally:
        workbook.close()


def detect(path: Path, fmt: FileFormat) -> DetectedFormat:
    if fmt == "csv":
        with path.open("rb") as handle:
            sample = handle.read(_SNIFF_BYTES)
        encoding, confidence = detect_encoding(sample)
        text = sample.decode(encoding, errors="replace")
        return DetectedFormat(format=fmt, encoding=encoding, encoding_confidence=confidence,
                              delimiter=detect_delimiter(text))
    if fmt == "xlsx":
        return DetectedFormat(format=fmt, sheets=list_sheets(path))
    return DetectedFormat(format=fmt)


# ---- readers ----------------------------------------------------------------

def read_csv(path: Path, options: IngestOptions, detected: DetectedFormat,
             nrows: int | None) -> pd.DataFrame:
    encoding = options.encoding or detected.encoding or "utf-8"
    delimiter = options.delimiter or detected.delimiter or ","
    if delimiter == "\\t":
        delimiter = "\t"
    try:
        return pd.read_csv(path, sep=delimiter, encoding=encoding, header=options.header_row,
                           decimal=options.decimal, nrows=nrows, low_memory=False,
                           encoding_errors="strict")
    except UnicodeDecodeError as exc:
        raise ValidationFailed(
            f"The file is not valid {encoding}. Choose another encoding in the import options.",
            code="encoding_error") from exc
    except pd.errors.ParserError as exc:
        raise ValidationFailed(f"CSV parsing failed: {describe_error(exc)}. Check the delimiter and header row.",
                               code="parse_error") from exc
    except pd.errors.EmptyDataError as exc:
        raise ValidationFailed("The file contains no data.", code="empty_file") from exc


def read_xlsx(path: Path, options: IngestOptions, detected: DetectedFormat,
              nrows: int | None) -> pd.DataFrame:
    sheets = detected.sheets or list_sheets(path)
    sheet = options.sheet or (sheets[0] if sheets else 0)
    if options.sheet and options.sheet not in sheets:
        raise ValidationFailed(f"Sheet '{options.sheet}' does not exist.", code="unknown_sheet",
                               details={"sheets": sheets})
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # openpyxl style warnings are noise here
        try:
            return pd.read_excel(path, sheet_name=sheet, header=options.header_row, nrows=nrows,
                                 engine="openpyxl")
        except ValueError as exc:
            raise ValidationFailed(f"Excel parsing failed: {describe_error(exc)}", code="parse_error") from exc


def read_parquet(path: Path, options: IngestOptions, detected: DetectedFormat,
                 nrows: int | None) -> pd.DataFrame:
    import pyarrow.parquet as pq

    try:
        if nrows is None:
            return pd.read_parquet(path)
        parquet = pq.ParquetFile(path)
        batch = next(parquet.iter_batches(batch_size=nrows), None)
        return batch.to_pandas() if batch is not None else parquet.schema_arrow.empty_table().to_pandas()
    except Exception as exc:  # pyarrow raises ArrowInvalid/OSError variants
        raise ValidationFailed(f"Parquet parsing failed: {describe_error(exc)}", code="parse_error") from exc


READERS: dict[FileFormat, Callable[[Path, IngestOptions, DetectedFormat, int | None], pd.DataFrame]] = {
    "csv": read_csv,
    "xlsx": read_xlsx,
    "parquet": read_parquet,
}


# ---- normalization ------------------------------------------------------------

def normalize_columns(frame: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """Make column names unique non-empty strings. Returns the renames performed."""
    notes: list[str] = []
    seen: dict[str, int] = {}
    names: list[str] = []
    for index, raw in enumerate(frame.columns):
        name = str(raw).strip()
        if not name or name.lower().startswith("unnamed:"):
            new = f"column_{index + 1}"
            notes.append(f"Unnamed column at position {index + 1} named '{new}'.")
            name = new
        if name in seen:
            seen[name] += 1
            new = f"{name}_{seen[name]}"
            notes.append(f"Duplicate column '{name}' renamed to '{new}'.")
            name = new
        else:
            seen[name] = 0
        names.append(name)
    out = frame.copy()
    out.columns = names
    return out, notes


def normalize_values(frame: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """Make the frame Parquet-safe and parse unambiguous ISO-8601 date columns.

    Every conversion is reported back so the UI can disclose it; nothing else is altered.
    """
    notes: list[str] = []
    out = frame.copy()
    for column in out.columns:
        series = out[column]
        if pd.api.types.is_object_dtype(series):
            inferred = series.infer_objects()
            if not pd.api.types.is_object_dtype(inferred):
                out[column] = inferred
                continue
            out[column] = series.astype("str")
            series = out[column]
        if pd.api.types.is_string_dtype(series) and not pd.api.types.is_datetime64_any_dtype(series):
            non_null = series.dropna()
            if non_null.empty:
                continue
            probe = non_null.head(2_000).astype("str").str.strip()
            if probe.str.match(ISO_DATE).mean() >= 0.98:
                parsed = pd.to_datetime(series, errors="coerce", format="ISO8601", utc=False)
                failed = int(parsed.isna().sum() - series.isna().sum())
                if failed <= max(1, int(0.01 * len(non_null))):
                    out[column] = parsed
                    note = f"'{column}' parsed as datetime (ISO 8601)."
                    if failed:
                        note += f" {failed} unparseable value(s) became missing."
                    notes.append(note)
    return out, notes


def frame_from_bytes_preview(frame: pd.DataFrame) -> pd.DataFrame:
    """Replace non-finite floats so the preview never contains NaN/inf literals."""
    return frame.replace([np.inf, -np.inf], np.nan)


__all__ = ["READERS", "EXTENSIONS", "format_for", "detect", "normalize_columns", "normalize_values",
           "frame_from_bytes_preview", "io"]
