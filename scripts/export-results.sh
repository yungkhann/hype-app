#!/usr/bin/env bash
# Write or check the organizers' results file (JSON 1.0) from the evaluations ATLAS has stored.
# Reads the data directory only: it never evaluates, never calls GPT and never contacts the organizers' API.
#
#   scripts/export-results.sh --set dev  --group DEV            # writes results/dev/results.json when complete
#   scripts/export-results.sh --set prod --group <group> --dry-run
#   scripts/export-results.sh --set prod --check results/prod/results.json
#
# Loads the root .env like dev-api.sh, so ATLAS_DATA_DIR and ATLAS_CQA_TEAM_NAME apply.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# --check and --out paths are relative to the repository root, as written above.
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check|--out|--data-dir)
      [[ $# -ge 2 ]] || { echo "$1 needs a path" >&2; exit 2; }
      path="$2"
      [[ "$path" = /* ]] || path="$ROOT/$path"
      args+=("$1" "$path")
      shift 2
      ;;
    *)
      args+=("$1")
      shift
      ;;
  esac
done

cd apps/api
exec .venv/bin/python -m app.cqa.results_export "${args[@]}"
