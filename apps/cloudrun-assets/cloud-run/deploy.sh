#!/usr/bin/env bash
# Usage:
#   doppler run --project tokens --config stg_cloudrun -- ./deploy.sh stg
#   doppler run --project tokens --config prd_cloudrun -- ./deploy.sh prd
set -euo pipefail

ENV="${1:?usage: deploy.sh <stg|prd>}"
case "$ENV" in
  stg|prd) ;;
  *) echo "ENV must be stg or prd, got '$ENV'" >&2; exit 1 ;;
esac
PROJECT="${GCP_PROJECT:?GCP_PROJECT must be set (provided by the matching doppler config)}"
REGION="${REGION:-europe-west1}"
SERVICE="tokens-assets-${ENV}"

required=(
  BIRDEYE_API_KEY
  COINGECKO_API_KEY
  SANCTUM_API_KEY
  CLICKHOUSE_URL CLICKHOUSE_USER CLICKHOUSE_PASSWORD CLICKHOUSE_DATABASE
  SCHEDULER_OIDC_AUDIENCE TOKENS_CRON_INVOKER_SA
)
for k in "${required[@]}"; do
  if [ -z "${!k:-}" ]; then
    echo "missing required env $k (run under \`doppler run --config ${ENV}_cloudrun\`)" >&2
    exit 1
  fi
done

optional=(
  BIRDEYE_ORIGIN
  CLICKHOUSE_SOLANA_TRADES_TABLE CLICKHOUSE_STOCK_TRADES_TABLE
  CLICKHOUSE_STOCK_INSTRUMENTS_TABLE CLICKHOUSE_STOCK_PRICE_SCALE
  CLICKHOUSE_FILL_QUALITY_WINDOW_TABLE CLICKHOUSE_STOCK_BBO_TABLE
  CLICKHOUSE_STOCK_TS_EVENT_TYPE TOKENS_CACHE_WARM_SECRET
  WEBACY_API_KEY
  CLICKHOUSE_SOLANA_TRADES_REFRESH_ENABLED
  CLICKHOUSE_FILL_QUALITY_REFRESH_ENABLED
  CLICKHOUSE_STOCK_REFRESH_ENABLED
  FRESH_TRENDING_REFRESH_ENABLED
  RWA_API_KEY
  CLICKHOUSE_SOLANA_TRADES_OHLCV_TABLE
  # logo-sync (PINATA_GATEWAY_TOKEN is a Secret Manager ref, not set here)
  GCS_LOGO_PUBLIC_BASE_URL PINATA_GATEWAY_HOST JUPITER_TOKEN_API_URL
)

DELIM=$'\037'
pairs=""
add_pair() {
  local k="$1" v="$2"
  [ -z "$v" ] && return 0
  if [[ "$v" == *"$DELIM"* ]]; then
    echo "refusing to deploy: env value for ${k} contains the gcloud --update-env-vars delimiter (0x1F)" >&2
    exit 1
  fi
  if [ -n "$pairs" ]; then pairs="${pairs}${DELIM}"; fi
  pairs="${pairs}${k}=${v}"
}

for k in "${required[@]}"; do add_pair "$k" "${!k}"; done
for k in "${optional[@]}"; do add_pair "$k" "${!k:-}"; done

echo "Updating ${SERVICE} in ${PROJECT}/${REGION} with $(echo "$pairs" | tr "$DELIM" '\n' | wc -l | tr -d ' ') env vars"
gcloud run services update "$SERVICE" \
  --project="$PROJECT" --region="$REGION" \
  --update-env-vars "^${DELIM}^${pairs}" \
  --quiet

echo "Done. New revision:"
gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" \
  --format="value(status.latestReadyRevisionName,status.url)"
