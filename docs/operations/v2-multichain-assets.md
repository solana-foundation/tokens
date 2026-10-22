# v2 multichain assets (chain-first variants + markets)

v1 models a variant as a bare Solana mint. The v2 surface (`GET /api/v2/assets`,
`/api/v2/assets/{assetId}`, `/api/v2/assets/{assetId}/variants`,
`/api/v2/variants`, `/api/v2/variants/{chain}/{address}`, `/api/v2/chains`)
addresses every token as `<chain>:<address>` across Solana, Ethereum, Base,
Arbitrum, Polygon and BNB Smart Chain. It is backed by three new tables keyed
by `(chain, address)` that three worker jobs populate. Nothing touches a v1
table: v1 keeps serving Solana exactly as before, and v2's Solana data is a
copy of v1's.

Migration: `db/migrations/0033_v2_asset_variants.sql` (apply via the one-off
Cloud Run migration job **before** promoting the image that registers the
v2 reads and jobs). Chain list: `packages/asset-registry/src/chains.ts`.
Jobs: `apps/cloudrun-assets/src/handlers/crons.v2Assets.ts`; SQL:
`apps/cloudrun-assets/src/db/v2Assets.ts`; schedules:
`terraform/modules/env/crons_v2_assets.tf`.

## Data flow

```
v1 (unchanged, Solana only)                       v2 (migration 0033)
asset_variants ─────────────┐
variant_markets_latest ─────┤  sync-v2-solana-variants   ┌─> v2_asset_variants            (origin solana_v1)
asset_markets_latest ───────┘  (set-based mirror, 5 min) ├─> v2_variant_markets_latest    (origin solana_v1)
                                                         └─> v2_asset_chain_markets_latest (origin solana_v1, chain='solana')

assets.coingecko_id + coingecko_coins.platforms ──┐
AGGREGATE_COIN_IDS (usd, bitcoin, …)              ├─ sync-v2-evm-variants ──> v2_asset_variants (origin coingecko)
NATIVE_COIN_DEPLOYMENTS (0xeeee…, WETH/WBNB/WPOL) ┘  (daily)                  v2_asset_variants (origin config)

Birdeye token-overview, one client per chain ── refresh-v2-evm-variant-markets ──> v2_variant_markets_latest (origin birdeye)
  (x-chain = CHAINS[chain].providers.birdeyeChain)   (stale-first, 15 min)

api  GET /api/v2/assets, /assets/{id}, /assets/{id}/variants, /variants, /variants/{chain}/{address}, /chains
     → cloudrun-assets v2Assets* reads: v2_asset_variants LEFT JOIN v2_variant_markets_latest;
       Solana per-asset stats from v2_asset_chain_markets_latest; EVM per-chain rollups computed from
       v2_variant_markets_latest at read time (origin='computed' is reserved for a worker rollup).
```

## Ownership (`origin`)

A job only ever updates or deactivates rows it wrote, so the three never fight
and a bad run cannot damage another origin's rows:

| origin      | table(s)                      | writer                         |
| ----------- | ----------------------------- | ------------------------------ |
| `solana_v1` | all three                     | sync-v2-solana-variants        |
| `coingecko` | v2_asset_variants             | sync-v2-evm-variants           |
| `config`    | v2_asset_variants             | sync-v2-evm-variants (natives) |
| `birdeye`   | v2_variant_markets_latest     | refresh-v2-evm-variant-markets |
| `admin`     | v2_asset_variants             | reserved, unused               |
| `computed`  | v2_asset_chain_markets_latest | reserved, unused               |

The upserts carry `WHERE <table>.origin = '<own origin>'` guards; a row that
exists under another origin is reported as `skippedOwned` and left alone.
Derived rows are only ever soft-deactivated (`is_active=false`), never deleted.

## Jobs

All three live in the `v2_assets_jobs_disabled` job group on the worker: they
are registered when `BIRDEYE_API_KEY` is set (the same gate as every other
Birdeye cron), need no new secrets or env, and answer `404
{"error":"v2_assets_jobs_disabled"}` otherwise. Schedules are in
`terraform/modules/env/crons_v2_assets.tf`; invoke by hand with `POST
/jobs/<name>` on the worker via the scheduler invoker (see `scripts/_jobs.mjs`
for the identity token).

### sync-v2-solana-variants

