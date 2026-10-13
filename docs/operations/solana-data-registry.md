# Asset registry sync (data.solana.com → `GET /v2/registry`)

The Solana Foundation data team's **Project Canon** asset registry (~3.3k Solana
mints with the Foundation taxonomy group › category › class, Allium and RWA.xyz
classifications and values, CoinGecko market cap) is synced hourly into Postgres
and served as `GET /api/v2/registry`. tokens.xyz's `/registry` page reads that
endpoint; nothing on the web side talks to data.solana.com or Birdeye any more.

## Data flow

```
Cloud Scheduler  →  POST /jobs/sync-solana-data-assets   (cloudrun-assets worker, hourly at :23)
  GET https://data.solana.com/v1/assets  (x-api-key SOLANA_DATA_API_KEY; one body, no pagination)
  all-or-nothing: http error / bad envelope / truncated → no writes
  suspicious_drop guard: skip when rows < 70 % of the current active set
  upsert solana_data_assets_latest (source_rank = upstream order); deactivate rows no longer returned
  provider phase: active mints with no platform logo (variant_markets_latest / tokens / mint_logos)
    → Birdeye /defi/v3/token/meta-data/multiple, 50 per call, ≤ providerLimit mints per run
    → provider_name / provider_logo_uri / provider_fetched_at (stamped on misses too; refreshed every 7 d)

logo-sync  picks provider_logo_uri up as its lowest-priority source and re-hosts it in mint_logos

api   GET /api/v2/registry  → solanaDataAssetsList (one statement: rows + total + newest timestamps,
      name/logo/hasTokenPage resolved from variant_markets_latest / tokens / mint_logos / asset_variants)
web   /registry  → one GET /api/v2/registry?limit=5000 inside `use cache` (minutes)
```

Migration: `db/migrations/0031_solana_data_assets.sql` (apply via the one-off
Cloud Run migration job **before** promoting the image that carries the query).

## Job args (`body_json`)

| arg                   | default | range          | meaning                                                            |
| --------------------- | ------- | -------------- | ------------------------------------------------------------------ |
| `providerLimit`       | 500     | 0–2000         | Birdeye meta-data lookups per run (mints); 0 disables the phase    |
| `concurrency`         | 2       | 1–4            | provider pool lanes (the Birdeye key is shared with market crons) |
| `delayMs`             | 200     | 0–5000         | pacing between provider batches                                    |
| `providerRefreshDays` | 7       | 1–90           | re-query a mint's provider metadata after this long                |
| `budgetMs`            | 300000  | 10000–520000   | whole-run deadline; the provider phase gets what is left           |

Skips (`ok: true, skipped: true`, acknowledged): `invalid_payload` (upstream
`truncated: true`), `empty_payload`, `suspicious_drop`.

Failures (`ok: false` → HTTP 500, retried by Cloud Scheduler): `http_error`,
`error` (network / timeout), `invalid_payload` (non-JSON or no `data.rows`),
`upsert_failed` (every chunk failed). None of them deactivate anything.

## Summary log

One line per run. A completed sync logs `event: "solana_data_assets_sync"`;
failures and skips log `event: "solana_data_assets_sync_skipped"` with the
reason in `skipped`, so the stale alert only counts real syncs. Fields: `job`, `fetched`,
`synced`, `deactivated`, `invalidMint`, `invalidNumeric`, `duplicateMint`,
`withGroup`, `providerLooked`, `providerHits`, `providerFailed`, `partial`,
`generatedAt`, `duration_ms`. `withGroup` dropping to 0 means the upstream
renamed its taxonomy columns again (DAT-553 did once); the rows still land, with
null taxonomy, so fix the parser rather than the data.

Alert: `alert-rules/assets-solana-data-sync-stale.json` fires when no
completed-sync summary has been logged for 3 hours (two missed hourly ticks),
including the case where every tick fails or is skipped.

## Operating

- Re-run manually: `POST /jobs/sync-solana-data-assets` with `{}` on the worker
  via the scheduler invoker (see `scripts/_jobs.mjs` for the identity token).
  A one-off backfill of all provider logos: `{ "providerLimit": 2000 }` a few times.
- The job group is `404 solana_data_jobs_disabled` when `SOLANA_DATA_API_KEY` is
  missing on the service (the API key is the data team's; `SOLANA_DATA_API_URL`
  optionally overrides the upstream URL for a mirror / local mock).
- Secret: `tokens-solana-data-api-key-<env>` (Secret Manager, no version managed by
  terraform). Seed once: `printf '%s' "$KEY" | gcloud secrets versions add tokens-solana-data-api-key-<env> --data-file=-`,
  then `gcloud run services update tokens-assets-<env>-us --region us-east4 --update-secrets=SOLANA_DATA_API_KEY=tokens-solana-data-api-key-<env>:latest`
  and `scripts/sync-assets-worker-env.sh <project> us-east4 <env>` (Cloud Run env
  is under `lifecycle.ignore_changes`, as for logo-sync).
- Inspect:
  `SELECT group_name, COUNT(*) FROM solana_data_assets_latest WHERE is_active GROUP BY 1 ORDER BY 2 DESC;`
  `SELECT COUNT(*) FILTER (WHERE provider_logo_uri IS NOT NULL) AS with_provider_logo, COUNT(*) FILTER (WHERE provider_fetched_at IS NULL) AS never_looked FROM solana_data_assets_latest WHERE is_active;`
- Rollback: the page and the endpoint keep serving the last synced rows; pausing
  the scheduler job freezes the registry rather than emptying it.
- Overlapping runs (an hourly tick plus a manual trigger) are safe without a
  lock: both the upsert and the deactivation skip rows whose `last_seen_at` is
  newer than the run's own start, so an older snapshot can never overwrite or
  hide what a newer run wrote.
- Provider metadata refreshes every `providerRefreshDays` for mints the
  platform itself has no logo for. A `mint_logos` copy that logo-sync made from
  this table's own `provider_logo_uri` does not count as a platform logo, so a
  changed upstream name or logo still lands and logo-sync re-hosts it.

## Side effects to know

- Birdeye load: at most `providerLimit / 50` meta-data calls per run (10 by
  default), only while there are mints without a platform logo; steady state is
  near zero once the ~1.5k unindexed mints have been looked up.
- logo-sync will spend a few of its 200-per-run slots on registry logos after
  curated mints, so the first-party copies appear over a couple of hours.
