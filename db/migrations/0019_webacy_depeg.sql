-- Webacy stablecoin depeg monitor + structural health, and advisory provenance.
--
-- Advisories gain a `source` so an automated caution (set by the depeg
-- reconciler on the jobs worker) is distinguishable from a human one, plus
-- `managed_by_system`, which is true only while the automation owns the row.
-- Any admin write flips it false; the reconciler never touches rows where it
-- is false (see docs/operations/asset-advisory-runbook.md).
--
-- System rows keep `set_by` NOT NULL by writing the sentinel
-- 'system:webacy_depeg' (no Clerk id exists for the worker), so every existing
-- reader/mapper keeps working unchanged.

ALTER TABLE asset_variant_advisories
    ADD COLUMN source text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'webacy_depeg')),
    ADD COLUMN managed_by_system boolean NOT NULL DEFAULT false;

ALTER TABLE asset_variant_advisory_events
    ADD COLUMN source text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'webacy_depeg'));

-- Explicit backfill: DEFAULT already covers it, kept so a future default change
-- can never silently reinterpret pre-0019 rows.
UPDATE asset_variant_advisories SET source = 'admin', managed_by_system = false;
UPDATE asset_variant_advisory_events SET source = 'admin';

-- The reconciler asks "when did an admin last clear this mint?" per run.
CREATE INDEX asset_variant_advisory_events_by_mint_action
    ON asset_variant_advisory_events (mint, action, source, created_at DESC);

-- Latest depeg-monitor observation per Solana pegged token (GET /rwa?chain=solana
-- or GET /rwa/{address}). Follows the 0005 snapshot shape (ok/status/payload_json/
-- error_message/last_fetched_at) plus the columns the reconciler and alerts filter
-- on. issues[], metadata and history stay in payload_json.
--
-- chain is 'solana' (Webacy's depeg chain slug), unlike the older webacy_*_latest
-- caches which store 'sol'.
CREATE TABLE webacy_depeg_latest (
    id                    text PRIMARY KEY,
    chain                 text NOT NULL,
    address               text NOT NULL,
    ok                    boolean NOT NULL,
    status                integer NOT NULL,
    symbol                text,
    -- Derived from overallRisk bands (ok <25, watch 25-49, warning 50-69,
    -- critical >=70); 'premium' when Webacy tags the token as above peg.
    tier                  text CHECK (tier IS NULL OR tier IN ('ok', 'watch', 'warning', 'critical', 'premium')),
    overall_risk          double precision,
    -- Signed percent from peg; negative = below peg.
    deviation_pct         double precision,
    price_usd             double precision,
    peg_usd               double precision,
    tags                  jsonb,
    -- Tier-streak state owned by the poller, not the provider. Unix ms.
    prev_tier             text,
    tier_since_at         bigint,
    -- First observation of the current warning/critical episode (survives a
    -- warning<->critical flip). NULL when the tier is healthy.
    bad_since_at          bigint,
    observations          integer NOT NULL DEFAULT 0,
    -- Had an active asset_variants row at the last observation.
    in_registry           boolean NOT NULL DEFAULT false,
    last_seen_in_list_at  bigint,
    last_source           text CHECK (last_source IS NULL OR last_source IN ('webhook', 'sweep', 'manual')),
    payload_json          text,
    error_message         text,
    -- Last attempt (success or failure) and last successful fetch. The API
    -- computes staleness from last_ok_at so a run of failed fetches reads
    -- as stale instead of fresh-looking last-good data.
    last_fetched_at       bigint NOT NULL,
    last_ok_at            bigint,
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX webacy_depeg_latest_by_chain_and_address ON webacy_depeg_latest (chain, address);
CREATE INDEX webacy_depeg_latest_by_tier ON webacy_depeg_latest (tier, last_fetched_at);

-- Append-only tier transitions (webhook-, sweep- or manually observed).
CREATE TABLE webacy_depeg_tier_events (
    id                text PRIMARY KEY,
    chain             text NOT NULL,
    address           text NOT NULL,
    old_tier          text,
    new_tier          text NOT NULL,
    overall_risk      double precision,
    deviation_pct     double precision,
    price_usd         double precision,
    peg_usd           double precision,
    source            text NOT NULL CHECK (source IN ('webhook', 'sweep', 'manual')),
    -- X-Event-ID of the Webacy delivery when source = 'webhook'.
    webhook_event_id  text,
    -- Unix ms.
    observed_at       bigint NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webacy_depeg_tier_events_by_address ON webacy_depeg_tier_events (chain, address, observed_at DESC);

-- Idempotency + audit for inbound Webacy webhooks (keyed by X-Event-ID).
CREATE TABLE webacy_webhook_deliveries (
    event_id      text PRIMARY KEY,
    event_type    text NOT NULL,
    chain         text,
    address       text,
    -- Unix ms.
    received_at   bigint NOT NULL,
    signature_ok  boolean NOT NULL,
    -- forwarded | duplicate | rejected_signature | rejected_stale | forward_failed | ignored
    outcome       text NOT NULL,
    payload_json  text NOT NULL
);

CREATE INDEX webacy_webhook_deliveries_by_received ON webacy_webhook_deliveries (received_at DESC);

-- Structural health v3 (24h cadence). Composite + per-category extracted;
-- criterion detail stays in payload_json. Score is 0-100, higher = more risk.
CREATE TABLE webacy_structural_health_latest (
    id                   text PRIMARY KEY,
    chain                text NOT NULL,
    address              text NOT NULL,
    ok                   boolean NOT NULL,
    status               integer NOT NULL,
    composite_grade      text,
    composite_score      double precision,
    -- {asset_collateral:{score,weight,status}, market_liquidity:{...},
    --  smart_contract:{...}, operational_governance:{...}, hack_exploit_history:{...}}
    category_scores      jsonb,
    criteria_fail_count  integer,
    criteria_warn_count  integer,
    payload_json         text,
    error_message        text,
    last_fetched_at      bigint NOT NULL,
    last_ok_at           bigint,
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX webacy_structural_health_latest_by_chain_and_address
    ON webacy_structural_health_latest (chain, address);

-- One row per token per UTC day for grade trends (~60 rows/day).
CREATE TABLE webacy_structural_health_daily (
    chain            text NOT NULL,
    address          text NOT NULL,
    day              date NOT NULL,
    composite_grade  text,
    composite_score  double precision,
    category_scores  jsonb,
    recorded_at      bigint NOT NULL,
    PRIMARY KEY (chain, address, day)
);

INSERT INTO schema_migrations(version) VALUES ('0019_webacy_depeg');
