"""Write the API's OpenAPI schema to docs/openapi.json without starting a server."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.main import create_app  # noqa: E402

schema = create_app().openapi()
target = ROOT / "docs" / "openapi.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(schema, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"wrote {target.relative_to(ROOT)} ({len(schema['paths'])} paths)")
