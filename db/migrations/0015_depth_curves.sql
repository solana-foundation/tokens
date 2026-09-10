-- Price-impact curves per variant mint, sampled from an aggregator quote API
-- at a ladder of USD sizes (see refresh-depth-curves in cloudrun-assets).
-- Fed the graded depth surface. Currently parked: the sampler cron is disabled
-- and /v2/execution/evaluate serves live quote comparison instead, so nothing
-- reads this table today. Kept so the graded view can return without a rebuild. Impact is derived
-- from the ladder itself (effective price per rung vs. the smallest rung),
-- so rows are comparable across sources.

CREATE TABLE variant_depth_curves_latest (
    id               text PRIMARY KEY,
    mint             text NOT NULL,
    quote_mint       text NOT NULL,
    side             text NOT NULL CHECK (side IN ('buy', 'sell')),
    source           text NOT NULL CHECK (source IN ('titan', 'jupiter_lite')),
    -- [{sizeUsd, inAmount, outAmount, priceImpactBps, effectivePrice, routeVenues, contextSlot?}]
    ladder           jsonb NOT NULL,
    points           integer NOT NULL,
    failed_points    integer NOT NULL,
    as_of            bigint NOT NULL,   -- sampling wall-clock, unix seconds
    last_computed_at bigint NOT NULL,   -- unix ms, matches fill-quality convention
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX variant_depth_curves_latest_by_mint_quote_side_source
    ON variant_depth_curves_latest (mint, quote_mint, side, source);

CREATE INDEX variant_depth_curves_latest_by_computed
    ON variant_depth_curves_latest (source, side, last_computed_at);

INSERT INTO schema_migrations(version) VALUES ('0015_depth_curves');
