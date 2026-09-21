#!/usr/bin/env bash
# Runs INSIDE the one-off Cloud Run job (image postgres:16). Unpacks the
# payload (db/apply.sh + the pending db/migrations/*.sql only) and runs the
# repo's own apply script: advisory lock + one transaction per file, skipping
# anything schema_migrations already lists.
set -euo pipefail
DATABASE_URL=$(printf %s "$DATABASE_URL" | tr -d '\r\n')
export DATABASE_URL
mkdir -p /work && cd /work
echo "$MIGRATIONS_TGZ_B64" | base64 -d | tar xz
echo "MIGRATE_BEGIN"
bash db/apply.sh
echo "MIGRATE_END"
