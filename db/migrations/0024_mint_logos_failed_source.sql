-- 0024_mint_logos_failed_source.sql
-- Review fix for 0023 (PR #145): a failed attempt at a *changed* upstream URL
-- used to overwrite `source_url` while the old copy stayed published, so the
-- next candidate scan no longer saw a source change and the replacement waited
-- out the periodic re-sync (or, for IPFS refs, never retried). Keep the source
-- of the published copy in `source_url` and record the last attempted-and-
-- failed source separately; retry backoff is keyed to `failed_source_url`.

ALTER TABLE mint_logos
    ADD COLUMN failed_source_url text;

INSERT INTO schema_migrations(version) VALUES ('0024_mint_logos_failed_source');
