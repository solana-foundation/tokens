# Curated lists: DB-authority cutover runbook

As of this branch, `asset_collections` / `asset_collection_members` is the
single authority for curated list membership. The compiled arrays in
`packages/asset-registry/src/data/list-mints.ts` are canonical-asset
generation inputs (identity) only; the deprecated shim
`data/curated-token-lists.ts` exists solely for the final one-off jobs and is
deleted after the soak (see "Final deletions" below).

Everything ships as code — nothing here affects prod until deploy, and every
one-off job is a manual `POST /jobs/*` invocation.

## Rollout (per env: dev → staging → prod)

1. **Regenerate + review the fixture at merge week** (not implementation
   week): `bun scripts/generate-curated-collections-fixture.ts`, review the
   diff of `apps/cloudrun-assets/src/data/curated-collections-seed.json`.
   Never run `scripts/generate-curated-token-added-at.ts` — it is lossy in
   this squashed repo; the committed added-at values are final.
2. **Brief admin-curation freeze + pause the nightly
   `seed-canonical-assets-registry` scheduler** (prevents races during
   cutover).
3. One final convergence run **with the OLD revision still deployed**:
   `POST /jobs/seed-canonical-assets-registry`, then
   `POST /jobs/backfill-curated-added-at` (idempotent; only lowers values).
4. Parity gate: `bun scripts/verify-curated-db-parity.ts` against the env.
   DB-only members must be explainable as admin adds; fixture-only members
   must be tombstoned/inactive. Also validates the snapshot invariants
   (yield/LST mints only in `lsts`, live `all` union, count agreement).
5. **Deploy `apps/cloudrun-assets` first** (the `curatedMembershipGetSnapshot`
   RPC must exist before the API deploys), then `apps/api`, web, and admin.
6. Verify: all seven `/api/v2/lists` summaries + details, `/api/v1/assets/
   curated/lists`, risk exemptions on a curated mint, `lsts` tracks the
   Sanctum view, `?category=stables` normalizes. Then run the one-off
   `POST /jobs/cleanup-materialized-all-collection` (the `all` collection is a
   live union now; the materialized rows are dead weight).
7. Admin add/remove test: changes surface in `/api/v2/lists/{slug}` and
   `/api/v1/assets/curated?list=` within ~60s (snapshot TTL) + HTTP cache,
   with NO seed run.
8. Resume the scheduler and admin edits. Soak 1–2 days, then land the final
   deletions.

**Fresh environments** from now on: `db/apply.sh` →
`POST /jobs/seed-canonical-assets-registry` → guarded
`POST /jobs/seed-curated-collections-fixture` (bootstrap mode refuses to
write into a non-empty DB; recovery requires
`{ "mode": "recovery", "confirm": "RESEED_CURATED_COLLECTIONS" }`).

**Rollback:** if rolling back the cloudrun revision, keep the nightly seed
paused until DB membership is reconciled — the old worker's merge would
re-add baseline members that were deliberately removed while the DB was
authoritative.

## Final deletions (after soak)

- `packages/asset-registry/src/data/curated-token-lists.ts` (shim),
  `curated-token-added-at.ts`, `curated-latest-added.ts` (+ test), the
  curated block of `compat.ts` (wrapper/variant-group exports stay).
- `scripts/generate-curated-token-added-at.ts`,
  `audit-curated-token-lists.mjs`, `annotate-curated-token-lists.mjs`
  (already hard-deprecated stubs), `check-curated-symbols.ts`,
  `seed-curated-mint.mjs`.
- `backfillCuratedAddedAt` in `crons.seed.ts` + its job entry (after its
  final prod run in step 3).
- Grep gate: `CURATED_TOKEN_LISTS|getCuratedTokenList|CURATED_TOKEN_ADDED_AT`
  must only hit `list-mints.ts` / `curated-lists.ts` internals.

## Eventual consistency notes

- Stored risk scores (`asset_risk_latest`) pick up membership edits at their
  next cron refresh; live recomputation paths see edits within the ~60s
  snapshot TTL.
- The snapshot source is stale-forever-on-error: outages serve the last good
  membership; a cold start during an outage degrades (empty rank map, no
  curated exemptions, `withStaleFallback` catalogs) rather than serving
  hollow-empty lists.
