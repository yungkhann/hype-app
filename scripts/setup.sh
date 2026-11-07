#!/usr/bin/env bash
# One-time setup: Python venv + API deps, web deps, synthetic samples, generated API types.
# Everything installs inside the repository (apps/api/.venv, node_modules). Nothing global.
set -euo pipefail
cd "$(dirname "$0")/.."
export NEXT_TELEMETRY_DISABLED=1

PYTHON="${PYTHON:-}"
if [[ -z "$PYTHON" ]]; then
  for candidate in python3.13 python3.12 python3.14 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then PYTHON="$candidate"; break; fi
  done
fi
echo "→ Python: $($PYTHON --version)"

if [[ ! -x apps/api/.venv/bin/python ]]; then
  "$PYTHON" -m venv apps/api/.venv
fi
apps/api/.venv/bin/python -m pip install --quiet --upgrade pip
apps/api/.venv/bin/python -m pip install --quiet -r apps/api/requirements.txt -r apps/api/requirements-dev.txt
apps/api/.venv/bin/python -m pip install --quiet -r apps/api/requirements-optional.txt \
  || echo "⚠ CatBoost could not be installed; Model Lab hides it."

echo "→ Web dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "→ Synthetic samples"
apps/api/.venv/bin/python scripts/generate_samples.py

echo "→ API types"
bash scripts/gen-api-types.sh

echo "✓ Setup complete. Run: pnpm dev   (web http://127.0.0.1:3000 · API docs http://127.0.0.1:8000/docs)"
echo "  Optional, for browser tests: pnpm --filter web e2e:install   (downloads Chromium into node_modules)"
