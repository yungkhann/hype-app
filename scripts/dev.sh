#!/usr/bin/env bash
# Frontend is static HTML. API is optional.
set -euo pipefail
cd "$(dirname "$0")/.."
exec bash scripts/dev-web.sh
