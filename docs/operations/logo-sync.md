# Logo sync (first-party token artwork)

The assets API used to return `logoURI` verbatim from upstream registries
(Birdeye, Jupiter, Sanctum, on-chain metadata). Measured 2026-09-22 against live
output, 12 of 29 logo URLs were unusable by consumers: 11 on public IPFS gateways
(ipfs.io / dweb.link / w3s.link / nftstorage.link, one Cloudflare front that
answers 429 `Retry-After: 900` to servers and 403 to browser user agents), 1 on a
dedicated `*.mypinata.cloud` gateway (403 off-origin), 1 an SVG that native image
decoders cannot render. Helius / Birdeye / generic image proxies relay the same
failures, so consumers could not fix it on their side, and our own share cards
broke for IPFS-hosted logos.

`logo-sync` fetches each mint's artwork once, normalises it to a **256×256 WebP**,
stores it in the public GCS bucket **`tokens-asset-logos-<env>`** at
`solana/<mint>.webp`, and every API handler returns that first-party URL as
`logoURI` when one exists, falling back to the raw value otherwise. The API
contract is unchanged (`logoURI: string | null`).

## Data flow

```
Cloud Scheduler  →  POST /jobs/logo-sync   (cloudrun-assets worker, prd every 15 min, stg daily)
  candidates: mint_logos-aware UNION over variant_markets_latest / tokens /
              sanctum_lsts_latest / launchpad_tokens_latest / token_list_members
              (curated universe first, then mints with a logo fetched in the last 30 days)
  skip:       unchanged source hash + copy < resyncDays old; IPFS refs never re-fetched on age
  backoff:    failed mints wait 1..7 days (× consecutive attempts) unless the source URL changed
  per mint:   fetch plan in order
                1. Pinata dedicated gateway  (IPFS refs only; needs PINATA_GATEWAY_HOST/_TOKEN)
                2. original URL              (unless its host is a public IPFS gateway)
                3. https://dd.dexscreener.com/ds-data/tokens/solana/<mint>.png
                4. Jupiter token API lookup → `icon`, fetched through rules 1–2
              2 MiB cap · magic-byte sniff · sharp (SVG rasterised) → 256px WebP
              upload solana/<mint>.webp (Cache-Control: public, max-age=86400)
              upsert mint_logos (source_url, logo_source_hash, logo_cdn_url, logo_synced_at, …)

api   every logo-bearing SELECT in db.ts resolves
      (SELECT logo_cdn_url FROM mint_logos WHERE mint = …) AS logo_cdn_url
      → handlers/logoUrl.ts resolveLogoUri(row): logo_cdn_url ?? logo_uri
      covers v1 assets/search/resolve/trending/variants, v2 search/resolve/lists, launches, token routes
web   share cards / image-proxy fetch storage.googleapis.com (allowlisted; ipfs.io + cf-ipfs.com removed)
```

Storage is the bucket cloudrun-admin already signs canonical `assets.image_url`
uploads for (terraform `google_storage_bucket.asset_logos`, `allUsers` read,
runtime SA `objectAdmin`), written with the runtime service account's default
credentials — no storage secrets. First-party sources (`/logos/…` local
overrides, `api.tokens.xyz`, the bucket itself) are never re-hosted; the trending
route infers xStock symbols from `/logos/xstocks/<sym>.png`, so those must stay
verbatim.

State lives in `mint_logos` (migration `0023_mint_logos.sql`), one row per mint:
`source_url` / `source_table` (which `logo_uri` won), `source_kind`
(pinata|origin|dexscreener|jupiter), `logo_source_hash` (sha256 of the source
URL), `logo_cdn_url`, `content_type`, `logo_synced_at`, `last_attempt_at`,
`attempts`, `last_error`. A failure never clears a previously published copy.

## Job args (`body_json`)

