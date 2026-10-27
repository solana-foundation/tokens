# Cloud Run logs → Loki pipeline

How Cloud Run log lines reach Grafana Loki, what breaks it, and how to tell
"the job stopped" from "the logs are late". Every Loki-based "silent" or
"stale" alert depends on this path.

## The path

```
Cloud Run stdout/stderr + severity>=WARNING  (tokens-*-{env}-us)
  → Cloud Logging sink  tokens-cloudrun-{env}         (terraform/modules/observability/main.tf)
  → Pub/Sub topic       tokens-logs-{env}
  → push subscription   tokens-logs-to-grafana-{env}  (OIDC as logs-pusher-{env}@)
  → tokens-admin-{env}-us  POST /hooks/gcp-logs       (apps/cloudrun-admin/src/hooks.ts)
  → Grafana Cloud Loki  (LOKI_PUSH_URL / LOKI_PUSH_AUTH on the admin service)
```

- **One Cloud Logging entry is one Pub/Sub message is one HTTP push.** The
  hook batches concurrent deliveries into one Loki push (250 ms window, 500
  entries) but the inbound side has no batching: throughput is bounded by
  the admin service (prd: max 10 instances × 1 vCPU, concurrency 80), about
  250 entries/s in practice. Above that Cloud Run answers `429 no available
instance`, Pub/Sub backs off per message (10 s → 60 s, was 600 s before
  2026-10-27) and the backlog drains at the endpoint's pace.
- Stream labels: `service` (Cloud Run service name), `env`, `source=gcp`,
  `severity`. The line is `textPayload` or the JSON of `jsonPayload`.
- The sink excludes the hook's own request logs and any `loki: ` lines so
  the pipeline cannot feed itself.
- Loki drops an entry whose (timestamp, line) duplicates one already in the
  stream, and the hook writes timestamps at millisecond precision. Identical
  lines logged in the same millisecond (multi-line object dumps) collapse to
  one. That is why a 600k-entry burst showed up as ~20k lines in Loki.

## The heartbeat and the lag guard

Every Loki push the hook makes also carries one entry in the stream
`{service="tokens-logs-pipeline", env, source="direct"}` (at most one per
10 s per instance), timestamped **now**, with
`{"event":"gcp_logs_push","lag_s":<now − oldest entry in the push>,"entries":<n>}`.
It never travels through Cloud Logging or Pub/Sub, so it is current even
when everything else is queued.

- `tokens-logs-pipeline-lagging` (alert-rules/logs-pipeline-lagging.json)
  fires when `lag_s` stays above 300 for 5 minutes, or when no heartbeat has
  been seen for 5 minutes (no pushes at all).
- Every GCP-sourced silence/stale rule (`assets-v2-evm-markets-refresh-silent`,
  `stablecoin-peg-guard-stale`, `assets-v2-solana-sync-stale`,
  `assets-v2-evm-variants-sync-stale`, `assets-solana-data-sync-stale`,
  `stablecoin-depeg-sweep-stale`, `stablecoin-depeg-webhook-silent`,
  `external-provider-feed-stale`) carries query `D` = the same lag and only
  fires while the lag is under 600 s. Both the job query and the lag query
  end in `or vector(0)`: Loki returns no series for a count of zero, and
  Grafana's `replaceNN` reduce cannot invent a value for a missing series,
  so without the fallback a silent job (or a missing heartbeat) would skip
  the math condition and land in `noDataState` instead of being guarded.
  With no heartbeat data at all the guard therefore passes (fail-open).
  `api-smoke-canary-stale` is not guarded: the API logs arrive through the
  Vercel drain, not this pipeline.

A real outage that starts during a lag episode is therefore reported once
the backlog drains, not before. The lag alert is the signal to go and look.

## Incident: the daily NOTICE burst (2026-10-21 → 2026-10-27)

Once a day `tokens-assets-prd-us` wrote 400k–620k severity-DEFAULT entries
in a few minutes (10-21 04:54Z, 10-22 06:34Z, 10-23 12:34Z, 10-24 15:19Z,
10-25 17:19Z, 10-26 18:04Z, 10-27 18:34Z). postgres.js's default `onnotice`
printed each Postgres NOTICE as a ten-line object; the NOTICE was
`text-search query contains only stop words or doesn't contain lexemes,
ignored`, raised by `to_tsquery('english', $1)` once per scanned row per
call site because the search queries inlined it into WHERE and ORDER BY
over seq scans (one search for "the" = 5,400 notices on `asset_aliases`
alone). The trigger was one API key running ~1,000 `/v1/assets/search`
calls in 25 minutes each day.

The backlog on `tokens-logs-to-grafana-prd` reached 520k messages, the
oldest unacked message aged past 40 minutes, and on the days the lag crossed
the 45-minute window `tokens-assets-v2-evm-markets-silent` paged while the
jobs worker was running every job on time. The first RCA blamed the worker.

