-- 0033: chain-first tables for the v2 multichain assets API.
--
-- Why: v1 models a variant as a bare Solana mint (`asset_variants.mint`,
-- `variant_markets_latest.mint`). The v2 surface (`GET /api/v2/assets`,
-- `/api/v2/variants/{chain}/{address}`) addresses every token as
-- `<chain>:<address>` across Solana, Ethereum, Base, Arbitrum, Polygon and
-- BNB Smart Chain. Rather than widening v1's unique keys in place (which would
-- need a runtime readiness gate while old and new workers overlap), v2 owns
-- three new tables keyed by (chain, address). Nothing here touches a v1 table;
-- v1 keeps serving Solana exactly as before.
--
-- Who writes what (`origin` column; a job only ever updates rows it owns):
--   solana_v1  sync-v2-solana-variants mirrors active+inactive Solana rows from
--              asset_variants / variant_markets_latest / asset_markets_latest
--              every few minutes (exact v1 parity by copy; admin edits and the
--              Birdeye refresh keep flowing through v1 until it retires).
--   coingecko  sync-v2-evm-variants derives EVM variants for registered assets
--              from coingecko_coins.platforms.
--   config     native coins (EIP-7528 0xeeee… + WETH/WBNB/WPOL) from the
--              registry's NATIVE_COIN_DEPLOYMENTS table.
--   birdeye    refresh-v2-evm-variant-markets writes per-chain Birdeye
--              token-overview snapshots for EVM variants.
--   admin      reserved for a future v2 admin write path (unused).
--
-- Chain ids are shape-checked only, so adding a chain is a code change
-- (packages/asset-registry/src/chains.ts), never DDL. EVM addresses are stored
-- lowercase (the CHECK rejects EIP-55 casing); Solana addresses are base58.
--
-- Apply manually (db/apply.sh), stg then prd, BEFORE promoting the worker /
-- API image that registers the v2Assets* reads. Additive and idempotent.
-- Runbook: docs/operations/v2-multichain-assets.md

CREATE TABLE IF NOT EXISTS v2_asset_variants (
    chain               text        NOT NULL CHECK (chain ~ '^[a-z][a-z0-9-]{1,31}$'),
    address             text        NOT NULL CHECK (address <> '' AND (address NOT LIKE '0x%' OR address = lower(address))),
    asset_id            text        NOT NULL,
    -- v1 variant_id for mirrored Solana rows; '<chain>:<address>' for derived rows.
    variant_id          text        NOT NULL,
    kind                text        NOT NULL,
    trust_tier          text        NOT NULL,
    stock_variant_tier  text,
    tags                jsonb       NOT NULL DEFAULT '[]'::jsonb,
    label               text,
    issuer              text,
    issuer_url          text,
    decimals            integer,
    origin              text        NOT NULL CHECK (origin IN ('solana_v1', 'coingecko', 'config', 'admin')),
    -- v1 asset_variants.source passthrough (registry | admin | coingecko | NULL).
    source              text,
    is_active           boolean     NOT NULL DEFAULT true,
    first_seen_at       bigint      NOT NULL,
    last_seen_at        bigint      NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    -- The same address may legitimately back two assets (registry
    -- MINT_HOME_OVERRIDES on Solana; an aggregate canonical such as `usd` plus
    -- the coin's own asset on EVM), so the key includes asset_id.
    PRIMARY KEY (chain, address, asset_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS v2_asset_variants_by_asset_variant
    ON v2_asset_variants (asset_id, variant_id);
CREATE INDEX IF NOT EXISTS v2_asset_variants_by_asset_active
    ON v2_asset_variants (asset_id, is_active, chain);
CREATE INDEX IF NOT EXISTS v2_asset_variants_by_chain_active
    ON v2_asset_variants (chain, is_active);
CREATE INDEX IF NOT EXISTS v2_asset_variants_by_origin
    ON v2_asset_variants (origin, is_active);

-- Per-(chain, address) market snapshot. Column-for-column the same metric
-- columns as variant_markets_latest (0006) minus the synthetic id, plus
-- chain/origin, so the Solana mirror is a plain INSERT ... SELECT and the
-- existing market-source selector (handlers/marketSourceSelection.ts) applies
-- unchanged to every chain.
CREATE TABLE IF NOT EXISTS v2_variant_markets_latest (
    chain                       text        NOT NULL CHECK (chain ~ '^[a-z][a-z0-9-]{1,31}$'),
    address                     text        NOT NULL CHECK (address <> '' AND (address NOT LIKE '0x%' OR address = lower(address))),
    source                      text        NOT NULL,
    metrics_source              text,
    birdeye_metrics             jsonb,
    rwa_metrics                 jsonb,
    clickhouse_metrics          jsonb,
    symbol                      text,
    name                        text,
    decimals                    integer,
    logo_uri                    text,
    price                       double precision,
    liquidity                   double precision,
    volume_5m_usd               double precision,
    volume_15m_usd              double precision,
    volume_1h_usd               double precision,
    volume_6h_usd               double precision,
    volume_24h_usd              double precision,
    trade_5m                    double precision,
    trade_15m                   double precision,
    trade_1h                    double precision,
    trade_6h                    double precision,
    trade_24h                   double precision,
    unique_wallet_5m            double precision,
    unique_wallet_1h            double precision,
    unique_wallet_24h           double precision,
    market_cap                  double precision,
    fdv                         double precision,
    price_change_24h_percent    double precision,
    price_change_1h_percent     double precision,
    holder                      double precision,
    total_supply                double precision,
    circulating_supply          double precision,
    last_trade_human_time       text,
    extensions                  jsonb,
    as_of                       double precision,
    last_trade_at               double precision,
    last_fetched_at             bigint      NOT NULL,
    overview_last_fetched_at    bigint,
    origin                      text        NOT NULL CHECK (origin IN ('solana_v1', 'birdeye')),
    created_at                  timestamptz NOT NULL DEFAULT now(),
    updated_at                  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (chain, address)
);

-- Stale-first selection for the per-chain EVM refresh.
CREATE INDEX IF NOT EXISTS v2_variant_markets_latest_by_chain_overview_fetched
    ON v2_variant_markets_latest (chain, overview_last_fetched_at NULLS FIRST, address);

-- Per-(asset, chain) rollup. chain='solana' rows mirror asset_markets_latest
-- (so v2's Solana liquidity / 24h / 30d volume equal v1's `asset.stats`);
-- other chains are computed from v2_variant_markets_latest by the API for now
-- (origin='computed' is reserved for a worker rollup).
CREATE TABLE IF NOT EXISTS v2_asset_chain_markets_latest (
    asset_id            text        NOT NULL,
    chain               text        NOT NULL CHECK (chain ~ '^[a-z][a-z0-9-]{1,31}$'),
    liquidity           double precision NOT NULL,
    volume_24h_usd      double precision NOT NULL,
    volume_30d_usd      double precision,
    primary_address     text,
    variant_count       integer     NOT NULL DEFAULT 0,
    last_computed_at    bigint      NOT NULL,
    origin              text        NOT NULL CHECK (origin IN ('solana_v1', 'computed')),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, chain)
);

CREATE INDEX IF NOT EXISTS v2_asset_chain_markets_latest_by_chain
    ON v2_asset_chain_markets_latest (chain, asset_id);

INSERT INTO schema_migrations (version) VALUES ('0033_v2_asset_variants') ON CONFLICT DO NOTHING;
