#!/usr/bin/env bash
# FleetFlow staging deploy (Phase 14, blueprint §13.4): rolling update of the
# api/worker services on a docker-compose host, smoke-tested, with automatic
# rollback to the previously-good image tag when the smoke test fails.
#
# This is the exact loop the CD workflow (cd.yml → deploy-staging) runs on the
# self-hosted `staging` runner. It is also runnable by hand / locally against
# locally-built images (REGISTRY empty) — that is how the loop is verified.
#
# Env:
#   IMAGE_TAG   required — tag to deploy (CD passes the git SHA)
#   REGISTRY    optional image registry prefix (ghcr.io/org); empty = local
#   PROJECT     compose project name (default fleetflow-staging)
#   SMOKE_BASE_URL  optional; default http://localhost:${API_PORT:-3000}
#   STAGING_ENV_FILE optional env file; default ./deploy/staging/.env.staging
# Exit: 0 deployed+smoke OK; 1 deploy failed (rolled back if possible)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/deploy/staging"
PROJECT="${PROJECT:-fleetflow-staging}"
STATE_DIR="${STATE_DIR:-$HERE/.state}"
SMOKE_SCRIPT="$REPO_ROOT/deploy/scripts/smoke-test.sh"

IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG is required (e.g. the git SHA being deployed)}"
export IMAGE_TAG
[ -n "${REGISTRY:-}" ] && export REGISTRY || unset REGISTRY

COMPOSE_ARGS=(-p "$PROJECT" -f "$HERE/compose.staging.yml")
ENV_FILE="${STAGING_ENV_FILE:-$HERE/.env.staging}"
if [ -f "$ENV_FILE" ]; then
  COMPOSE_ARGS+=(--env-file "$ENV_FILE")
  echo "==> Using env file: $ENV_FILE"
fi
COMPOSE=(docker compose "${COMPOSE_ARGS[@]}")

mkdir -p "$STATE_DIR"
PREV_FILE="$STATE_DIR/previous-image-tag"
PREV_TAG=""
[ -f "$PREV_FILE" ] && PREV_TAG="$(cat "$PREV_FILE")"

smoke() {
  SMOKE_BASE_URL="${SMOKE_BASE_URL:-http://localhost:${API_PORT:-3000}}" bash "$SMOKE_SCRIPT"
}

echo "==> Deploying image tag: $IMAGE_TAG (project: $PROJECT)"
if [ -n "${REGISTRY:-}" ]; then
  echo "==> Pulling images from $REGISTRY"
  "${COMPOSE[@]}" pull api worker
fi
"${COMPOSE[@]}" up -d api worker

if smoke; then
  echo "$IMAGE_TAG" > "$PREV_FILE"
  echo "==> DEPLOY OK: $IMAGE_TAG is live and healthy"
  exit 0
fi

echo "==> Smoke test FAILED for $IMAGE_TAG" >&2
if [ -n "$PREV_TAG" ]; then
  echo "==> Rolling back to previous image tag: $PREV_TAG" >&2
  export IMAGE_TAG="$PREV_TAG"
  "${COMPOSE[@]}" up -d api worker
  if smoke; then
    echo "==> ROLLBACK OK: $PREV_TAG is live and healthy" >&2
  else
    echo "==> ROLLBACK ALSO FAILED — manual intervention required" >&2
    "${COMPOSE[@]}" ps >&2 || true
  fi
else
  echo "==> No previous image tag recorded — nothing to roll back to" >&2
fi
exit 1
