-- In-house stablecoin peg guard: a second automated advisory source that prices
-- every curated `currencies` mint from Birdeye and derives a depeg tier from
-- below-peg deviation. Webacy's monitor covers only USDC/USDT/PYUSD on Solana
-- (verified 2026-09-14); the peg guard owns every other USD-pegged mint.
--
-- Postgres named the 0019 inline CHECKs <table>_source_check; confirm with
-- \d asset_variant_advisories on staging before applying to prod.

ALTER TABLE asset_variant_advisories
    DROP CONSTRAINT asset_variant_advisories_source_check,
    ADD CONSTRAINT asset_variant_advisories_source_check
        CHECK (source IN ('admin', 'webacy_depeg', 'peg_guard'));

ALTER TABLE asset_variant_advisory_events
    DROP CONSTRAINT asset_variant_advisory_events_source_check,
    ADD CONSTRAINT asset_variant_advisory_events_source_check
        CHECK (source IN ('admin', 'webacy_depeg', 'peg_guard'));

-- Latest peg-guard observation per curated stablecoin mint. Same streak
-- columns as webacy_depeg_latest so both feed the same reconciler.
CREATE TABLE peg_guard_latest (
    id                text PRIMARY KEY,
    chain             text NOT NULL,
    address           text NOT NULL,
    symbol            text,
    -- ISO 4217 code of the peg, NULL when unknown. Only USD drives advisories.
    peg_currency      text,
    -- USD value of one peg unit; 1.0 for USD, NULL until a fiat reference exists.
    peg_usd           double precision,
    price_usd         double precision,
    liquidity_usd     double precision,
    -- Signed percent from peg; negative = below peg.
    deviation_pct     double precision,
    tier              text CHECK (tier IS NULL OR tier IN ('ok', 'watch', 'warning', 'critical', 'premium')),
    prev_tier         text,
    tier_since_at     bigint,
    bad_since_at      bigint,
    observations      integer NOT NULL DEFAULT 0,
    ok                boolean NOT NULL,
    -- thin_liquidity | stale_price | no_price | unsupported_peg | fetch_failed
    error_message     text,
    price_source      text CHECK (price_source IS NULL OR price_source IN ('birdeye_multi_price', 'variant_markets_latest')),
    -- Provider timestamp of the price (unix ms); staleness is judged on this.
    price_updated_at  bigint,
    last_fetched_at   bigint NOT NULL,
    last_ok_at        bigint,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX peg_guard_latest_by_chain_and_address ON peg_guard_latest (chain, address);
CREATE INDEX peg_guard_latest_by_tier ON peg_guard_latest (tier, last_fetched_at);

CREATE TABLE peg_guard_tier_events (
    id             text PRIMARY KEY,
    chain          text NOT NULL,
    address        text NOT NULL,
    old_tier       text,
    new_tier       text NOT NULL,
    deviation_pct  double precision,
    price_usd      double precision,
    peg_usd        double precision,
    liquidity_usd  double precision,
    source         text NOT NULL CHECK (source IN ('sweep', 'manual')),
    -- Unix ms.
    observed_at    bigint NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX peg_guard_tier_events_by_address ON peg_guard_tier_events (chain, address, observed_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0020_peg_guard');
