#!/usr/bin/env bash
# Runs INSIDE the one-off Cloud Run job (image postgres:16). Read-only: prints
# the applied schema_migrations versions between markers for the runner to parse.
set -euo pipefail
# The Secret Manager value carries a trailing newline that psql rejects.
DB=$(printf %s "$DATABASE_URL" | tr -d '\r\n')
echo "MIGRATE_BEGIN"
if [ "$(psql "$DB" -tAc "SELECT to_regclass('schema_migrations') IS NOT NULL")" = "t" ]; then
    psql "$DB" -v ON_ERROR_STOP=1 -tAc "SELECT version FROM schema_migrations ORDER BY version"
fi
echo "MIGRATE_END"
