"""Identifier and filename safety. No user-supplied string ever becomes a filesystem path directly."""

from __future__ import annotations

import re
import unicodedata
import uuid
from pathlib import Path

from app.core.errors import NotFoundError, ValidationFailed

ID_PATTERN = r"^[a-f0-9]{32}$"
_ID_RE = re.compile(ID_PATTERN)
_UNSAFE_CHARS = re.compile(r"[^A-Za-z0-9._ -]+")


def new_id() -> str:
    return uuid.uuid4().hex


def check_id(value: str) -> str:
    if not _ID_RE.fullmatch(value or ""):
        raise NotFoundError("Unknown identifier.", code="invalid_id")
    return value


def sanitize_filename(name: str, default: str = "upload") -> str:
    """Return a display-safe basename: no directories, control chars, or leading dots."""
    base = Path(name or "").name
    base = unicodedata.normalize("NFKC", base)
    base = _UNSAFE_CHARS.sub("_", base).strip(" .")
    return (base or default)[:120]


def safe_child(root: Path, *parts: str) -> Path:
    """Join ``parts`` under ``root`` and refuse anything that escapes it."""
    root_resolved = root.resolve()
    candidate = root_resolved.joinpath(*parts).resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise ValidationFailed("Path escapes the workspace.", code="unsafe_path")
    return candidate
