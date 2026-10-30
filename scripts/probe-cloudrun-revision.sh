#!/usr/bin/env bash
# Send <count> requests to <revision-url><path> through Cloud Run's frontend
# and fail if any of them was not routed to the revision.
#
# Why a burst: on 2026-10-30 the Google frontend answered ~5% of requests to a
# freshly deployed tokens-usage revision with its own HTML "404 Page not
# found" for 22 minutes. The container never saw them (zero 404s in its
# request logs), so a single health request passes 95% of the time; 100 of
# them catch a 5% drop with >99% probability.
#
# Routed  = 200, or 401/403 (the request reached Cloud Run IAM or the app's
#           own auth; admin prd and every stg service are IAM-gated).
# Dropped = 404 (the frontend's own page), any 5xx, or no response.
set -euo pipefail

url="${1:?usage: probe-cloudrun-revision.sh <revision-url> [count] [path]}"
count="${2:-100}"
path="${3:-/health}"
target="${url%/}$path"

bad=0
codes=""
for _ in $(seq 1 "$count"); do
  code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' "$target" || echo 000)
  case "$code" in
    200|401|403) ;;
    *) bad=$((bad + 1)); codes="$codes $code" ;;
  esac
done

if [ "$bad" -gt 0 ]; then
  echo "probe: $bad/$count requests to $target were not routed (codes:$codes)" >&2
  exit 1
fi
echo "probe: $count/$count requests to $target routed"
