-- 0023_mint_logos.sql
-- First-party token artwork. `logo_uri` on tokens / variant_markets_latest /
-- trending_markets / fresh_trending_markets / sanctum_lsts_latest /
-- token_list_members / launchpad_tokens_latest is whatever the upstream
-- registry handed us: public IPFS gateways (429/403 from Cloudflare), dedicated
-- pinata gateways (403 off-origin), SVGs native decoders cannot render. The
-- `logo-sync` job (apps/cloudrun-assets, handlers/crons.logoSync.ts) fetches
-- each mint's artwork once, normalises it to 256px WebP, uploads it to the
-- public GCS bucket `tokens-asset-logos-<env>` at `solana/<mint>.webp`, and
-- records the result here.
--
-- One lookup table keyed by mint rather than columns on every source table:
-- trending tables are rewritten wholesale by their crons and list members are
-- write-time snapshots, so per-table columns would need a write path each.
-- Readers resolve `COALESCE(mint_logos.logo_cdn_url, <table>.logo_uri)` via a
-- correlated subselect (see `logoCdnColumn` in db.ts); nothing precomputed can
-- go stale relative to this table.
--
-- Not to be confused with the GCS bucket resource `asset_logos` in terraform
-- (admin uploads of canonical `assets.image_url`, keyed by asset id).

CREATE TABLE mint_logos (
    mint              text PRIMARY KEY,
    -- Raw upstream URL the copy was made from (the `logo_uri` that won).
    source_url        text NOT NULL,
    -- Which logo_uri column supplied source_url (variant_markets_latest | tokens | ...).
    source_table      text,
    -- Which fetch path succeeded: pinata | origin | dexscreener | jupiter.
    source_kind       text,
    -- sha256(source_url) hex. Unchanged hash + recent sync => skip.
    logo_source_hash  text,
    -- Public URL of the normalised copy; NULL until the first successful upload.
    logo_cdn_url      text,
    -- Sniffed upstream content type (image/svg+xml, image/png, ...).
    content_type      text,
    -- Last successful upload.
    logo_synced_at    timestamptz,
    last_attempt_at   timestamptz NOT NULL,
    -- Consecutive failures; reset to 0 on success. Drives retry backoff.
    attempts          integer NOT NULL DEFAULT 0,
    last_error        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mint_logos_by_synced_at ON mint_logos (logo_synced_at);

INSERT INTO schema_migrations(version) VALUES ('0023_mint_logos');