| arg              | default         | meaning                                                                 |
| ---------------- | --------------- | ----------------------------------------------------------------------- |
| `limit`          | 200 (≤ 1000)    | candidates per run                                                      |
| `concurrency`    | 3 (≤ 6)         | parallel fetch lanes                                                    |
| `delayMs`        | 250             | pacing sleep after every item                                           |
| `budgetMs`       | 480000          | stop starting new items after this; result is `partial: true`           |
| `resyncDays`     | 7               | re-fetch a non-IPFS source whose copy is older than this                |
| `tailDays`       | 30              | non-curated mints qualify when fetched within this many days            |
| `fetchTimeoutMs` | 10000           | per upstream request                                                    |
| `maxBytes`       | 2 MiB (hard cap)| reject larger bodies (`content-length` and streamed)                    |
| `mints`          | —               | explicit targets (≤ 250); bypasses the curated/tail selection           |
| `force`          | false           | ignore the unchanged skip and the failure backoff                       |

Skips (`ok: true, skipped: true`): `no_candidates`. Partial runs (`partial: true`)
happen when `budgetMs` trips or the worker is shutting down; the remaining mints
are simply picked up next tick.

Failures (`ok: false` → HTTP 500, retried once by Cloud Scheduler): every
attempted mint failed. A single bad URL never fails the batch: it is recorded in
`mint_logos.last_error` with the reason from each source
(`pinata:http_429(429); dexscreener:http_404(404); jupiter:lookup_no_icon`).

Every run logs `{"event":"logo_sync",…,"by_source":{"pinata":{"ok":n,"fail":n},…}}`
plus one `external_call` line per upstream request (`provider` = `logo_pinata`,
`logo_origin`, `logo_dexscreener`, `logo_jupiter`, `logo_jupiter_lookup`).

## Manual steps (in order)

**Merge-order rule: apply migration 0023 to an environment's database before the
image containing this change takes traffic there.** Every logo-bearing SELECT now
references `mint_logos`; without the table those queries fail and asset, search,
lists, trending and launches reads break. Staging deploys straight to traffic on
merge, so apply 0023 to stg first, then merge; prd builds a 0%-traffic candidate,
so apply 0023 to prd before promoting it.

1. **Pinata dedicated gateway.** Create one on the Pinata account, enable
   serving content that is not pinned by us (the gateway must resolve arbitrary
   public CIDs), and create a gateway access token. Hostname → terraform
   `pinata_gateway_host` (`terraform/envs/<env>/main.tf`); token → step 3.
2. **Merge → terraform apply** creates the Secret Manager secret
   `tokens-pinata-gateway-token-<env>` (no version) and the Cloud Scheduler job
   `tokens-logo-sync-<env>`.
3. **Seed the secret version** (needs `roles/secretmanager.secretVersionAdder`;
   Steven does not hold it — same path as `scripts/seed-usage-hook-secrets.sh`):
   ```bash
   printf '%s' "$PINATA_GATEWAY_TOKEN" \
     | gcloud secrets versions add tokens-pinata-gateway-token-<env> --data-file=- --project tokens-498908
   ```
4. **Apply migration 0023** via the one-off Cloud Run migration job (see the
   prod DB migration runbook; `db/migrations/0023_mint_logos.sql`).
5. **Push the env onto the live services.** Cloud Run env is under terraform's
   `lifecycle.ignore_changes`, so the new refs land manually:
   ```bash
   # (a) the bucket — required, or /jobs/logo-sync answers 404 logo_sync_disabled.
   #     Terraform declares GCS_LOGO_BUCKET but Cloud Run env is ignore_changes:
   #     checked 2026-09-22, stg has it on both services, prd has it on neither.
   gcloud run services update tokens-assets-<env>-us --project <project> --region us-east4 \
     --update-env-vars=GCS_LOGO_BUCKET=tokens-asset-logos-<env>
   # (b) the Pinata source — only after the secret has a version (step 3), or the
   #     new revision fails to start on a missing secret version.
   gcloud run services update tokens-assets-<env>-us --project <project> --region us-east4 \
     --update-secrets=PINATA_GATEWAY_TOKEN=tokens-pinata-gateway-token-<env>:latest \
     --update-env-vars=PINATA_GATEWAY_HOST=<gateway host>
   # (c) mirror everything onto the worker (the service that actually runs jobs)
   scripts/sync-assets-worker-env.sh <project> us-east4 <env>      # tokens-assets-jobs-<env>-us
   ```
   Projects: prd `tokens-498908`, stg `tokens-stage`. The job is live (with the
   non-IPFS sources) once (a) is done, the image containing it is deployed and
   the migration is applied; steps 1/3/(b) only add the Pinata source.
