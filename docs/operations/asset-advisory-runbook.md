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

## Automated depeg advisories (Webacy)

Stablecoin mints (active Solana variants plus every `currencies` list member) are monitored by Webacy's depeg monitor. The jobs worker (`apps/cloudrun-assets`, job `reconcile-stablecoin-depeg`) is nudged by Webacy's `DEPEG_TIER_CHANGE` webhook (received by the usage service, seconds of latency) and additionally sweeps every 4 hours to catch missed deliveries.

**What it does**

- Sets a `caution` advisory when Webacy rates a tracked mint `warning` (score 50-69) or `critical` (score 70+). Critical is set on first sight; warning after `warningConfirmMs` (0 by default, Webacy already applies hysteresis).
- Re-words the reason only when the tier moves between warning and critical. Live deviation is shown on the token page from `pegHealth`, not from the reason, so the reason is never refreshed for price drift.
- Clears its own advisory once the tier has been healthy (`ok` or `premium`; `watch` only with `clearOnWatch`) for `clearCooldownMs` (6 h). The webhook records the recovery; the next sweep performs the clear.
- Records every tier transition in `webacy_depeg_tier_events` and the latest observation in `webacy_depeg_latest`. Daily structural grades land in `webacy_structural_health_latest` / `_daily` (job `refresh-stablecoin-structural-health`).

**What it never does**

- Write `compromised` or `blocked`. Escalation is a human decision.
- Re-activate a deactivated variant.
- Touch a row a human owns (`managed_by_system = false`), set an advisory for a mint that has no active variant, or act on a failed or stale (> 9 h) observation.
- Trust the webhook payload for the tier. The receiver only says "look at this mint now"; the worker re-fetches `GET /rwa/{address}` and runs the same reconciler the sweep uses.

**Recognising a system row**

`asset_variant_advisories.source = 'webacy_depeg'`, `managed_by_system = true`, `set_by = 'system:webacy_depeg'`, `set_by_email` null. The admin curation row shows an "auto" badge; the reason starts with "Webacy's depeg monitor rates ... Warning:" or "... Critical:". Events carry `source = 'webacy_depeg'` and the same actor. The public banner reads "{symbol} is trading off its peg" with a Webacy attribution link.

**Taking over**

- Editing the reason or escalating the status in the admin app writes `source='admin', managed_by_system=false`. The automation detaches for good; it will never re-word or clear that row. The dialog warns before you save ("Save and detach").
- Clearing a system row in the admin app appends an `admin` clear event. The reconciler compares the latest admin clear against the start of the current bad-tier episode (`bad_since_at`) and skips with `suppressed_by_human_clear` until the peg recovers and breaks again. It does not suppress future episodes.

**Pausing**

- `WEBACY_DEPEG_REFRESH_ENABLED=false` on the assets worker stops both webhook-triggered and sweep reconciliation (handler returns `disabled`). Webhook deliveries are still persisted by the usage service and are picked up by the first sweep after re-enabling.
- `WEBACY_DEPEG_DRY_RUN=true` keeps observations, tier events and structural grades flowing but replaces every advisory write with a `depeg_advisory_would_set|would_update|would_clear` log line. This is the shadow-mode setting and the default when the variable is unset. The scheduler body pins `dryRun` from the Terraform variable `webacy_depeg_dry_run`; flip both at go-live.

**Circuit breakers** (`event: depeg_circuit_open`, field `reason`)

| reason | trigger | effect |
|---|---|---|
| `suspicious_drop` | sweep covers fewer than `shrinkGuardRatio`% (70) of the tokens it covered last time | nothing is written; the advisory set is frozen |
| `mass_tier_flip` | more than `maxTierFlipSharePct`% (25) of tracked tokens changed tier in one poll | snapshots and tier events are written, no advisory action |
| `mass_action` | more than `maxActionsPerRun` (5) actions due | criticals first, clears last, the rest deferred to the next run |

