-- Admin advisories on individual mints (variant grain).
--
-- Lives OUTSIDE asset_variants on purpose: the registry seed
-- (upsertCanonicalAssetVariant) overwrites tags/trust_tier/is_active
-- ON CONFLICT, so a flag stored there would be erased on the next run.
--
-- asset_variant_advisories holds at most one ACTIVE advisory per mint.
-- Clearing deletes the row; history lives in the append-only events table.
--   caution     informational notice; nothing is gated.
--   compromised visible with a warning; excluded from primary-variant
--               selection and trending; execution endpoints refuse the mint.
--   blocked     compromised + hidden from curated/search/trending/v2 list
--               hydration. Direct asset/mint reads still serve it (with the
--               advisory attached) — they never 404.
--
-- No FK to asset_variants: mint is not unique there, and an advisory should
-- outlive a hard-delete tombstone for audit purposes. The admin handler
-- validates that the mint exists before writing.

CREATE TABLE asset_variant_advisories (
    mint          text PRIMARY KEY,
    status        text NOT NULL CHECK (status IN ('caution', 'compromised', 'blocked')),
    reason        text NOT NULL,
    url           text,
    -- Clerk user id from the x-tokens-identity header.
    set_by        text NOT NULL,
    set_by_email  text,
    -- Unix ms. Reset when status changes; kept when only reason/url are edited.
    set_at        bigint NOT NULL,
    updated_at    bigint NOT NULL
);

CREATE INDEX asset_variant_advisories_by_status ON asset_variant_advisories (status);

CREATE TABLE asset_variant_advisory_events (
    id                   text PRIMARY KEY,
    mint                 text NOT NULL,
    action               text NOT NULL CHECK (action IN ('set', 'clear')),
    status               text CHECK (status IS NULL OR status IN ('caution', 'compromised', 'blocked')),
    reason               text,
    url                  text,
    -- True when the same transaction flipped asset_variants.is_active back on.
    reactivated_variant  boolean NOT NULL DEFAULT false,
    actor_clerk_user_id  text NOT NULL,
    actor_email          text,
    -- Unix ms.
    created_at           bigint NOT NULL
);

CREATE INDEX asset_variant_advisory_events_by_mint ON asset_variant_advisory_events (mint, created_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0018_asset_variant_advisories');
