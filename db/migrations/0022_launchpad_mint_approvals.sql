-- 0022_launchpad_mint_approvals.sql
-- Admin allowlist for launchpad coins. Only mints with a row here are served
-- by the launches API / shown on asset pages; the stonk.fun sync keeps every
-- candidate in `launchpad_tokens_latest` so admins can pick from live data.
--
-- Kept in its own table (cf. 0018 advisories): the sync upserts
-- `launchpad_tokens_latest` with ON CONFLICT, so a flag stored there would be
-- overwritten on every run. Keyed by (launchpad, mint) to match the synced
-- table. Approving a mint that is not synced yet is allowed; the next sync
-- picks it up regardless of the volume / market-cap threshold.
--
-- `launchpad_mint_approval_events` is append-only audit: every approve/revoke
-- with the acting admin. No FK so history survives a revoke.

CREATE TABLE launchpad_mint_approvals (
    launchpad          text NOT NULL,
    mint               text NOT NULL,
    note               text,
    -- Snapshot from the admin "Check mint" preview so an approval shows under
    -- the right asset with a symbol before the sync stores the coin.
    quote_mint         text,
    symbol             text,
    name               text,
    logo_uri           text,
    approved_by        text NOT NULL,
    approved_by_email  text,
    approved_at        bigint NOT NULL,
    updated_at         bigint NOT NULL,
    PRIMARY KEY (launchpad, mint)
);

CREATE TABLE launchpad_mint_approval_events (
    id                   text PRIMARY KEY,
    launchpad            text NOT NULL,
    mint                 text NOT NULL,
    action               text NOT NULL CHECK (action IN ('approve', 'revoke')),
    note                 text,
    actor_clerk_user_id  text NOT NULL,
    actor_email          text,
    created_at           bigint NOT NULL
);

CREATE INDEX launchpad_mint_approval_events_by_mint
    ON launchpad_mint_approval_events (mint, created_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0022_launchpad_mint_approvals');