Three idempotent set-based statements, no provider calls: upsert every
`asset_variants` row with `chain='solana'` (active or not; DISTINCT ON
`(asset_id, mint)`, active row wins) into `v2_asset_variants` with
`last_seen_at = run start`, then deactivate `solana_v1` rows no run has seen
(hard-deleted in v1); copy `variant_markets_latest` rows whose
`last_fetched_at` / `overview_last_fetched_at` changed; copy
`asset_markets_latest` into the `chain='solana'` rollup rows. Overlapping runs
are safe: an older run (smaller `last_seen_at`) can never overwrite a newer
one. A failed variants mirror aborts the run (`ok:false`, `reason:
mirror_failed`); a failed markets or rollups copy keeps `ok:true` with
`partial:true` and `failed:["markets"|"rollups"]` (the next tick repairs it).

Args: none (`{}`). Schedule: prd `3-58/5 * * * *`, stg `*/30 * * * *`;
deadline 180 s, no retry (the next tick is 5 min away).

Result: `processed` (inserted + updated), `variantsInserted`,
`variantsUpdated`, `variantsDeactivated`, `marketsWritten`, `rollupsWritten`,
`partial`, `failed`. Steady state is a handful of `variantsUpdated` (every
v1 row is re-stamped) and `marketsWritten` ≈ the number of Solana mints the
v1 refresh touched since the last tick.

Log: one `event:"v2_solana_sync"` line per run with the same fields plus `ok`,
`reason`, `duration_ms`.

### sync-v2-evm-variants

Derives EVM variants for every active, non-tombstoned asset with a
`coingecko_id` (not only curated ones: curation is list membership, not
identity) from `coingecko_coins.platforms` (CoinGecko platform id →
contract), plus `AGGREGATE_COIN_IDS` (several coin ids under one canonical
such as `usd`) and `NATIVE_COIN_DEPLOYMENTS` (native coin + canonical wrapped
token per chain, `origin='config'`). Identity only; markets come from the
refresh below. Kind: `stablecoin` / `lst` / `tokenized_equity` by asset
category, otherwise `native` when the coin's home platform is that chain and
`bridged` elsewhere; aggregates use `stablecoin` / `spot` / `wrapped`. Trust
tier `tier3`, tags `coingecko-derived` + `coin:<id>` (or `native-coin`).
Addresses are lowercased; invalid ones are counted as `skippedInvalid`.

Deactivation (never deletion) happens only when the asset is no longer active
/ registered / linked to a coin id, or when the coin row is fresh (synced in
the last 15 days, two weekly coin-list cadences plus slack) and no longer
lists the chain. Rows whose coin row is stale are kept and counted as
`keptStale` (a stale coin list must never remove a variant).

| arg         | default         | range   | meaning                                             |
| ----------- | --------------- | ------- | --------------------------------------------------- |
| `chains`    | every EVM chain | EVM ids | subset of chain ids to derive; `solana` is rejected |
| `dryRun`    | false           | bool    | compute and log the plan, write nothing             |
| `maxAssets` | 5000            | 1–50000 | assets with a coingecko_id scanned per run          |

Schedule: `10 6 * * *` both envs; deadline 540 s, one retry.

Result: `processed` (assets scanned), `dryRun`, `chains`,
`assetsWithVariants`, `desired`, `inserted`, `updated`, `skippedOwned`,
`skippedInvalid`, `deactivated` (in a dry run: what would be deactivated),
`keptStale`, `failed`, `byChain` (`{ <chain>: { desired } }`), `partial`.

Log: `event:"v2_evm_variants_sync"` per run (same fields plus `assetsScanned`,
`duration_ms`); `event:"v2_evm_variants_kept_stale"` with `keptStale` when
any row was kept because its coin row is stale (a warning, not a failure).

### refresh-v2-evm-variant-markets

Stale-first Birdeye token-overview refresh for EVM variants, one Birdeye
client per chain (`x-chain` = `CHAINS[chain].providers.birdeyeChain`). Default
`chains` = every EVM chain with `capabilities.markets` and a Birdeye slug.
Selects distinct `(chain, address)` of active variants on active assets whose
snapshot is missing or older than `minAgeMs`, stalest first (curated rank
only breaks ties), skipping the EIP-7528 native address. Rows Birdeye has
nothing for are stamped (`touchVariantMarket`) so the batch keeps moving
through the tail; Birdeye decimals are written through into derived variants
that had none from CoinGecko. A chain attempted ≥3 times with zero successes
in a run is listed in `downChains` and flips the run to `ok:false` so one
chain's outage cannot hide behind a healthy one.

| arg           | default         | range      | meaning                                              |
| ------------- | --------------- | ---------- | ---------------------------------------------------- |
| `chains`      | markets-capable | EVM ids    | subset of chain ids; `solana` is rejected            |
| `maxVariants` | 250             | 1–1000     | (chain, address) pairs per run                       |
| `minAgeMs`    | 600000          | 0–86400000 | skip rows fetched more recently than this            |
| `concurrency` | 2               | 1–5        | pool lanes (the Birdeye key is shared with v1 crons) |
| `delayMs`     | 150             | 0–5000     | pacing between items                                 |
| `budgetMs`    | 500000          | 0–3600000  | whole-run deadline; 0 = none                         |

