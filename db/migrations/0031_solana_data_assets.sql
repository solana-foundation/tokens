-- Project Canon asset registry (data.solana.com/v1/assets), synced hourly by the
-- cloudrun-assets `sync-solana-data-assets` job and served as GET /api/v2/registry.
-- One row per mint in the `<source>_latest` pattern (see 0021_launchpad_tokens):
-- the upstream row order (`source_rank`) is preserved verbatim because their
-- query already sorts by coalesce(Allium value, RWA.xyz value) desc, then market cap.
-- `provider_*` is the Birdeye meta-data fallback for mints the platform does not
-- index; the hourly upsert never touches those columns.
CREATE TABLE IF NOT EXISTS solana_data_assets_latest (
    mint                      text PRIMARY KEY,
    symbol                    text NOT NULL,
    group_name                text,
    category                  text,
    asset_class               text,
    allium_asset_class        text,
    rwa_asset_class           text,
    allium_asset_value_usd    double precision,
    rwa_asset_value_usd       double precision,
    coingecko_market_cap_usd  double precision,
    source_rank               integer NOT NULL,
    source_generated_at       timestamptz NOT NULL,
    raw_json                  text NOT NULL,
    provider_name             text,
    provider_logo_uri         text,
    provider_fetched_at       bigint,
    is_active                 boolean NOT NULL DEFAULT true,
    last_seen_at              bigint NOT NULL,
    last_synced_at            bigint NOT NULL,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS solana_data_assets_latest_active_rank
    ON solana_data_assets_latest (is_active, source_rank);

INSERT INTO schema_migrations(version) VALUES ('0031_solana_data_assets')
ON CONFLICT DO NOTHING;
