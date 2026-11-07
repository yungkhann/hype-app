#!/usr/bin/env bash
# Regenerate the frontend's API types from the FastAPI schema. Run after changing any Pydantic schema.
set -euo pipefail
cd "$(dirname "$0")/.."
apps/api/.venv/bin/python scripts/dump_openapi.py
pnpm --filter web exec openapi-typescript ../../docs/openapi.json -o lib/api/schema.d.ts
echo "wrote apps/web/lib/api/schema.d.ts"
