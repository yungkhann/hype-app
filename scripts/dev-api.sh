#!/usr/bin/env bash
# FastAPI with reload, bound to localhost only.
# Loads the root .env like dev-web.sh does, so ATLAS_* settings reach the API (including ATLAS_CQA_SOURCE_URL,
# the organizers' endpoint used by "Import via API").
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

cd apps/api
exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port "${ATLAS_API_PORT:-8000}" --reload \
  --reload-dir app
