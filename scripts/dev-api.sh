#!/usr/bin/env bash
# FastAPI with reload, bound to localhost only.
set -euo pipefail
cd "$(dirname "$0")/../apps/api"
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "${ATLAS_API_PORT:-8000}" --reload \
  --reload-dir app