Schedule: prd `7-59/15 * * * *` with `minAgeMs 900000` and `maxVariants 400`
(every row with data about once per tick), stg `20 3 * * *`; deadline 540 s,
no retry.

Every row written in one run is stamped with the run's start time, not the
time of its own fetch, so all rows refreshed together share one
`lastFetchedAt` to the millisecond. A row's expected maximum age is therefore
`minAgeMs` plus one schedule interval (today 15 + 15 = 30 min; it was 75 min
while `minAgeMs` was one hour, which looked like a stall in the 2026-10-22
audit). The served `market.lastFetchedAt` moves only on a successful Birdeye
write; touches bump `overviewLastFetchedAt` only. The alert
`assets-v2-evm-markets-refresh-silent` fires when no run has refreshed at
least one row in 45 minutes.

Result: `processed`, `refreshed`, `failed` (Birdeye empty + thrown),
`noClient` (chain without a client), `byChain`
(`{ <chain>: { attempted, refreshed, failed, noClient } }`), `downChains`,
`partial` (budget or shutdown cut the batch short).

Log: `event:"v2_evm_markets_refresh"` per run (same fields plus `ok`,
`duration_ms`); `event:"v2_evm_markets_chain_down"` with `chains` and
`byChain` whenever `downChains` is non-empty.

## Alerts

- `alert-rules/assets-v2-solana-sync-stale.json`: no `v2_solana_sync` with
  `ok=true` in 30 min (six missed prd ticks). v2 lags v1; v1 is unaffected.
- `alert-rules/assets-v2-evm-variants-sync-stale.json`: no
  `v2_evm_variants_sync` in 26 h (the daily run and its retry both missed).
- `alert-rules/assets-v2-evm-markets-chain-down.json`: any
  `v2_evm_markets_chain_down` in the last hour. Check Birdeye `external_call`
  lines for that chain first.

## SQL inspections

Parity between v1 and the mirror (both counts should match; a difference of a
few rows right after a v1 admin edit closes on the next tick):

```sql
SELECT (SELECT count(*) FROM (SELECT DISTINCT asset_id, mint FROM asset_variants WHERE chain = 'solana') s) AS v1_pairs,
       (SELECT count(*) FROM v2_asset_variants WHERE origin = 'solana_v1') AS v2_rows,
       (SELECT count(*) FROM asset_variants WHERE chain = 'solana' AND is_active) AS v1_active,
       (SELECT count(*) FROM v2_asset_variants WHERE origin = 'solana_v1' AND is_active) AS v2_active;

-- v1 rows missing from v2 (should be empty once a tick has run)
SELECT av.asset_id, av.mint FROM asset_variants av
LEFT JOIN v2_asset_variants v ON v.chain = 'solana' AND v.address = av.mint AND v.asset_id = av.asset_id
WHERE av.chain = 'solana' AND v.chain IS NULL;

-- market + rollup parity
SELECT (SELECT count(*) FROM variant_markets_latest WHERE mint NOT LIKE '0x%') AS v1_markets,
       (SELECT count(*) FROM v2_variant_markets_latest WHERE origin = 'solana_v1') AS v2_markets,
       (SELECT count(*) FROM asset_markets_latest) AS v1_rollups,
       (SELECT count(*) FROM v2_asset_chain_markets_latest WHERE chain = 'solana') AS v2_rollups;
```

Per-chain shape:

```sql
SELECT chain, origin, is_active, count(*) FROM v2_asset_variants GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;

SELECT chain, origin, count(*),
       count(*) FILTER (WHERE price IS NULL) AS no_price,
       count(*) FILTER (WHERE holder IS NULL) AS no_holder,
       to_timestamp(min(overview_last_fetched_at) / 1000) AS oldest_fetch
FROM v2_variant_markets_latest GROUP BY 1, 2 ORDER BY 1, 2;

-- which chains the `usd` aggregate landed on
SELECT chain, address, label, kind, is_active FROM v2_asset_variants WHERE asset_id = 'usd' ORDER BY chain, address;
```

Invariants (all should return zero rows / zero):

