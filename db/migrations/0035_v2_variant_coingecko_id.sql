-- 0035: per-variant CoinGecko coin ids + the audit table for asset coin ids.
--
-- Why: an asset links to one CoinGecko coin (`assets.coingecko_id`), but its
-- variants are often other CoinGecko coins: Ondo / Backpack / xStock issues of
-- one equity, each LST, each BTC wrapper. CoinGecko carries per-coin supply,
-- cap and EVM deployments for those that we never read because nothing links
-- a variant to its coin. `v2_asset_variants.coingecko_id` is that link,
-- written by (precedence high → low) an admin edit, the EVM derivation for
-- rows it creates, or the set-based resolver that matches a row's address to
-- `coingecko_coins.platforms` (`coingecko_id_source` records which).
--
-- The EVM platform indexes mirror 0034's Solana one so the resolver and the
-- validator can point-read a coin by contract on every chain we ingest;
-- lower() because CoinGecko does not guarantee address casing.
--
-- `asset_coingecko_id_audit` is the report of the weekly validate-coingecko-ids
-- job: one row per active asset with a status (ok | suspect | repaired |
-- assigned | needsAdmin | unresolved), the id it saw, the id it chose and the
-- candidates it considered. Read by humans / the admin app; never by the API.
--
-- Apply manually (db/apply.sh), stg then prd, BEFORE deploying the worker
-- image that writes the column (the reads tolerate its absence only until
-- then). Additive and idempotent. Runbook: docs/operations/v2-multichain-assets.md

ALTER TABLE v2_asset_variants
    ADD COLUMN IF NOT EXISTS coingecko_id text,
    ADD COLUMN IF NOT EXISTS coingecko_id_source text
        CHECK (coingecko_id_source IS NULL OR coingecko_id_source IN ('derived', 'resolved', 'admin'));

CREATE INDEX IF NOT EXISTS v2_asset_variants_by_coingecko_id
    ON v2_asset_variants (coingecko_id)
    WHERE coingecko_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS coingecko_coins_by_ethereum_contract ON coingecko_coins ((lower(platforms->>'ethereum')));
CREATE INDEX IF NOT EXISTS coingecko_coins_by_base_contract     ON coingecko_coins ((lower(platforms->>'base')));
CREATE INDEX IF NOT EXISTS coingecko_coins_by_arbitrum_contract ON coingecko_coins ((lower(platforms->>'arbitrum-one')));
CREATE INDEX IF NOT EXISTS coingecko_coins_by_polygon_contract  ON coingecko_coins ((lower(platforms->>'polygon-pos')));
CREATE INDEX IF NOT EXISTS coingecko_coins_by_bnb_contract      ON coingecko_coins ((lower(platforms->>'binance-smart-chain')));

CREATE TABLE IF NOT EXISTS asset_coingecko_id_audit (
    asset_id      text        PRIMARY KEY,
    status        text        NOT NULL CHECK (status IN ('ok', 'suspect', 'repaired', 'assigned', 'needsAdmin', 'unresolved')),
    current_id    text,
    suggested_id  text,
    candidates    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    note          text,
    checked_at    bigint      NOT NULL,
    updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('0035_v2_variant_coingecko_id') ON CONFLICT DO NOTHING;
