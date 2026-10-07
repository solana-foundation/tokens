#!/bin/bash
set -euo pipefail

REPO_DIR="${TOKENS_REPO_DIR:-/home/runner/tokens}"
DOPPLER_PROJECT=tokens
DOPPLER_CONFIG=prd
TARGET="${TARGET:-prod}"

cd "$REPO_DIR"

for key in TOKENS_API_KEY TOKENS_API_KEY_STAGING TOKENS_API_PROD_URL TOKENS_API_STAGE_URL TOKENS_APP_PROD_URL TOKENS_APP_STAGE_URL SLACK_ALERT_WEBHOOK_URL GRAFANA_LOKI_URL GRAFANA_LOKI_USER GRAFANA_LOKI_TOKEN; do
  declare "$key=$(doppler secrets get "$key" --plain --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG")"
done
for key in SF_LOKI_URL SF_LOKI_USER SF_LOKI_WRITE_TOKEN; do
  declare "$key=$(doppler secrets get "$key" --plain --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" 2>/dev/null || true)"
done

push_smoke_to_loki() {
  local target="$1" status="$2" summary="$3" log_path="$4"
  if [ -z "${GRAFANA_LOKI_URL:-}" ] || [ -z "${GRAFANA_LOKI_USER:-}" ] || [ -z "${GRAFANA_LOKI_TOKEN:-}" ]; then
    return 0
  fi
  local summary_json
  summary_json=$(grep -E '^\{"event":"smoke_canary_summary"' "$log_path" | tail -1 || true)
  local line
  if [ -n "$summary_json" ]; then
    line=$(jq -c --arg target "$target" --argjson exit "$status" \
      '. + {target: $target, exit_code: $exit, failed_any: (((.failed // 0) > 0) or ($exit > 0))}' <<<"$summary_json")
  else
    line=$(jq -nc --arg target "$target" --argjson exit "$status" --arg summary "$summary" \
      '{event: "smoke_canary_summary", target: $target, exit_code: $exit, summary: $summary, failed_any: ($exit > 0)}')
  fi
  local ts payload
  ts="$(date +%s)000000000"
  payload=$(jq -nc \
    --arg target "$target" --arg host "$(hostname)" --arg ts "$ts" --arg line "$line" \
    '{streams: [{stream: {service: "tokens-smoke", env: "prd", target: $target, host: $host}, values: [[$ts, $line]]}]}')
  local url user token
  while IFS='|' read -r url user token; do
    [ -n "$url" ] && [ -n "$user" ] && [ -n "$token" ] || continue
    curl -sS --max-time 10 -o /dev/null -X POST \
      "$url/loki/api/v1/push" \
      -H "Authorization: Basic $(printf '%s:%s' "$user" "$token" | base64 -w0)" \
      -H 'Content-Type: application/json' \
      --data "$payload" || true
  done <<EOF
$GRAFANA_LOKI_URL|$GRAFANA_LOKI_USER|$GRAFANA_LOKI_TOKEN
${SF_LOKI_URL:-}|${SF_LOKI_USER:-}|${SF_LOKI_WRITE_TOKEN:-}
EOF
}

if [ "$TARGET" = "staging" ]; then
  api_url="$TOKENS_API_STAGE_URL"; app_url="$TOKENS_APP_STAGE_URL"; api_key="$TOKENS_API_KEY_STAGING"
else
  api_url="$TOKENS_API_PROD_URL"; app_url="$TOKENS_APP_PROD_URL"; api_key="$TOKENS_API_KEY"
fi

SMOKE_LOG="$(mktemp -t tokens-smoke.XXXXXX)"
trap 'rm -f "$SMOKE_LOG"' EXIT

probe_status=0
TOKENS_API_BASE_URL="$api_url" \
TOKENS_APP_BASE_URL="$app_url" \
TOKENS_API_KEY="$api_key" \
  "$HOME/.bun/bin/bun" scripts/smoke-canary.ts > "$SMOKE_LOG" 2>&1 \
  || probe_status=$?

cat "$SMOKE_LOG"

SUMMARY=$(grep -E '^FAILED: ' "$SMOKE_LOG" | tail -1 || true)
[ -z "$SUMMARY" ] && SUMMARY=$(tail -1 "$SMOKE_LOG" || true)
[ -z "$SUMMARY" ] && SUMMARY="smoke-canary exited $probe_status"

push_smoke_to_loki "$TARGET" "$probe_status" "$SUMMARY" "$SMOKE_LOG"

if [ "$probe_status" -ne 0 ]; then
  FAILED_PROBES=$(grep -E '^\[FAIL\] ' "$SMOKE_LOG" | head -8 || true)
  if [ -n "${SLACK_ALERT_WEBHOOK_URL:-}" ]; then
    FIELDS=$(jq -n \
      --arg target "$TARGET" \
      --arg host "$(hostname)" \
      --arg summary "$SUMMARY" \
      --arg failed "${FAILED_PROBES:-(no probe details captured)}" \
      '[
        {type:"mrkdwn", text:("*Target:*\n`"+$target+"`")},
        {type:"mrkdwn", text:("*Result:*\n`"+$summary+"`")},
        {type:"mrkdwn", text:("*Host:*\n"+$host)},
        {type:"mrkdwn", text:("*Failed probes:*\n```"+$failed+"```")}
      ]')
    PAYLOAD=$(jq -n \
      --arg marker "[ALERT] API Health" \
      --arg scope "tokens.xyz" \
      --arg color "#d63031" \
      --arg target "$TARGET" \
      --argjson fields "$FIELDS" \
      '{
        text: ("*" + $marker + "* — scope: `" + $scope + " (" + $target + ")`"),
        attachments: [{
          color: $color,
          blocks: [
            {type:"section", text:{type:"mrkdwn", text:("*" + $marker + "* — target `" + $target + "`")}},
            {type:"section", fields:$fields}
          ]
        }]
      }')
    curl -sS --fail-with-body -X POST -H 'Content-Type: application/json' \
      --data "$PAYLOAD" "$SLACK_ALERT_WEBHOOK_URL" || true
  fi
  exit "$probe_status"
fi
