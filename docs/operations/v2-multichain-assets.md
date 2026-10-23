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
| `computed`  | v2_asset_chain_markets_latest | rollup-v2-chain-volume-30d     |

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

Step 0 links existing rows to their CoinGecko coin by address
(`resolveVariantCoinIds`: one set-based UPDATE per chain against
`coingecko_coins.platforms`, freshest coin row wins; only rows with no
`coingecko_id` or one the resolver wrote earlier; `coingecko_id_source` =
`resolved`). With `resolveOnly: true` the job stops there.

Then it derives EVM variants from every (asset, coin) source of each active,
non-tombstoned asset (not only curated ones: curation is list membership, not
identity): the asset's reference coin (`assets.coingecko_id`, role
`reference`) and every distinct coin its active variants link to (role
`variant`: an Ondo / Backpack / xStock issue, a wrapper), reading
`coingecko_coins.platforms` (CoinGecko platform id → contract); plus
`AGGREGATE_COIN_IDS` (several coin ids under one canonical such as `usd`) and
`NATIVE_COIN_DEPLOYMENTS` (native coin + canonical wrapped token per chain,
`origin='config'`). A variant coin only contributes when the linking variant
resolves to `issuance: native` (an LST's or ETF's other-chain copies are not
the asset's supply; counted as `coinSourcesSkipped`); at most
`MAX_COIN_SOURCES_PER_ASSET` (8) coins per asset (`coinSourcesCapped`).
Sources are visited reference first, then coin id order, so when two coins
list the same (chain, address) the first wins deterministically
(`coinConflicts`). Identity only; markets come from the refresh below.

Kind: an equity / stablecoin source variant pins `tokenized_equity` /
`stablecoin`; otherwise `stablecoin` / `lst` / `tokenized_equity` by asset
category, otherwise `native` when the coin's home platform is that chain and
`bridged` elsewhere; aggregates use `stablecoin` / `spot` / `wrapped`. Trust
tier `tier3`, tags `coingecko-derived` + `coin:<id>` + `issuer:<label>` for
variant-sourced rows (or `native-coin`). Every derived row carries its coin
in `coingecko_id` (`coingecko_id_source = derived`; an admin-set id is never
overwritten); native config rows carry the asset's reference id. Addresses
are lowercased; invalid ones are counted as `skippedInvalid`.

Deactivation (never deletion) happens only when the asset is no longer active
/ registered / linked to a coin id, or when the coin row is fresh (synced in
the last 15 days, two weekly coin-list cadences plus slack) and no longer
lists the chain. Rows whose coin row is stale are kept and counted as
`keptStale` (a stale coin list must never remove a variant).

| arg         | default         | range   | meaning                                             |
| ----------- | --------------- | ------- | --------------------------------------------------- |
| `chains`      | every EVM chain | EVM ids | subset of chain ids to derive; `solana` is rejected |
| `dryRun`      | false           | bool    | compute and log the plan, write nothing (skips step 0 too) |
| `maxAssets`   | 5000            | 1–50000 | assets with at least one coin source scanned per run |
| `resolveOnly` | false           | bool    | run step 0 (coin-id resolution) and stop            |

Schedule: `10 6 * * *` both envs; deadline 540 s, one retry.

Result: `processed` (assets scanned), `dryRun`, `chains`,
`assetsWithVariants`, `desired`, `inserted`, `updated`, `skippedOwned`,
`skippedInvalid`, `deactivated` (in a dry run: what would be deactivated),
`keptStale`, `failed`, `byChain` (`{ <chain>: { desired } }`), `resolved`
(`{ <chain>: rows linked }`), `coinSources`, `coinSourcesSkipped`,
`coinSourcesCapped`, `coinConflicts`, `partial`.

Log: `event:"v2_evm_variants_sync"` per run (same fields plus `assetsScanned`,
`duration_ms`); `event:"v2_evm_variants_kept_stale"` with `keptStale` when
any row was kept because its coin row is stale (a warning, not a failure).

### validate-coingecko-ids (CoinGecko job group)

`assets.coingecko_id` was never validated: the registry used to generate
`${slug}-xstock` by convention and a third of those ids did not exist on
CoinGecko. Weekly (`30 5 * * 0`, after the Sunday coin-list sync; terraform
`crons_coingecko.tf`) and by hand after a seed, the job checks every active
asset's id against `coingecko_coins`. A missing or unknown id is resolved by
the asset's active Solana mints (`platforms.solana`), preferring
`-xstock` > `-ondo-tokenized-stock` > `-backpack-securities` > `-bstock`,
tie-broken by liquidity. The id and the asset's `coingeckoId` alias are
written only while the asset has never been admin-edited
(`assets.admin_edited_at IS NULL`); an id is never nulled. A known id that the
API remap changes (`bnb` → `binancecoin`) is persisted as the real id. An
equity / ETF whose coin lists a Solana contract that is not one of the asset's
mints is `suspect` (the `chewy` meme coin under the Chewy equity) and only
reported. Every asset gets a row in `asset_coingecko_id_audit`
(`status` ok | suspect | repaired | assigned | needsAdmin | unresolved,
`current_id`, `suggested_id`, `candidates`, `note`, `checked_at`).

Args: `write` (default true; false reports candidates as `needsAdmin` and
writes nothing), `maxAssets` (5000). Result / log event
`coingecko_id_validation`: `assets`, `statuses` (counts per status),
`writeFailed`, `auditWritten`; `ok:false` + `partial` when a write failed.

The price refresh (`refresh-curated-coingecko-prices`) reads
`getPriceCoinIdsInOrder()`: curated ids first, then every other active
asset's reference id, then the coin ids active variants link to, so
`coingecko_prices_latest` covers per-issuer / per-wrapper coins and
registered-but-not-curated assets (`maxCoins` 500 in prd). Metadata, tickers
and OHLCV stay curated-only.

### rollup-v2-chain-volume-30d

Cross-chain 30d volume. Every successful Birdeye write from the refresh
below also records that UTC day's sample in `v2_variant_volume_daily`
(migration 0036; the last sample of the day wins, since Birdeye's 24h volume
is a trailing window and a per-day max would double count the previous
day's tail). Daily at `25 0 * * *` this job sums the last 30 days per
(asset, chain) over the asset's active EVM variants into
`v2_asset_chain_markets_latest` with `origin='computed'` and
`volume_30d_days` (distinct sampled days), then prunes samples older than
`retentionDays` (45). Solana's 30d stays v1's candle rollup, mirrored as
`solana_v1`.

The API serves `stats.volume30dUSD` only when every chain with 24h volume has
a complete window (`solana_v1`, or `computed` with ≥ 28 days) and labels it
with `stats.volume30dScope` (`all` | `solana` | null); after this ships, EVM
assets show null for ~4 weeks while the samples accrue.

Args: `chains` (EVM ids, default all), `retentionDays` (31–365, default
45). Result / log event `v2_volume_30d_rollup`: `assetsWritten`,
`rowsWritten`, `pruned`; a failed prune is logged, not fatal.

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
| `emptyMinAgeMs` | 3600000       | 0–86400000 | same, for rows whose last Birdeye answer was empty (never below `minAgeMs`) |
| `concurrency` | 2               | 1–5        | pool lanes (the Birdeye key is shared with v1 crons) |
| `delayMs`     | 150             | 0–5000     | pacing between items                                 |
| `budgetMs`    | 500000          | 0–3600000  | whole-run deadline; 0 = none                         |

Schedule: prd `7-59/15 * * * *` with `minAgeMs 900000`, `emptyMinAgeMs
3600000` and `maxVariants 400` (every row with data about once per tick; the
~200 deployments Birdeye has nothing for, mostly xStock on Arbitrum, once an
hour), stg `20 3 * * *`; deadline 540 s, no retry.

A touch (migration 0036) records the empty answer in `last_empty_at` and
bumps `overview_last_fetched_at`, but leaves `last_fetched_at` at the last
successful write; the selector applies `emptyMinAgeMs` to rows whose
`last_empty_at` is at or after `last_fetched_at`. The API's quality guard
(`market.quality`, see the v2 docs) reads the blob's `lastFetchedAt` for
staleness: 2 h on Solana, 3 h on EVM.

Every row written in one run is stamped with the run's start time, not the
time of its own fetch, so all rows refreshed together share one
`lastFetchedAt` to the millisecond. A row's expected maximum age is therefore
`minAgeMs` plus one schedule interval (today 15 + 15 = 30 min; it was 75 min
while `minAgeMs` was one hour, which looked like a stall in the 2026-10-22
audit). The served `market.lastFetchedAt` moves only on a successful Birdeye
write; touches bump `overviewLastFetchedAt` only. The alert
`assets-v2-evm-markets-refresh-silent` fires when no run has refreshed at
least one row in the 45 minutes before the evaluation. It is an instant
Loki query on purpose: a range query would keep returning the last positive
count from earlier in its window and delay the page by the window length.

Result: `processed`, `refreshed`, `failed` (Birdeye empty + thrown),
`noClient` (chain without a client), `byChain`
(`{ <chain>: { attempted, refreshed, failed, noClient } }`), `downChains`,
`partial` (budget or shutdown cut the batch short).

Log: `event:"v2_evm_markets_refresh"` per run (same fields plus `ok`,
`duration_ms`); `event:"v2_evm_markets_chain_down"` with `chains` and
`byChain` whenever `downChains` is non-empty.

## How the API reads the tables

`GET /api/v2/assets/{id}` builds every figure from the full variant set
(blocked variants are hidden from `variants[]` on list surfaces but still
counted), after the quality guard (`apps/api/src/app/api/v1/assets/_market-quality.ts`):

- `chainStats.<chain>` / `aggregate`: guarded, issuance-aware on-chain sums
  (liquidity, DEX volume, trades over every included row; market cap, FDV and
  supply over `issuance: native` rows only; liquidity-weighted price and
  changes). The Solana rollup row is read for `volume30dUSD` only. A native
  coin's home-chain `0xeeee…` row (tag `native-home`) has no market and takes
  the asset's CoinGecko supply.
- `stats`: reference-first. CoinGecko (crypto) or the stock feed (public
  equities and ETFs, never commodities) supplies price, market cap, FDV, 24h
  change and supply; `aggregate` supplies liquidity, volume, trades, 1h change
  and whatever the reference lacks; `stats.source` names the origin per
  figure. Equities: company market cap, `fdv` null, tokenized supply.
- `referenceMarket`: only when the reference row exists (no all-null objects).

Commodities therefore need a CoinGecko id for a per-ounce reference
(`gold` → `pax-gold`, set in admin); their ETF mapping (GLD) is not used.

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

Market quality + daily volume (migration 0036, `db/migrations/0036_v2_market_quality.sql`):
apply (stg, then prd) before deploying the worker image that writes
`last_empty_at` and the daily volume samples; the API's guard needs no DDL.

Per-variant coin ids (migration 0035, `db/migrations/0035_v2_variant_coingecko_id.sql`):

1. Apply 0035 (stg, then prd) before promoting the worker / API image that
   selects `coingecko_id` from `v2_asset_variants`. Additive and idempotent.
2. Promote the image and apply terraform (adds the `validate-coingecko-ids`
   scheduler job, raises the price refresh to `maxCoins 500`).
3. If `sync-coingecko-coin-list` last ran more than a day ago, dispatch it.
4. `validate-coingecko-ids` with `{"write":false}` first: read `statuses` and
   `SELECT status, count(*) FROM asset_coingecko_id_audit GROUP BY 1`; then
   with `{}` to write. Expect most `*-xstock` ids to be `repaired`, Ondo /
   Backpack-only equities `assigned`, `chewy` `suspect` (fix in admin).
5. `sync-v2-evm-variants` with `{"resolveOnly":true}` (links the Solana mirror
   rows and existing EVM rows to coins; `resolved` per chain), then
   `{"dryRun":true}` to read `coinSources`, `desired`, `coinConflicts`, then
   `{}`. Expect roughly 200 new Ondo rows on Ethereum and BNB.
6. `refresh-v2-evm-variant-markets` catches the new rows up over a few ticks;
   the price refresh picks the new coin ids up on its next source reload
   (10 min TTL).

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
