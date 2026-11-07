#!/usr/bin/env bash
# Static HTML/CSS/JS frontend. No bundler.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PORT="${ATLAS_WEB_PORT:-3000}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Stop that process or set ATLAS_WEB_PORT in .env." >&2
  exit 1
fi

echo "CQA Studio → http://127.0.0.1:${PORT}"
cd apps/web
exec python3 -m http.server "$PORT" --bind 127.0.0.1
