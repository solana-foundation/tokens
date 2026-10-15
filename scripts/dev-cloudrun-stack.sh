#!/bin/bash
# Boot the full GCP-backed stack locally: dockerized Postgres + the four
# cloudrun-* services on localhost. No GCP deploy needed — the services are
# plain Bun/Hono servers; Cloud Run only adds ingress/IAM around them.
#
# Usage:
#   ./scripts/dev-cloudrun-stack.sh                  # boot everything
#
# Then flip the apps (see the env block printed at the end) and `bun dev`.
#
# Ports: assets=3010 prices=3011 usage=3012 admin=3013 postgres=54329
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

PG_CONTAINER=tokens-dev-pg
PG_PORT="${TOKENS_DEV_PG_PORT:-54329}"
export DATABASE_URL="postgres://tokens:tokens@localhost:${PG_PORT}/tokens"
AUTH_TOKEN="${TOKENS_CLOUDRUN_AUTH_TOKEN:-dev-token}"

# --- 1. Postgres ------------------------------------------------------------
if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
    if docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
        docker start "$PG_CONTAINER" >/dev/null
    else
        docker run -d --name "$PG_CONTAINER" \
            -e POSTGRES_USER=tokens -e POSTGRES_PASSWORD=tokens -e POSTGRES_DB=tokens \
            -p "${PG_PORT}:5432" postgres:16 >/dev/null
    fi
fi
echo "waiting for postgres on :${PG_PORT}…"
for _ in $(seq 1 30); do
    if docker exec "$PG_CONTAINER" pg_isready -U tokens >/dev/null 2>&1; then break; fi
    sleep 1
done

# --- 2. Schema (idempotent) ---------------------------------------------------
./db/apply.sh

# --- 3. Services --------------------------------------------------------------
export TOKENS_CLOUDRUN_AUTH_TOKEN="$AUTH_TOKEN"
export TOKENS_API_KEY_ENCRYPTION_SECRET="${TOKENS_API_KEY_ENCRYPTION_SECRET:-dev-encryption-secret}"
export TOKENS_IDENTITY_SIGNING_SECRET="${TOKENS_IDENTITY_SIGNING_SECRET:-dev-identity-signing-secret}"
export TOKENS_ADMIN_CLERK_USER_IDS="${TOKENS_ADMIN_CLERK_USER_IDS:-}"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

PORT=3010 bun apps/cloudrun-assets/src/index.ts  & pids+=($!)
PORT=3011 bun apps/cloudrun-prices/src/index.ts  & pids+=($!)
PORT=3012 bun apps/cloudrun-usage/src/index.ts   & pids+=($!)
PORT=3013 bun apps/cloudrun-admin/src/index.ts   & pids+=($!)

sleep 2
for port in 3010 3011 3012 3013; do
    if curl -sf "http://localhost:${port}/health" >/dev/null; then
        echo "ok    service on :${port}"
    else
        echo "WARN  service on :${port} not healthy (check logs above — provider API keys are only needed for warm/refresh paths)"
    fi
done

cat <<ENV

Stack is up. Point the apps at it (\`.env.local\`):

  # apps/api + apps/app
  TOKENS_CLOUDRUN_ENABLED=true
  TOKENS_CLOUDRUN_ASSETS_URL=http://localhost:3010
  TOKENS_CLOUDRUN_PRICES_URL=http://localhost:3011
  TOKENS_CLOUDRUN_USAGE_URL=http://localhost:3012
  TOKENS_CLOUDRUN_ADMIN_URL=http://localhost:3013
  TOKENS_CLOUDRUN_AUTH_TOKEN=${AUTH_TOKEN}

  # apps/app additionally (signs x-tokens-identity for the usage service)
  TOKENS_IDENTITY_SIGNING_SECRET=${TOKENS_IDENTITY_SIGNING_SECRET}

  # apps/admin additionally
  TOKENS_ADMIN_CLERK_USER_IDS=<your clerk user id>

Smoke checks (no apps needed):
  curl -s -X POST localhost:3012/query/ping -H "Authorization: Bearer ${AUTH_TOKEN}" -d '{}'
  bun scripts/seed-registry.mjs                       # seeds assets from the checked-in registry
  bun scripts/check-mint.mjs --mint <MINT>            # reads through the assets service

Ctrl-C stops the services (postgres container keeps running; \`docker rm -f ${PG_CONTAINER}\` to reset).
ENV

wait
