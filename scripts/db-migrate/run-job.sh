#!/usr/bin/env bash
# Run a script inside a one-off Cloud Run job attached to the env VPC, with
# DATABASE_URL from Secret Manager, then print the job's logs and exit with
# its status. Used by .github/workflows/db-migrate.yml (see
# docs/operations/db-migrations.md). Needs an authenticated gcloud with
# run.admin + iam.serviceAccountUser (create/execute as the runtime SA) and
# logging.viewer (read the output) — the cr-deployer SA.
#
# usage: run-job.sh <stg|prd> <job-name> <script-file> [env-file]
#   env-file: optional KEY=VALUE lines passed to the job as extra env vars
#             (values must not contain '@').
set -euo pipefail

env_name="${1:?usage: run-job.sh <stg|prd> <job-name> <script-file> [env-file]}"
job="${2:?job name}"
script_file="${3:?script file}"
env_file="${4:-}"
project="${GCP_PROJECT:?GCP_PROJECT must be set}"
region="${GCP_REGION:-us-east4}"
log_out="${LOG_OUT:-/dev/null}"

runtime_sa="cr-runtime-${env_name}@${project}.iam.gserviceaccount.com"
secret="tokens-database-url-${env_name}-us"
network="tokens-vpc-${env_name}"
subnet="tokens-subnet-${env_name}-us"

# '@'-delimited KEY=VALUE list; base64 never contains '@'.
env_vars="^@^JOB_SCRIPT_B64=$(base64 -w0 < "$script_file")"
if [ -n "$env_file" ]; then
    while IFS= read -r line; do
        [ -n "$line" ] && env_vars+="@${line}"
    done < "$env_file"
fi

cleanup() {
    gcloud run jobs delete "$job" --region="$region" --project="$project" --quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "creating job $job (${runtime_sa}, secret ${secret}, ${network}/${subnet})"
gcloud run jobs create "$job" \
    --image=postgres:16 \
    --region="$region" --project="$project" \
    --service-account="$runtime_sa" \
    --set-secrets="DATABASE_URL=${secret}:latest" \
    --network="$network" --subnet="$subnet" --vpc-egress=all-traffic \
    --set-env-vars="$env_vars" \
    --command=bash \
    --args='^|^-c|echo "$JOB_SCRIPT_B64" | base64 -d | bash' \
    --max-retries=0 --task-timeout=20m --memory=512Mi \
    --quiet >/dev/null

status=0
gcloud run jobs execute "$job" --region="$region" --project="$project" --wait --quiet || status=$?

# Log ingestion lags the execution by a few seconds; wait for the end marker.
logs=""
for _ in $(seq 1 24); do
    logs=$(gcloud logging read \
        "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$job\" AND textPayload:*" \
        --project="$project" --freshness=1h --order=asc --format='value(textPayload)' 2>/dev/null || true)
    if grep -q '^MIGRATE_END$' <<<"$logs" || { [ "$status" -ne 0 ] && [ -n "$logs" ]; }; then break; fi
    sleep 5
done

if [ -z "$logs" ]; then
    echo "::warning::no job logs readable (job exit=$status). The deployer SA needs roles/logging.viewer." >&2
else
    printf '%s\n' "$logs"
    printf '%s\n' "$logs" > "$log_out"
fi

if [ "$status" -ne 0 ]; then
    echo "::error::job $job failed (exit $status)" >&2
    exit "$status"
fi
if ! grep -q '^MIGRATE_END$' <<<"$logs"; then
    echo "::error::job $job finished but its output was incomplete (no MIGRATE_END marker)" >&2
    exit 1
fi
