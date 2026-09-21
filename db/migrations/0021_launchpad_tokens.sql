-- 0021_launchpad_tokens.sql
-- Launchpad coin snapshots (stonk.fun first): coins launched against a quote
-- token we curate, surfaced on that quote asset's page ("Launched on NVDAx").
--
-- One row per (launchpad, mint), refreshed by the `sync-stonkfun-launches`
-- job in cloudrun-assets. Rows are soft-deleted (`is_active = false`) when the
-- provider stops returning them or they fall under the display threshold.
--
-- Invariant: a row is activated only after the coin has both a `tokens` row
-- (identity: symbol/name/decimals/logo) and a `variant_markets_latest` row
-- (market snapshot), because the coin's tokens.xyz page is the existing
-- singleton-asset path (`solana-<mint>`) built from exactly those two tables.
-- The provider payload carries no decimals, so identity is fetched once per
-- new mint from Birdeye by the sync job; the regular stale-refresh crons keep
-- both rows fresh afterwards.

CREATE TABLE launchpad_tokens_latest (
    id                text PRIMARY KEY,
    launchpad         text NOT NULL,
    mint              text NOT NULL,
    quote_mint        text NOT NULL,
    quote_symbol      text,
    symbol            text,
    name              text,
    logo_uri          text,
    pool              text,
    status            text,
    mode              text,
    creator           text,
    price_usd         double precision,
    market_cap_usd    double precision,
    fdv_usd           double precision,
    liquidity_usd     double precision,
    volume_24h_usd    double precision,
    price_change_24h  double precision,
    launched_at       bigint,
    graduated_at      bigint,
    links_json        text,
    source_rank       integer NOT NULL,
    raw_json          text NOT NULL,
    is_active         boolean NOT NULL,
    last_seen_at      bigint NOT NULL,
    last_synced_at    bigint NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX launchpad_tokens_latest_by_launchpad_mint
    ON launchpad_tokens_latest (launchpad, mint);
CREATE INDEX launchpad_tokens_latest_by_quote_active_volume
    ON launchpad_tokens_latest (quote_mint, is_active, volume_24h_usd DESC);
CREATE INDEX launchpad_tokens_latest_by_launchpad_active_rank
    ON launchpad_tokens_latest (launchpad, is_active, source_rank);

INSERT INTO schema_migrations(version) VALUES ('0021_launchpad_tokens');
