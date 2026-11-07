"""Write the CQA evaluator contract (JSON schemas + a worked request/response pair) to docs/cqa-contract/.

The example is built from the synthetic fixture conversation fx-ru-001 and the unofficial development checklist,
and is validated against the backend before it is written, so the documented example is always a passing one.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.cqa.contract import contract_schema, validate_output  # noqa: E402
from app.cqa.examples import example_output, example_request  # noqa: E402
from app.cqa.ingestion import fixture_payload, parse_payload  # noqa: E402

request = example_request()
output = example_output()
parsed = parse_payload(fixture_payload("FIXTURE"), "FIXTURE", "fixture", "1970-01-01T00:00:00+00:00")
conversation_id = request.conversation.conversation_id
messages = next(r for r in parsed.records if r.id == conversation_id).messages
validate_output(request, output, messages)  # raises ContractViolation if the example drifted from the contract

target = ROOT / "docs" / "cqa-contract"
target.mkdir(parents=True, exist_ok=True)
files = {
    "example-request.json": request.model_dump(mode="json"),
    "example-response.json": output,
    "schema.json": contract_schema(),
}
for name, data in files.items():
    (target / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {(target / name).relative_to(ROOT)}")