A breaker usually means a Webacy data incident, occasionally a real market-wide event. Confirm on dd.xyz and the stored `payload_json` before re-running with `"ignoreCircuitBreaker": true` (lifts the first two; the action cap always applies).

**Manual nudge**

```
node scripts/_jobs.mjs reconcile-stablecoin-depeg '{"mints":["<mint>"],"trigger":"manual","dryRun":true}'
```

Targeted mode fetches only the listed mints, writes their snapshot and tier event with `source='manual'`, and logs what the reconciler would do. Drop `dryRun` (or pass `false`) to apply. A full sweep is `{"trigger":"sweep","dryRun":true}`; add `"requireRefreshEnabled": false` to run while the flag is off.

**Webhook operations**

- Subscription: `scripts/webacy-webhook-subscribe.ts` (`--create | --list | --deliveries [--since] | --retry <id> | --delete <id>`). `--create` stores the signing secret straight into Doppler as `WEBACY_WEBHOOK_SECRET` and prints only the subscription id.
- Delivery audit: every inbound event lands in `webacy_webhook_deliveries` with `signature_ok` and `outcome` (`forwarded | duplicate | rejected_signature | rejected_stale | forward_failed | ignored`). Webacy's side is `GET /webhooks/deliveries`; replay one with `POST /webhooks/deliveries/{id}/retry`.
- Secret rotation: prefer `POST /webhooks/subscriptions/{id}/rotate-secret` (the old key stays valid for 24h and deliveries carry `X-Webhook-Previous-Signature`, which the receiver accepts); seed the new secret within that window. Creating a second subscription and deleting the old one also works.
- Connectivity check without waiting for a depeg: `POST /webhooks/subscriptions/{id}/test` sends a synthetic event (`test: true`, no token). The receiver verifies it, records `outcome='ignored'` and answers 200, so a `rejected_signature` row here means the secret on our side is wrong.

**Verified against the live API (2026-09-14)**

- Webacy's Solana slug is `sol` (items echo `chain: 'sol'`; `/v3/rwa` rejects anything else). Our tables still key rows by `chain = 'solana'`; the client translates at the edge, and the subscription filter is `chains: ['sol']`.
- `GET /rwa` returns `{ items, pagination: { total, page, pageSize, totalPages } }` with `score`, `tier`, `price`, `peg_value` and an unsigned fractional `abs_dev_clean`; the detail route adds a signed `dev_clean`. 572 Solana pegged tokens were listed, so the sweep uses `pageSize=200`, `maxPages=4`. Unmonitored tokens (`has_monitor_data: false`) carry `tier: null` and are skipped as `no_observation`.
- Structural health: `POST /v3/rwa/batch/structural-health` with `{ tokens: [{ address, chain }] }`; grades live under `composite.grade` / `composite.drivers[]` and the enum includes `E`. No Solana stablecoin had a grade yet (USDC, USDT, PYUSD returned `NOT_FOUND`), so the daily job counts them as `uncovered`, not failed, and the web panel shows nothing until Webacy adds coverage.
- Alerts: `stablecoin-depeg-critical` (page), `stablecoin-depeg-warning`, `stablecoin-depeg-advisory-changed`, `stablecoin-depeg-circuit-open` (page), `stablecoin-depeg-sweep-stale`, `stablecoin-structural-grade-downgrade`, plus the usage-side `stablecoin-depeg-webhook-*` rules.

**Depeg notice template**

> Webacy's depeg monitor rates [Symbol] ([mint]) **[Warning|Critical]**: it is trading [x.xx]% [below|above] its $[peg] peg as of [time] UTC. tokens.xyz shows a caution advisory on the token while this persists. This is not a confirmation of lost backing. Verify redemptions and liquidity with [issuer] before trading. We will clear the advisory once the peg has held for several hours, or escalate if the issuer confirms a problem.

State the observed deviation and the source; do not speculate on cause, recoverability or backing.
