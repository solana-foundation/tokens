# Asset advisory runbook

Use this when an issuer, venue, or security partner reports that a token we list should not be interacted with (exploit, depeg, frozen redemptions, confirmed impersonation). The advisory system flags a **mint** in the database; no deploy is required.

## Statuses

| Status | Visible in lists/search | Primary variant eligible | Trade links / execution | Use when |
|---|---|---|---|---|
| `caution` | yes, amber badge | yes | allowed | Unconfirmed report, degraded redemptions, "watch this" |
| `compromised` | yes, red badge + banner | **no** | **refused** | Issuer or venue confirmed the problem; users should still be able to find the warning |
| `blocked` | **no** (direct URL still renders) | no | refused | Confirmed scam/impersonator, or the issuer asked for delisting |

Hard removal is a different tool: "Deactivate variant" hides the mint silently, and hard delete tombstones it. Prefer an advisory whenever users might still search for the token; a silent removal leaves them with no warning.

## Who can flag

Anyone on the admin allowlist (`TOKENS_ADMIN_EMAILS` / `TOKENS_ADMIN_CLERK_USER_IDS`). Every set/clear is recorded in `asset_variant_advisory_events` with the actor's Clerk id and email, and logged as a structured `event: 'mutation'` line in cloudrun-admin.

## Flag a mint

1. Admin app → Curation → open the canonical asset → find the variant row → **Set advisory…**
2. Choose the status. Write the reason in one or two sentences stating only what is confirmed and the recommendation (example: "Issuer treasury wallet exploited on 2026-09-09; Sunrise has removed the market. Do not trade."). Add the source URL (issuer statement, venue notice).
3. If the variant was previously deactivated, leave **Also re-activate this variant** checked so the warning becomes visible instead of the token staying hidden.
4. Save. One transaction writes the advisory, optionally re-activates the variant, and appends the audit event.

Without the UI (migration and cloudrun-admin deployed, admin app not yet): `POST /api/admin/setVariantAdvisory` through the admin app with a Clerk session, body `{ "mint": "...", "status": "compromised", "reason": "...", "url": "https://...", "activateVariant": true }`.

## Expected propagation

| Surface | Worst case |
|---|---|
| Execution endpoints (`/v2/execution/*`) | 15 s |
| `/v1/assets/trending` | ~45 s |
| `/v1/assets/curated`, v2 lists | ~75 s |
| `/v1/assets/:id`, web token page | ~75 s |
| `/v1/assets/search` in a browser that already fetched | up to ~2 min |
| OG / social cards | ~6 min |

The API polls the advisory table every 15 s (`ASSET_ADVISORIES_TTL_MS`). If it cannot reach cloudrun-assets it keeps serving the last good set and logs `asset_advisories_refresh_failed`; a cold start with no set at all serves unflagged data and logs `asset_advisories_load_failed`. Execution endpoints do not fail open.

## Verify

Reads can be spot-checked without a key through the web proxy: `https://tokens.xyz/api/v1/assets/<assetId>`.

- `asset.advisories` lists the mint with the expected status.
- `primaryVariant.mint` is **not** the flagged mint (for `compromised`/`blocked`) when an unflagged sibling exists.
- The flagged variant appears in `variantGroups` with `advisory` set (`/v1/assets/:id` never 404s a flagged mint).
- `https://tokens.xyz/api/v1/assets/search?q=<symbol>`: for `blocked` the mint is absent; for `compromised` it is present with `advisories` populated.
- Web: `https://tokens.xyz/<assetId>?solana=<mint>` shows the banner and "Trading disabled"; `https://tokens.xyz/<assetId>` shows the sibling notice when the flagged mint is not primary.

## Clear

Admin app → the same variant row → **Clear advisory**. The live row is deleted and a `clear` event is appended. Propagation windows are the same as above.

## Public notice template

> We are aware of [what was confirmed, by whom, with link]. [Symbol] ([mint]) is now marked **[status]** on tokens.xyz: [what that means for users: trade links disabled, no longer the primary variant for [asset]]. We recommend not interacting with the token until [issuer] and their security partners publish further guidance. We will update this notice as we learn more.

State what is confirmed and what we recommend. Do not speculate on cause, recoverability, or backing.
