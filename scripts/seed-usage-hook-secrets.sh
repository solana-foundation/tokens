#!/usr/bin/env bash
# Seed the usage service's /hooks/* secrets from Doppler (tokens/prd) into
# GCP Secret Manager, wire them into the Cloud Run service, and verify the
# log-drain + clerk-webhook + webacy endpoints end-to-end.
#
# Prereqs: `doppler login` (prd access), gcloud authed on the target project.
# See apps/cloudrun-usage/src/hooks.ts and hooks.webacy.ts for the endpoints
# being wired. WEBACY_WEBHOOK_SECRET is written to Doppler by
# scripts/webacy-webhook-subscribe.ts --create; re-run this script after it.
set -euo pipefail

PROJECT="${GCP_PROJECT:?GCP_PROJECT must be set}"
REGION="${GCP_REGION:-us-east4}"
SERVICE="tokens-usage-prd-us"
DOPPLER_ARGS=(--project tokens --config prd)

# Doppler name -> Secret Manager secret id
declare -A SECRETS=(
  [LOKI_PUSH_URL]=tokens-loki-push-url-prd
  [LOKI_PUSH_AUTH]=tokens-loki-push-auth-prd
  [VERCEL_DRAIN_SECRET]=tokens-vercel-drain-secret-prd
  [CLERK_WEBHOOK_SECRET]=tokens-clerk-webhook-secret-prd
  [WEBACY_WEBHOOK_SECRET]=tokens-webacy-webhook-secret-prd
)

echo "== 1/4 Checking Doppler access =="
for name in "${!SECRETS[@]}"; do
  if ! doppler secrets get "$name" --plain "${DOPPLER_ARGS[@]}" >/dev/null 2>&1; then
    echo "MISSING in Doppler tokens/prd: $name" >&2
    echo "Available names:" >&2
    doppler secrets --only-names "${DOPPLER_ARGS[@]}" >&2 || true
    exit 1
  fi
done
echo "all ${#SECRETS[@]} present"

echo "== 2/4 Seeding Secret Manager ($PROJECT) =="
for name in "${!SECRETS[@]}"; do
  sm="${SECRETS[$name]}"
  doppler secrets get "$name" --plain "${DOPPLER_ARGS[@]}" | tr -d '\n' |
    gcloud secrets versions add "$sm" --project "$PROJECT" --data-file=- >/dev/null
  echo "seeded $sm"
done

echo "== 3/4 Wiring secrets into $SERVICE (rolls a new revision) =="
gcloud run services update "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --update-secrets "LOKI_PUSH_URL=tokens-loki-push-url-prd:latest,LOKI_PUSH_AUTH=tokens-loki-push-auth-prd:latest,VERCEL_DRAIN_SECRET=tokens-vercel-drain-secret-prd:latest,CLERK_WEBHOOK_SECRET=tokens-clerk-webhook-secret-prd:latest,WEBACY_WEBHOOK_SECRET=tokens-webacy-webhook-secret-prd:latest" \
  --quiet >/dev/null
URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')
echo "deployed: $URL"

echo "== 4/4 Verifying =="
fail=0

# clerk-webhook: healthy = 400 "missing svix headers" (500 = secret still unset)
code=$(curl -s -o /tmp/clerk-check.txt -w '%{http_code}' -X POST "$URL/hooks/clerk-webhook")
body=$(cat /tmp/clerk-check.txt; rm -f /tmp/clerk-check.txt)
if [[ "$code" == "400" ]]; then
  echo "clerk-webhook: OK ($code $body)"
else
  echo "clerk-webhook: FAIL — got $code '$body', expected 400 'missing svix headers'"; fail=1
fi

# webacy: healthy = 401 "missing signature" (500 = secret still unset)
code=$(curl -s -o /tmp/webacy-check.txt -w '%{http_code}' -X POST -H 'X-Event-Type: DEPEG_TIER_CHANGE' -d '{}' "$URL/hooks/webacy")
body=$(cat /tmp/webacy-check.txt; rm -f /tmp/webacy-check.txt)
if [[ "$code" == "401" ]]; then
  echo "webacy: OK ($code $body)"
else
  echo "webacy: FAIL - got $code '$body', expected 401 'missing signature'"; fail=1
fi

# log-drain without secret: expect 403
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -d '{}' "$URL/hooks/log-drain?service=tokens-smoke&env=prd")
if [[ "$code" == "403" ]]; then
  echo "log-drain (no secret): OK (403)"
else
  echo "log-drain (no secret): FAIL — got $code, expected 403"; fail=1
fi

# log-drain with secret + test line: expect 204 (proves Loki push works end-to-end)
now_ms=$(($(date +%s) * 1000))
code=$(doppler secrets get VERCEL_DRAIN_SECRET --plain "${DOPPLER_ARGS[@]}" | tr -d '\n' | {
  read -r sec
  curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H "x-vercel-drain-secret: $sec" \
    -d "{\"timestamp\":$now_ms,\"message\":\"seed-usage-hook-secrets smoke $(date -u +%FT%TZ)\",\"source\":\"smoke\"}" \
    "$URL/hooks/log-drain?service=tokens-smoke&env=prd"
})
if [[ "$code" == "204" ]]; then
  echo "log-drain (authed + Loki push): OK (204) — check Grafana {service=\"tokens-smoke\"}"
else
  echo "log-drain (authed): FAIL — got $code (502 = Loki push failing, check LOKI_PUSH_URL/AUTH)"; fail=1
fi

if [[ "$fail" == "0" ]]; then
  cat <<EOF

ALL GREEN. Now flip the two targets:

1. Vercel dashboard -> Team settings -> Log Drains (per project):
   URL:    $URL/hooks/log-drain?service=<tokens-api|tokens-app|tokens-web|tokens-docs>&env=prd
   Header: x-vercel-drain-secret: <VERCEL_DRAIN_SECRET from Doppler tokens/prd>
   (keep the custom header — deliveries 403 without it)

2. Clerk dashboard -> Webhooks -> EDIT the existing endpoint's URL in place
   (do NOT create a new endpoint — that mints a new whsec_):
   $URL/hooks/clerk-webhook
   Then use "Send test event" and expect 200.

3. Webacy: the subscription's webhookUrl must be
   $URL/hooks/webacy
   (bun scripts/webacy-webhook-subscribe.ts --list to check; --create to subscribe).
EOF
else
  echo; echo "Verification failed — do NOT flip Vercel/Clerk yet."; exit 1
fi
