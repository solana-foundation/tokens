-- Admin-curated segmentation tags for canonical assets (customer request:
-- filter e.g. "Asian manufacturing" / "European defense" via
-- GET /v1/assets/search|curated?region=&industry=).
--
-- Vocabulary is enforced in app code (packages/asset-registry/src/taxonomy.ts),
-- mirroring how `category` is handled: no CHECK constraint, so growing the
-- vocabulary is a code deploy, not a migration.
--
-- Both columns are nullable and admin-owned. The nightly registry seed
-- (`upsertCanonicalAsset`) never names them, so its ON CONFLICT DO UPDATE
-- leaves them untouched; the only writers are the admin edit dialog and the
-- admin bulk import (`applyAssetTagsImport`), both of which also set
-- `admin_edited_at`.
ALTER TABLE assets ADD COLUMN region text;
ALTER TABLE assets ADD COLUMN industry text;

-- Table is ~1k rows; this only keeps filtered reads index-backed as it grows.
CREATE INDEX assets_by_region_industry
    ON assets (region, industry)
    WHERE region IS NOT NULL OR industry IS NOT NULL;

INSERT INTO schema_migrations(version) VALUES ('0032_assets_region_industry');
