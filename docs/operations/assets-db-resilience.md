# Assets database resilience rollout

The application changes in this repository are intended to tolerate chronic PostgreSQL connection resets. They do not assume that Direct VPC is the sole root cause.

## Release order

1. Deploy the application image to staging. Confirm `/startup` returns 200 and `/health` remains process-only.
2. Load-test `assetsApiCuratedPrefetchForApi` at 150 requests/second for five minutes (45,000 requests) with `scripts/loadtest-assets-resilience.js`.
3. Merge the phase-one PR. Production deploys the new assets revision with zero traffic; Terraform deliberately leaves `enable_assets_db_startup_probe` and `enable_assets_worker` false so its concurrent apply cannot race the application deploy.
4. As soon as the production API deployment completes, export the production `TOKENS_API_BASE_URL` and `TOKENS_API_KEY`, then run `bun scripts/warm-curated-last-good.ts`. If any list cannot return a valid payload, roll back the API deployment and do not promote the Cloud Run candidate; a cold key cannot serve stale data during a transient database failure.
5. Copy the candidate revision from the deployment workflow summary. Promote it one stage at a time with `scripts/promote-assets-revision.sh <candidate> 10`, then `50`, then `100`. Record the stable revision printed by the script.
6. Observe at least 15 minutes at each stage. Compare the candidate and stable revisions independently; service-wide metrics are not a valid promotion gate while an incident is active. Roll back with `scripts/promote-assets-revision.sh <candidate> rollback <stable>` if the candidate's normalized 5xx rate, connection-error rate, or latency regresses, memory crosses the current envelope, or stale responses rise unexpectedly.
7. After the 100% promotion the deploy workflow removes every `resilience-`/`res-` tag except the new candidate's and the previous stable's. A tagged revision stays routable and keeps the service's min instances warm, so leftover tags pile up idle instances and exhaust the `/24` subnet (2026-10-22). If you promote by hand, prune the same way: `gcloud run services update-traffic tokens-assets-prd-us --region=us-east4 --remove-tags <old-tags>`.
7. Repeat the last-good warm/verification after the 50% observation window and before promotion to 100%.
8. After the candidate has remained healthy at 100%, set `enable_assets_db_startup_probe = true` and `enable_assets_worker = true` in a small phase-two Terraform PR. Do not route jobs yet.
9. Apply phase two, sync and smoke-test the worker, then set `route_assets_jobs_to_worker = true` in a final routing change.

Before each promotion, verify the candidate revision is Ready. During each 15-minute observation window check the Assets DB resilience dashboard, Cloud Run instance/memory metrics, and Cloud SQL connections. Do not continue merely because the deployment workflow is green—the workflow smoke test still exercises the stable production URL while the candidate has zero or partial traffic.

The structured database panels split failures by `revision`. For Cloud Run request logs, use the revision resource label directly so an active incident on the stable revision does not hide the candidate result:

```sh
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="tokens-assets-prd-us" AND resource.labels.revision_name="CANDIDATE_REVISION" AND httpRequest.status>=500' \
  --project=tokensxyz --freshness=15m --limit=1000 --format='value(timestamp,httpRequest.status,httpRequest.latency)'
```

Run the same query for the recorded stable revision and compare error counts per request, not raw counts, because the traffic shares differ at 10% and 50%.

Do not restart the service during a diagnostic recurrence unless user-facing 5xx impact requires emergency mitigation. A restart destroys evidence and is only a mitigation.

## Worker cutover

The isolated worker is deliberately a two-step Terraform rollout because several provider credentials are currently managed outside Terraform.

1. Set `enable_assets_worker = true` and leave `route_assets_jobs_to_worker = false`; apply Terraform.
2. Run `scripts/sync-assets-worker-env.sh` for the target project. The script copies values without printing them, sets the worker's OIDC audience to its own URL, and restores Secret Manager references.
3. Confirm an unauthenticated worker `/jobs/*` request returns 401, then invoke one low-impact worker job with Scheduler identity and verify its logs and `application_name=cloudrun-assets-jobs` database attribution. Do not route Scheduler traffic if either authentication check fails.
4. Set `route_assets_jobs_to_worker = true` and apply Terraform.
5. Confirm the API role returns 404 for `/jobs/*` and the worker returns 404 for `/query/*` and `/mutation/*`.

## Transport canaries

Run the **DB transport canaries** workflow with action `deploy`. It creates three one-instance services:

- Bun/postgres.js over Direct VPC.
- Bun/postgres.js over Serverless VPC Access.
- Node 22/postgres.js over Direct VPC.

Each opens ten fresh connections per minute and records TCP, TLS, first-connect/query, and warm-query timings. Remove the canaries after attribution to stop connector, Cloud Run, Scheduler, and logging costs.

Interpretation:

- Connector succeeds while Bun/Direct fails: migrate the assets service away from Direct VPC.
- Node/Direct succeeds while Bun/Direct fails: move to Node or validate a fixed Bun/postgres.js version.
- Both alternatives fail: escalate to Google Cloud with flow, TLS, revision, and source-IP evidence.
- All succeed while production fails: reproduce composite-query fan-out under controlled load.

Application hardening and last-good caching remain required regardless of the canary result.
