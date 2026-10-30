#!/usr/bin/env bash
# Send up to <count> requests to <revision-url><path> through Cloud Run's
# frontend and fail on the first one that did not come back 200 from the
# revision itself.
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
# Why only 200 counts: a 401/403 from an IAM-gated service (the admin
# services, the jobs workers) is produced by Cloud Run before the request
# reaches the revision, so it proves nothing about the candidate. Callers
# probing such a service set PROBE_ID_TOKEN to a Google identity token whose
# audience is the service's own URL (not the tag URL) and the token is sent as
# a bearer; every /health route sits in front of the apps' own auth, so an
# authenticated request to a healthy revision is a 200.
set -euo pipefail

url="${1:?usage: PROBE_ID_TOKEN=<optional> probe-cloudrun-revision.sh <revision-url> [count] [path]}"
count="${2:-100}"
path="${3:-/health}"
target="${url%/}$path"

# "${auth[@]+...}" keeps bash 3 (macOS) happy with an empty array under set -u.
auth=()
if [ -n "${PROBE_ID_TOKEN:-}" ]; then
  auth=(-H "Authorization: Bearer $PROBE_ID_TOKEN")
fi

for i in $(seq 1 "$count"); do
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' ${auth[@]+"${auth[@]}"} "$target" || echo 000)
  if [ "$code" != "200" ]; then
    hint=""
    case "$code" in
      000) hint=" (no response within 10 s)" ;;
      401|403) hint=" (rejected by Cloud Run IAM or the app's auth: the probe never proved the revision serves /health; check PROBE_ID_TOKEN and the invoker role)" ;;
      404) hint=" (Cloud Run frontend 404 or no /health route)" ;;
    esac
    echo "probe: request $i/$count to $target returned $code$hint" >&2
    exit 1
  fi
done
echo "probe: $count/$count requests to $target returned 200"
