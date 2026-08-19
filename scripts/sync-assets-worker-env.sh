#!/usr/bin/env bash
set -euo pipefail

# Mirror the assets service's out-of-band provider configuration onto the
# isolated worker without printing secret/plain values. Terraform owns the
# core DB/auth refs and scaling; this bridge is temporary until every provider
# credential is migrated to Secret Manager.

project="${1:-tokens-498908}"
region="${2:-us-east4}"
env_name="${3:-prd}"
source_service="tokens-assets-${env_name}-us"
worker_service="tokens-assets-jobs-${env_name}-us"

worker_url=$(
  gcloud run services describe "$worker_service" \
    --project="$project" \
    --region="$region" \
    --format='value(status.url)'
)
if [ -z "$worker_url" ]; then
  echo "Could not resolve URL for $worker_service" >&2
  exit 1
fi

env_file=$(mktemp)
source_config=$(mktemp)
trap 'rm -f "$env_file" "$source_config"' EXIT
chmod 600 "$env_file"
chmod 600 "$source_config"

gcloud run services describe "$source_service" --project="$project" --region="$region" --format=json >"$source_config"

jq --arg worker_url "$worker_url" '
      [.spec.template.spec.containers[0].env[]
       | select(.value != null)
       | { key: .name, value: .value }]
      | from_entries
      | .SERVICE_ROLE = "worker"
      | .PG_POOL_MAX = "8"
      | .PG_CONNECT_TIMEOUT = "3"
      | .SCHEDULER_OIDC_AUDIENCE = $worker_url
    ' "$source_config" >"$env_file"

# Secret names/versions are configuration, not secret values. Mirror any
# provider refs too, then force the two Terraform-owned refs to their expected
# environment-specific names.
secret_updates=$(
  jq -r --arg env_name "$env_name" '
    [.spec.template.spec.containers[0].env[]
     | select(.valueFrom.secretKeyRef.name != null)
     | { key: .name, value: (.valueFrom.secretKeyRef.name + ":" + (.valueFrom.secretKeyRef.key // "latest")) }]
    | from_entries
    | .DATABASE_URL = (.DATABASE_URL // ("tokens-database-url-" + $env_name + ":latest"))
    | .TOKENS_CLOUDRUN_AUTH_TOKEN = (.TOKENS_CLOUDRUN_AUTH_TOKEN // ("tokens-cloudrun-auth-token-" + $env_name + ":latest"))
    | to_entries
    | map(.key + "=" + .value)
    | join(",")
  ' "$source_config"
)

# --env-vars-file replaces the literal env-var set wholesale, which is exactly
# the mirrored full set built above; the same invocation's --update-secrets
# restores every secret ref. (--update-env-vars-file is not a gcloud flag.)
gcloud run services update "$worker_service" \
  --project="$project" \
  --region="$region" \
  --env-vars-file="$env_file" \
  --update-secrets="$secret_updates" \
  --quiet >/dev/null

echo "Synced provider environment to $worker_service (values redacted)."
