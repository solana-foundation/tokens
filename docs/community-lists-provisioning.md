# Community lists: operations notes

List creation is open to every API key — there is no scope grant or whitelist. A list
is owned by the creating key's **project**; any key on that project can manage it, and
other projects get `403` on writes. Reads (`assets:read`, the default scope) are public
for all published lists.

## Caps (env vars on cloudrun-assets)

| Env var | Default | Bounds |
|---|---|---|
| `TOKEN_LIST_BATCH_CAP` | 250 | mints per `POST /members` batch call |
| `TOKEN_LIST_MEMBERS_PER_LIST_CAP` | 5000 | members a single list may hold (`list_full`) |
| `TOKEN_LIST_PROVIDER_LOOKUP_BUDGET` | 50 | Birdeye lookups a batch call may spend on locally-unknown mints |

These bound infrastructure cost, not access: batch size protects request timeouts, the
provider budget protects the Birdeye bill, the member cap bounds storage. Over-budget
unknown mints fail individually as `unknown_mint` and can be retried in later batches.

## Visibility

- `status: "unlisted"` (the dashboard calls it **Unlisted**) hides a list from the public
  catalog (`GET /v2/lists`) and from `inLists` annotations, while `GET /v2/lists/{slug}`
  and `/v2/lists/tokens` still serve anyone with the link. `draft` remains fully hidden
  from public reads. Set at create (`POST /v2/lists` with `status`) or later via `PATCH`.
- Owners see all their lists — archived included, so they can restore — via
  `GET /v2/lists?mine=true` — that is what feeds the dashboard's "My lists" rail.

## Abuse response

- Reversible hide: `PATCH /v2/lists/{slug}` with `{"status":"archived"}` (or the admin
  app's Lists page) — the list drops out of discovery/reads but keeps its row and slug.
- The admin app (`/lists`) shows every list across projects (any status) with the
  emergency archive action.
- Hard delete is owner-only (`DELETE /v2/lists/{slug}`): the row and members go, and the
  slug returns to the pool.

## Notes

- Slug rules: `^[a-z][a-z0-9-]{2,62}$`, globally unique; curated ids +
  `all`/`lists`/`curated`/`tokens`/`search-tokens`/`check-slug` reserved. Renames via
  `PATCH` are a clean cut — the old path 404s immediately and the slug frees up.
- Lists may contain mints outside the registry; they appear with `verified: false` in all
  read responses, with provider metadata snapshotted at add time.
- **Bulk membership from a CSV:** `POST /v2/lists/{slug}/members` accepts
  `{ "members": [{ "mint", "note"? }] }` alongside the original `{ "mints": [...] }`; row
  order becomes rank order for new members and `note` lands on the row. The dashboard's
  Lists tab has an `Import CSV` button (mint + optional note column; headerless files and
  bare mint lists accepted) that chunks through this same endpoint. The admin app's Lists
  page has the same importer plus `New list` for creating a list under any project
  (`adminCreateTokenList` / `adminImportTokenListMembers`, admin-allowlist gated).
