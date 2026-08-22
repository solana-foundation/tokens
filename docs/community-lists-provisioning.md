# Community lists: partner provisioning runbook

Community token lists (`/api/v2/lists`) are invite-only on the write side: a partner
manages lists with an API key whose project owns them and whose scopes include
`lists:write`. This runbook is the manual grant flow until an admin UI exists.

## 1. Partner creates (or already has) a project + key

The partner signs into the developer dashboard (`apps/app`) and creates a project with an
API key via the normal flow (`usersCreateProjectWithApiKey` on cloudrun-usage). Note the
key prefix shown in the dashboard and the project id.

## 2. Grant the `lists:write` scope

Scopes live in `api_keys.scopes` (jsonb) and pass through auth verbatim — no code change
or deploy is needed. Against the prod Cloud SQL instance (see
`docs/`-adjacent prod DB runbook for connecting):

```sql
-- Inspect first
SELECT key_prefix, project_id, scopes FROM api_keys WHERE key_prefix = '<prefix>';

-- Append the scope (idempotence: skip if already present)
UPDATE api_keys
SET scopes = scopes || '["lists:write"]'::jsonb
WHERE key_prefix = '<prefix>'
  AND NOT scopes ? 'lists:write';
```

## 3. Bust the auth cache

apps/api caches `authenticateApiKey` results in Redis under `api-auth:v1:<sha256(key)>`.
The new scope takes effect when that entry expires (TTL `authCacheTtlSeconds`) or after
deleting it manually. If the partner reports `403 missing scope` right after the grant,
wait out the TTL before debugging further.

## 4. Verify

With the partner's key:

```bash
curl -s -X POST "$API/api/v2/lists" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"slug":"<partner>-core","name":"<Partner> Core"}'
```

Expected: `200` with the list body. A read-only key gets `403`. Slug rules:
`^[a-z][a-z0-9-]{2,62}$`, unique among existing lists, curated ids +
`all`/`lists`/`curated`/`tokens`/`search-tokens` reserved. Ask partners to prefix slugs
with their community name.

Slugs are not permanent: `PATCH /v2/lists/{slug}` accepts a new `slug`, and a deleted
list's slug returns to the pool for anyone to claim. Renaming is a clean cut — the old
path 404s the moment it lands, so warn partners before they move a live list.

## Notes

- Ownership is by **project**: any key on the same project (with the scope) can manage the
  project's lists. Revoking a key does not orphan lists.
- `DELETE /v2/lists/{slug}` hard-deletes: the row and its members go, and the slug is
  immediately claimable by any project. Irreversible.
- `PATCH /v2/lists/{slug}` with `{"status":"archived"}` is the reversible option — the list
  drops out of discovery and reads but keeps its row and its slug. Emergency takedown =
  archive via the admin app's Lists page (or SQL `UPDATE token_lists SET
  status='archived'`), which leaves the evidence in place.
- Lists may contain mints outside the registry; they appear with `verified: false` in all
  read responses.
