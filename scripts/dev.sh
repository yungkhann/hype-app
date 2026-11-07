#!/usr/bin/env bash
# Start API (127.0.0.1:8000) and web (127.0.0.1:3000) together. Ctrl+C stops both.
# Ports and limits can be overridden in a root .env file (see .env.example). Both bind to 127.0.0.1 only.
set -euo pipefail
cd "$(dirname "$0")/.."
export NEXT_TELEMETRY_DISABLED=1

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

export ATLAS_API_PORT="${ATLAS_API_PORT:-8000}"
export ATLAS_WEB_PORT="${ATLAS_WEB_PORT:-3000}"
# The browser calls the API directly; keep the web app, API URL, and CORS allow-list in sync.
export NEXT_PUBLIC_ATLAS_API="${NEXT_PUBLIC_ATLAS_API:-http://127.0.0.1:${ATLAS_API_PORT}}"
export ATLAS_CORS_ORIGINS="${ATLAS_CORS_ORIGINS:-[\"http://localhost:${ATLAS_WEB_PORT}\",\"http://127.0.0.1:${ATLAS_WEB_PORT}\"]}"

if [[ ! -x apps/api/.venv/bin/python || ! -d node_modules ]]; then
  echo "Dependencies missing. Run: pnpm run bootstrap" >&2
  exit 1
fi

for port in "$ATLAS_API_PORT" "$ATLAS_WEB_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop that process or set ATLAS_API_PORT / ATLAS_WEB_PORT in .env." >&2
    exit 1
  fi
done

echo "ATLAS → web http://127.0.0.1:${ATLAS_WEB_PORT}  ·  API http://127.0.0.1:${ATLAS_API_PORT}/docs"
exec pnpm exec concurrently --kill-others-on-fail --names api,web --prefix-colors blue,green \
  "bash scripts/dev-api.sh" \
  "pnpm --filter web dev"
