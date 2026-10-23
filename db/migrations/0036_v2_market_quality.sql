-- 0036: market-row freshness bookkeeping + per-variant daily volume samples.
--
-- Why (freshness): refresh-v2-evm-variant-markets "touches" a row when
-- Birdeye has nothing for it, bumping overview_last_fetched_at so the batch
-- moves on. The served snapshot keeps the last metrics and the stale-set query
-- cannot tell "fetched fine" from "empty again", so ~200 dead xStock
-- deployments were re-fetched every tick alongside rows with data.
-- `last_empty_at` records the last empty answer; the selector keeps such rows
-- on a slower cadence (`emptyMinAgeMs`) and the API's quality guard reads the
-- blob's own lastFetchedAt (last successful write) for staleness.
--
-- Why (volume): 30d volume was Solana-only (v1 ohlcv_candles). Birdeye's
-- EVM token_overview carries a trailing 24h volume per fetch; keeping the last
-- sample of each UTC day per (chain, address) lets a daily job roll 30 days
-- into v2_asset_chain_markets_latest.volume_30d_usd (origin 'computed') with
-- `volume_30d_days` saying how many days contributed, so the API can serve
-- null until the window is complete.
--
-- Apply manually (db/apply.sh), stg then prd, BEFORE deploying the worker
-- image that writes these columns. Additive and idempotent.
-- Runbook: docs/operations/v2-multichain-assets.md

ALTER TABLE v2_variant_markets_latest ADD COLUMN IF NOT EXISTS last_empty_at bigint;

CREATE TABLE IF NOT EXISTS v2_variant_volume_daily (
    chain           text             NOT NULL,
    address         text             NOT NULL,
    day             date             NOT NULL,
    volume_24h_usd  double precision NOT NULL,
    -- ms epoch of the Birdeye fetch this sample came from (last sample of the day wins).
    sampled_at      bigint           NOT NULL,
    PRIMARY KEY (chain, address, day)
);

CREATE INDEX IF NOT EXISTS v2_variant_volume_daily_by_day ON v2_variant_volume_daily (day);

ALTER TABLE v2_asset_chain_markets_latest ADD COLUMN IF NOT EXISTS volume_30d_days integer;
-- address -> 30d volume for the variants behind a computed row, so the API can
-- leave out the share of any row its quality guard rejects.
ALTER TABLE v2_asset_chain_markets_latest ADD COLUMN IF NOT EXISTS volume_30d_by_address jsonb;

INSERT INTO schema_migrations (version) VALUES ('0036_v2_market_quality') ON CONFLICT DO NOTHING;
