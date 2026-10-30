#!/usr/bin/env bash
# Send up to <count> requests to <revision-url><path> through Cloud Run's
# frontend and fail on the first one that was not routed to the revision.
#
# Why a burst: on 2026-10-30 the Google frontend answered ~5% of requests to a
# freshly deployed tokens-usage revision with its own HTML "404 Page not
# found" for 22 minutes. The container never saw them (zero 404s in its
# request logs), so a single health request passes 95% of the time; 100 of
# them catch a 5% drop with >99% probability.
#
# Why stop at the first failure: one dropped request already fails the gate,
# and an unresponsive revision would otherwise cost <count> x the request
# timeout before the caller can roll back or refuse to route traffic.
#
# Routed  = 200, or 401/403 (the request reached Cloud Run IAM or the app's
#           own auth; admin prd and every stg service are IAM-gated).
# Dropped = 404 (the frontend's own page), any 5xx, or no response.
set -euo pipefail

url="${1:?usage: probe-cloudrun-revision.sh <revision-url> [count] [path]}"
count="${2:-100}"
path="${3:-/health}"
target="${url%/}$path"

for i in $(seq 1 "$count"); do
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$target" || echo 000)
  case "$code" in
    200|401|403) ;;
    *)
      echo "probe: request $i/$count to $target was not routed (status $code, 000 = no response)" >&2
      exit 1
      ;;
  esac
done
echo "probe: $count/$count requests to $target routed"
