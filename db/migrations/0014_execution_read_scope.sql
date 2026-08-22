-- Grant the new default `execution:read` scope to existing API keys with
-- materialized scope arrays. Keys with NULL scopes need nothing — they fall
-- back to DEFAULT_LEGACY_SCOPES (which now includes execution:read) at auth
-- time via normalizeScopes.

UPDATE api_keys
SET scopes = scopes || '["execution:read"]'::jsonb
WHERE scopes IS NOT NULL
  AND NOT scopes ? 'execution:read';

INSERT INTO schema_migrations(version) VALUES ('0014_execution_read_scope');
