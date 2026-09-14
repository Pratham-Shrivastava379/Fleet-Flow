#!/usr/bin/env bash
# FleetFlow post-deploy smoke test. Asserts the
# §4.2 health contract — { ok:true, ... } means DB + Redis both responded.
# Used by deploy.sh (and will be reused by Phase 15's production deploy).
#
# Env: SMOKE_BASE_URL (default http://localhost:3000),
#      SMOKE_ATTEMPTS (default 30), SMOKE_DELAY seconds (default 2)
# Exit: 0 healthy; 1 not healthy within the retry window
set -euo pipefail

BASE_URL="${SMOKE_BASE_URL:-http://localhost:3000}"
ATTEMPTS="${SMOKE_ATTEMPTS:-30}"
DELAY="${SMOKE_DELAY:-2}"

for _ in $(seq 1 "$ATTEMPTS"); do
  body="$(curl -fsS -m 5 "$BASE_URL/api/health" 2>/dev/null || true)"
  if [ -n "$body" ] && printf '%s' "$body" | grep -q '"ok":true'; then
    echo "SMOKE OK: $BASE_URL/api/health -> $body"
    exit 0
  fi
  sleep "$DELAY"
done

echo "SMOKE FAILED: $BASE_URL/api/health not healthy after $((ATTEMPTS * DELAY))s" >&2
exit 1