6. **After Pinata is enabled**, clear the backoff accumulated by IPFS mints that
   could not be fetched without it:
   ```sql
   UPDATE mint_logos SET attempts = 0, last_attempt_at = to_timestamp(0) WHERE logo_cdn_url IS NULL;
   ```
   or run `POST /jobs/logo-sync` with `{"force": true, "limit": 1000}` a few times.
7. **Verify**:
   ```sql
   SELECT source_kind, count(*) FROM mint_logos WHERE logo_cdn_url IS NOT NULL GROUP BY 1;
   SELECT mint, attempts, last_error FROM mint_logos WHERE logo_cdn_url IS NULL ORDER BY attempts DESC LIMIT 50;
   ```
   and `GET /api/v1/assets/<id>` should show `primaryVariant.market.logoURI`
   under `storage.googleapis.com/tokens-asset-logos-<env>/solana/`.

No DNS change is required for any of the above.

## Follow-up: `img.tokens.xyz`

The bucket can be fronted by a branded host without moving DNS off Vercel:
add a `google_compute_backend_bucket` (Cloud CDN on) and a host rule for
`img.tokens.xyz` to the prd load balancer (`terraform/modules/load_balancer`),
a second managed certificate, and one **A record in Vercel DNS** pointing at the
existing load-balancer IP. Then set `logo_public_base_url = "https://img.tokens.xyz"`
in `terraform/envs/prd/main.tf`, push `GCS_LOGO_PUBLIC_BASE_URL` onto both
services (step 5 above), and rewrite existing rows:

```sql
UPDATE mint_logos
   SET logo_cdn_url = replace(logo_cdn_url, 'https://storage.googleapis.com/tokens-asset-logos-prd', 'https://img.tokens.xyz')
 WHERE logo_cdn_url LIKE 'https://storage.googleapis.com/tokens-asset-logos-prd/%';
```

`img.tokens.xyz` is already in the web image-proxy allowlist.

## Run locally

```bash
gcloud auth application-default login          # an identity with storage.objectAdmin on the target bucket
cd apps/cloudrun-assets
SERVICE_ROLE=worker \
BIRDEYE_API_KEY=… DATABASE_URL=… TOKENS_CLOUDRUN_AUTH_TOKEN=dev \
GCS_LOGO_BUCKET=tokens-asset-logos-stg \
PINATA_GATEWAY_HOST=… PINATA_GATEWAY_TOKEN=… \
TOKENS_CRON_INVOKER_SA=<your google account email> \
bun run dev

curl -sS -X POST localhost:8080/jobs/logo-sync \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  -H 'content-type: application/json' \
  -d '{"mints":["<mint>"],"delayMs":0}'
```

The OIDC verifier accepts an invoker-email pin without an audience, so a user
identity token works locally. `/jobs/*` require `BIRDEYE_API_KEY` (the master
switch for all jobs) even though logo-sync itself never calls Birdeye. Point
`GCS_LOGO_BUCKET` at a scratch bucket if you do not want to write staging objects.

## Force a re-sync for one mint

```bash
POST /jobs/logo-sync  {"mints":["<mint>"],"force":true}
```

or `DELETE FROM mint_logos WHERE mint = '<mint>'` and wait for the next tick.
The object key is stable (`solana/<mint>.webp`), so the copy is overwritten in
place; clients and CDNs pick up the new bytes within the one-day `Cache-Control`.

## Side effects to know

- Until a mint is synced it keeps returning the raw upstream URL (today's
  behaviour). Coverage ramps: the curated universe (~1,400 mints) completes in
  roughly two hours at 200 per 15 minutes; the 30-day tail follows over days.
- Removing `ipfs.io` / `cf-ipfs.com` from the web allowlist means an *unsynced*
  IPFS logo now fails the image proxy with "Host not allowed" instead of 429 —
  the same missing image; the sync is what fixes it.
- The `token_markets_latest` JSON `icon` fallback (used only when a mint has no
  market row) is untouched and still returns the raw URL.
- Cached API responses in the Redis last-good cache keep old URLs until they roll.
- Canonical `assets.image_url` (admin uploads) is a separate mechanism that
  already lives in the same bucket and is out of scope here.
