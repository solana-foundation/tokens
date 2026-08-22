-- Community lists don't surface descriptions anywhere — drop the column and
-- the write path with it. Curated registry lists keep their descriptions
-- (compiled into @tokens/asset-registry, not stored here).

ALTER TABLE token_lists DROP COLUMN description;

INSERT INTO schema_migrations(version) VALUES ('0013_drop_token_list_description');
