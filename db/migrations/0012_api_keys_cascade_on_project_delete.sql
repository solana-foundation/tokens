-- api_keys.project_id used ON DELETE SET NULL, while project_members used
-- ON DELETE CASCADE. The application already deletes keys explicitly before
-- the project (deleteProjectCascade in apps/cloudrun-usage/src/db/dashboard.ts
-- runs both DELETEs in one transaction, and its handler comment describes the
-- operation as "cascades keys + memberships"), so the SET NULL branch never
-- fires through the dashboard.
--
-- It matters because a NULL project_id is not treated as revoked. In
-- authenticateApiKey (apps/cloudrun-usage/src/handlers/platformAuth.ts) a key
-- with no project falls back to the owner's personal project and inherits that
-- project's limits — a deliberate path for keys that never had a project, but
-- indistinguishable from a key orphaned by a project deletion. Any deletion
-- path that doesn't replicate the application's manual cleanup (a direct SQL
-- fix, a future code path, a maintenance script) would therefore leave live
-- keys silently re-pointed at a different project rather than revoked.
--
-- Align the constraint with the behaviour the application already implements.

ALTER TABLE api_keys
    DROP CONSTRAINT api_keys_project_id_fkey;

ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;

INSERT INTO schema_migrations(version) VALUES ('0012_api_keys_cascade_on_project_delete');