```sql
-- native EIP-7528 rows never get a market snapshot; the wrapped token carries the coin's market
SELECT * FROM v2_variant_markets_latest WHERE address = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
SELECT v.chain, v.label, m.price IS NOT NULL AS has_market
FROM v2_asset_variants v LEFT JOIN v2_variant_markets_latest m ON m.chain = v.chain AND m.address = v.address
WHERE v.origin = 'config' AND v.kind = 'wrapped';           -- expect has_market = true for WETH / WBNB / WPOL after a refresh

-- EVM addresses are stored lowercase (the CHECK rejects EIP-55 casing; belt and braces)
SELECT count(*) FROM v2_asset_variants WHERE address LIKE '0x%' AND address <> lower(address);
SELECT count(*) FROM v2_variant_markets_latest WHERE address LIKE '0x%' AND address <> lower(address);
```

## Rollout

1. Apply `db/migrations/0033_v2_asset_variants.sql` via the one-off Cloud Run
   migration job (stg, then prd) **before** promoting the image. Additive and
   idempotent; nothing reads the tables until the new image is live.
2. Promote the cloudrun-assets image (API service + jobs worker) and apply
   terraform so the three scheduler jobs exist.
3. Dispatch `sync-v2-solana-variants` by hand with `{}` and run the parity SQL
   above; `variantsInserted` should equal the v1 pair count on the first run.
4. `sync-v2-evm-variants` with `{"dryRun":true}`: read `desired`, `byChain`,
   `skippedInvalid`, `deactivated`; then run it for real and compare
   `inserted` to the dry-run `desired`.
5. `refresh-v2-evm-variant-markets` with `{}` (or a small `maxVariants`):
   check `byChain` has `refreshed > 0` on every chain and `downChains` is
   empty; re-run the per-chain shape SQL.
6. Only then enable `GET /api/v2/*` consumers; the endpoints are live as soon
   as the image is, serving whatever the tables hold.

## Rollback

- Hide the EVM surface without touching the mirror:
  `UPDATE v2_asset_variants SET is_active = false WHERE origin IN ('coingecko', 'config');`
  (the next `sync-v2-evm-variants` run re-activates them, so pause its
  scheduler job first).
- Pausing `sync-v2-solana-variants` freezes v2's Solana data at its last copy
  rather than emptying it; v1 keeps serving.
- The three v2 tables can be dropped without touching any v1 table or job; the
  v2 endpoints then error until the migration is re-applied.

## Adding a chain

One `CHAINS` entry in `packages/asset-registry/src/chains.ts` (plus its id in
`CHAIN_KINDS`): `caip2`, `family`, `evmChainId`, `label`, `explorer`,
`providers` (`coingeckoPlatform` for derivation, `birdeyeChain` for markets,
`webacyChain` for risk) and `capabilities`. The compiler rejects a partial
entry. Optionally register the native coin as an asset and add its
`NATIVE_COIN_DEPLOYMENTS` entry (EIP-7528 address + canonical wrapped token)
in `src/data/chain-deployments.ts`. No DDL (chain ids are shape-checked, not
enumerated) and no terraform: the jobs default to every EVM chain, and the
daily derivation picks the new chain up on its next run.

## Birdeye EVM caveats

- `holder` is mostly absent on EVM overviews; `price` is missing on a share of
  Ethereum rows (long-tail contracts). Both land as NULL rather than 0, so
  consumers must treat a missing price as unknown, not free.
- The EIP-7528 native address is skipped on purpose: Birdeye answers it with
  the wrapped token's identity and made-up liquidity. The wrapped variant
  (WETH / WBNB / WPOL, `origin='config'`) carries the coin's market.
- Decimals are never defaulted to 9 off-Solana (v1's `birdeyeOverviewToUpsert`
  does that for mints). Derived variants get decimals from CoinGecko's
  `detail_platforms` when the per-coin metadata was fetched
  (`refresh-curated-coingecko-metadata`), else NULL until Birdeye returns them
  and the refresh writes them through; natives are 18.
- The Birdeye key is shared with the v1 Solana crons; keep `concurrency` ≤ 2
  and `delayMs` ≥ 150 unless the plan changes.

## Local verification

`bun run dev:run-worker-job <job> '<json>'` runs one job in-process against
`DATABASE_URL` from `apps/cloudrun-assets/.env.local` (Birdeye key from there
or `apps/api/.env.local`; without one the market refresh reports `noClient`
for every chain):

```
bun run dev:run-worker-job sync-v2-solana-variants
bun run dev:run-worker-job sync-v2-evm-variants '{"dryRun":true}'
bun run dev:run-worker-job sync-v2-evm-variants
bun run dev:run-worker-job refresh-v2-evm-variant-markets '{"maxVariants":50,"chains":["base"]}'
```

The result JSON matches the deployed job response; the summary log lines are
the same ones the alerts key off.
