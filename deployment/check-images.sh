#!/usr/bin/env bash
# Fails if a production image contains secrets or private data: .env files, keys, tokens, signed source URLs,
# case-data folders, .git, virtualenvs. Usage: deployment/check-images.sh IMAGE [IMAGE...]
set -euo pipefail

status=0
for image in "$@"; do
  echo "== $image"
  if docker run --rm --network none --entrypoint sh "$image" -c '
      bad=0
      for root in /opt/atlas /srv /home /data; do
        [ -d "$root" ] || continue
        if find "$root" \( -name ".env" -o -name ".env.*" -o -name "hype.env" -o -name "*.pem" -o -name "*.key" \
             -o -name "id_rsa*" -o -name "*.dpapi" \) -print 2>/dev/null | grep .; then bad=1; fi
        if find "$root" -type d \( -path "*/data/workspaces" -o -path "*/data/private" -o -name ".git" \
             -o -name "node_modules" -o -name ".venv" -o -name "__pycache__" \) -print 2>/dev/null | grep .; then bad=1; fi
        if grep -rIlE "sig=[A-Za-z0-9%_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[ousr]_[A-Za-z0-9]{30,}" \
             "$root" 2>/dev/null; then bad=1; fi
      done
      exit $bad'; then
    echo "   clean"
  else
    echo "   FOUND files that must not be in a production image (listed above)" >&2
    status=1
  fi
done
exit $status
