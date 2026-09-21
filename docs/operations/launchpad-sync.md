# Launchpad sync (stonk.fun)

Coins launched on [stonk.fun](https://www.stonkfun.xyz) against a quote token we
curate are surfaced on that quote asset's page as a **"Launched on \<SYMBOL\>"**
section. There is no meme category, tab, or nav item: the coins hang off the
asset they were launched against.

## Data flow

```
Cloud Scheduler  →  POST /jobs/sync-stonkfun-launches   (cloudrun-assets worker, every 15 min)
  GET stonkfun /api/public/v1/tokens?status=graduated  (~22 pages, no auth)
  keep quote.mint ∈ effective curated mints
  threshold: marketCap ≥ minMarketCapUsd OR volume24h ≥ minVolume24hUsd
  cap maxPerQuote per quote mint, rank by 24h volume
  approved mints (launchpad_mint_approvals): always selected, skip threshold + cap
  upsert launchpad_tokens_latest; deactivate rows no longer selected
  new mints: Birdeye token overview once → tokens + variant_markets_latest (approved first)

api   GET /api/v1/assets/{assetId}/launches      → launchpadListByQuoteMints(asset's mints)
      → JOIN launchpad_mint_approvals: only admin-approved mints are ever returned
web   <AssetLaunchesSection> after Markets on canonical asset pages (renders nothing when empty)
```

**Nothing shows in prod until an admin approves the first coins** (see Approvals).

Each coin's own page is the existing **singleton-asset** path (`/token/<mint>` →
`/solana-<mint>?solana=<mint>`), which reads identity from `tokens` and the
market snapshot from `variant_markets_latest`. The provider payload carries no
decimals, so a launchpad row is **activated only after both rows exist**; until
then it is stored with `is_active = false` and picked up on a later run. After
that the regular `refresh-stale-asset-variant-markets` and `refresh-token-prices`
rotations keep the rows fresh.

## Job args (`body_json`)

| arg                       | default | meaning                                                   |
| ------------------------- | ------- | --------------------------------------------------------- |
| `minMarketCapUsd`         | 25000   | keep if market cap ≥ this …                               |
| `minVolume24hUsd`         | 10000   | … or 24h volume ≥ this                                    |
| `maxPerQuote`             | 50      | max coins per quote mint                                  |
| `newMintBirdeyeBudget`    | 25      | Birdeye overview calls per run for mints without identity |
| `maxPages`                | 30      | provider page cap (100 per page)                          |
| `concurrency` / `delayMs` | 2 / 200 | identity pool pacing                                      |

Skips (`ok: true, skipped: true`): `no_matches` and `suspicious_drop` (selection
< 70 % of the current active count — guards against deactivating everything off a
partial outage). These are deliberate no-ops and are acknowledged.

Failures (`ok: false` → HTTP 500, retried by Cloud Scheduler): `http_error` /
`error` / `invalid_payload`. A total provider failure deactivates nothing and is
retried rather than acknowledged, so a stonk.fun outage does not leave launches
stale until the next scheduled tick.

## Operating

- Re-run manually: `POST /jobs/sync-stonkfun-launches` with `{}` (or a smaller
  `newMintBirdeyeBudget`) on the worker service via the scheduler invoker.
- Job group is disabled (`404 launchpad_jobs_disabled`) when `BIRDEYE_API_KEY`
  is missing, because new coins need Birdeye for identity.
- Hide a coin: set a `blocked` advisory on its mint (admin → curation → advisory);
  `caution`/`compromised` show as a badge instead.
- Inspect: `SELECT quote_symbol, COUNT(*) FROM launchpad_tokens_latest WHERE is_active GROUP BY 1 ORDER BY 2 DESC;`
- Migration `0021_launchpad_tokens.sql` is applied via the one-off Cloud Run
  migration job (see the prod DB migration runbook).

## Side effects to know

- Coins written to `tokens` also appear as trailing "singleton" results in
  `/api/v1/assets/search` by symbol/name, exactly like any bare mint today.
- Steady-state Birdeye load grows by the number of active launchpad mints on
  the existing stale-refresh rotations.

## Approvals (admin allowlist)

Only mints in `launchpad_mint_approvals` (migration `0022`) reach the API and
the web. The sync keeps syncing every candidate so admins choose from live data.

- **Admin app → Launches** (`/launches`): Curation-style table, one row per
  curated asset that stonk.fun accepts as a **quote token** (cross-reference of
  `GET /pairs` with curated mints via `adminListLaunchpadPairs`), shown even
  before any coin exists, with coin / approved / live counts; expand a row to
  see its coins with market cap, 24h volume, status
  (`live`, `pending identity`, `not in last sync`) and approver/note, and an
  ellipsis menu (Approve… / Edit note… / Revoke… / Open on stonk.fun). A
  "Not synced yet" row holds approvals by address the sync hasn't stored.
- **Browse stonk.fun…** (row menu): the complete live list of graduated coins
  stonk.fun has for that asset's quote mints — including coins below the sync
  threshold — flagged synced / live / approved / below threshold, with one-click
  Approve / Revoke. Backed by `adminListLaunchpadTokensForQuote` on
  cloudrun-assets (the service that owns the stonk.fun client).
- **Add Mint** (toolbar) / **Approve…** (coin menu): Curation's add-variant
  flow — paste a mint, **Check** fetches it from stonk.fun
  (`adminPreviewLaunchpadMint`) and shows what it is, which asset page it would
  land on, sync/approval state and warnings (not graduated, quote not curated,
  below threshold, identity pending); then **Approve** with an optional note.
  Approval is disabled when the quote token is not curated (no page to show on).
  Approving stores a snapshot (quote mint, symbol, name, logo) on the approval
  and calls `adminSyncLaunchpadMint`, which fetches the coin + Birdeye identity
  and stores the launchpad row immediately, so the asset row populates right
  away instead of after the next cron run.
- **Approve → visible**: a synced, active coin appears after the API/web caches
  roll (≤ 2 min). A coin approved by address that is below the threshold has no
  row yet; it appears after the next sync run (≤ 15 min) plus identity ensure.
  Approved coins bypass the threshold and the per-quote cap but must still be
  quoted in a curated mint and returned by stonk.fun as graduated.
- **Revoke → hidden** after the caches roll (≤ 2 min). The synced row stays so
  the coin can be re-approved later.
- **Audit**: `launchpad_mint_approval_events` (approve/revoke, actor Clerk id +
  email, timestamp) plus a `{"event":"mutation","mutation":"approveLaunchpadMint"…}`
  log line from cloudrun-admin.
- Inspect: `SELECT a.mint, a.approved_by_email, l.symbol, l.quote_symbol, l.is_active FROM launchpad_mint_approvals a LEFT JOIN launchpad_tokens_latest l USING (launchpad, mint);`