Fixes: `@tokens/cloudrun-shutdown/postgres-notice` (NOTICE and below are
dropped, WARNING+ become one line) on every Cloud Run postgres client; the
eight full-text queries evaluate the tsquery once through
`WITH tq AS MATERIALIZED (...)`; the Pub/Sub backoff ceiling went from 600 s
to 60 s; the heartbeat, the lag alert and the lag guard above.

## Diagnosis recipe

All read-only. `TOK=$(gcloud auth print-access-token)`, project
`tokens-498908`.

**Is the pipeline behind?** Backlog and age of the oldest unacked message:

```sh
for m in num_undelivered_messages oldest_unacked_message_age; do
  curl -s -H "Authorization: Bearer $TOK" --get \
    "https://monitoring.googleapis.com/v3/projects/tokens-498908/timeSeries" \
    --data-urlencode "filter=metric.type=\"pubsub.googleapis.com/subscription/$m\" AND resource.labels.subscription_id=\"tokens-logs-to-grafana-prd\"" \
    --data-urlencode "interval.startTime=$(date -u -v-6H +%Y-%m-%dT%H:%M:%SZ)" \
    --data-urlencode "interval.endTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --data-urlencode "aggregation.alignmentPeriod=600s" \
    --data-urlencode "aggregation.perSeriesAligner=ALIGN_MAX" \
  | jq -r '.timeSeries[].points[] | "\(.interval.endTime) \(.value.int64Value)"' | sort
done
```

Healthy: backlog under ~100, age a few seconds. Also `push_request_count`
by `response_class` on the same subscription shows `unreachable` (Cloud Run 429) and `remote_server_5xx`.

**Who produced the burst?** Entries per service and severity, 5-minute sums:

```sh
curl -s -H "Authorization: Bearer $TOK" --get \
  "https://monitoring.googleapis.com/v3/projects/tokens-498908/timeSeries" \
  --data-urlencode 'filter=metric.type="logging.googleapis.com/log_entry_count" AND resource.type="cloud_run_revision"' \
  --data-urlencode "interval.startTime=<RFC3339>" --data-urlencode "interval.endTime=<RFC3339>" \
  --data-urlencode "aggregation.alignmentPeriod=300s" \
  --data-urlencode "aggregation.perSeriesAligner=ALIGN_SUM" \
  --data-urlencode "aggregation.crossSeriesReducer=REDUCE_SUM" \
  --data-urlencode "aggregation.groupByFields=resource.labels.service_name" \
  --data-urlencode "aggregation.groupByFields=metric.labels.severity" \
| jq -r '.timeSeries[] | "\(.resource.labels.service_name) \(.metric.labels.severity)" as $s | .points[] | select((.value.int64Value|tonumber) > 3000) | "\(.interval.endTime) \($s) \(.value.int64Value)"' | sort
```

Then sample the lines: `gcloud logging read 'resource.labels.service_name="<svc>"
AND severity="DEFAULT" AND timestamp>="…" AND timestamp<="…"' --limit=3000
--format="value(textPayload)" | cut -c1-120 | sort | uniq -c | sort -rn | head`.

**Did the job actually run?** Cloud Logging is the source of truth while
Loki is behind:

```sh
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="tokens-assets-jobs-prd-us" AND logName:"requests" AND timestamp>="…"' \
  --project=tokens-498908 --limit=400 \
  --format="value(timestamp,httpRequest.status,httpRequest.latency,httpRequest.requestUrl)" | sort
gcloud logging read '… AND jsonPayload.event="v2_evm_markets_refresh" AND timestamp>="…"' \
  --format="value(timestamp,jsonPayload.refreshed,jsonPayload.processed)"
```

**What Loki has** (Grafana token from Doppler `tokens/prd`,
`GRAFANA_API_URL` + `GRAFANA_API_TOKEN`; datasource uid `tokens-logs`):

```sh
P="$GRAFANA_API_URL/api/datasources/proxy/uid/tokens-logs/loki/api/v1"
curl -s -H "Authorization: Bearer $GRAFANA_API_TOKEN" --get "$P/query_range" \
  --data-urlencode 'query=sum by (service, severity) (count_over_time({env="prd", source="gcp"}[5m]))' \
  --data-urlencode "start=<unix>000000000" --data-urlencode "end=<unix>000000000" --data-urlencode "step=300"
curl -s -H "Authorization: Bearer $GRAFANA_API_TOKEN" --get "$P/query_range" \
  --data-urlencode 'query={service="tokens-logs-pipeline", env="prd"} | json' \
  --data-urlencode "start=<unix>000000000" --data-urlencode "end=<unix>000000000" --data-urlencode "limit=50"
```

Worker lines per 5 minutes sit at ~650–2,200 in prd; a sudden drop to
10–20 % with Cloud Logging still full is lag, not an outage.

## If a second burst source appears

The source fix is the durable part; the pipeline itself still has a hard
ceiling. Options, in order of effort: raise the admin service's
`max_instances` for prd (cost only during bursts, min instances stay 0);
replace the push subscription with a pull subscriber that batches hundreds
of entries per Loki push; add a dead-letter topic so a poison burst can be
discarded instead of drained.
