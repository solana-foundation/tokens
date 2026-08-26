# Route methodology sweep — before/after reference

Fixed ten-asset panel (`bun run sweep:execution-route`), run against the local
stack (real Jupiter Swap V2, demo Titan — magnitudes are directional, structure
is real). This file is the reviewable receipt for the allocator-v2 formula
changes: the **before** table is unmodified HEAD (`40b9258`), the **after**
table is the same panel on the improved formula.

## Before (2026-08-25, pre allocator-v2)

| Panel | Status | Legs | Edge vs single | Peg (bps) | Defect shown |
| --- | --- | --- | --- | --- | --- |
| bitcoin $1M | ok | cbBTC 720k(i) / WBTC 200k / xBTC 60k / **WBTC 20k** | +27.14bps | 26.7 | $20k dust leg (2% of target) |
| bitcoin $5M | ok | cbBTC 3.5M(i) / WBTC 1.1M / xBTC 200k / WBTC 200k | +3168bps | 96.3 | largest leg unverifiable, edge rests on interpolation |
| ethereum $1M | ok | WETH 1M | **−0.25bps** | — | single variant: "edge" is quote noise |
| hyperliquid $1M | ok | HYPE 1M | +0.47bps | — | same |
| tesla $1M | ok | TSLAx 960k / TSLAon 40k(**v −9661bps**) | **−1159bps** | 0.8 | collapsed leg kept; losing split still presented |
| apple $1M | ok | AAPLx 400k(**v −8220bps**) | −159bps | — | collapse kept; $600k unallocatable (honest) |
| spacex $1M | ok | SPCX 800k / SPCXx 200k | +643bps | **111,203** | 11x-divergent SPCXon only warned, not ejected |
| micron $1M | ok | MU 1M | +0.05bps | **33,946** | divergent sibling only warned |
| gold $1M | **no_eligible_variants** | — | — | — | four 1-oz `spot` variants blocked by kind whitelist |
| silver $1M | **no_eligible_variants** | — | — | — | single `spot` variant, same block |
| usd $1M | ok | CASH 1M | −0.01bps | **1,608,821** | broken stable's base price only warned |

Verification-collapse pattern: Ondo equity legs re-quote −8,000…−9,700bps vs
their probe rungs (RFQ fill present at probe time, absent at verify time).

## After (allocator v2, same panel, 2026-08-25 — all structural expectations hold)

| Panel | Status | Legs | Edge vs single | Peg (bps) | Fix shown |
| --- | --- | --- | --- | --- | --- |
| bitcoin $1M | ok | cbBTC 760k / WBTC 200k / xBTC 40k | +14bps | 27.1 | dust leg folded (4 legs → 3) |
| bitcoin $5M | ok | 4 legs, worst surviving delta −108bps | +3135bps | 95.4 | collapse threshold not hit; honest deltas ship |
| ethereum $1M | ok | WETH 1M | **null** | — | single-variant edge is null, not noise (D) |
| hyperliquid $1M | ok | HYPE 1M | **null** | — | same |
| tesla $1M | ok | TSLAx 1M | null | — | **repaired**: collapsed Ondo leg distrusted, plan re-derived (B) |
| apple $1M | ok | AAPLon 40k, $960k unallocatable | null | — | **repaired** + honest depth exhaustion; no −8,220bps leg ships |
| spacex $1M | ok | SPCX 800k / SPCXx 200k | +1006bps | **0.29** | SPCXon **ejected** by the parity gate (was a 111,203bps warning) (A) |
| micron $1M | ok | MU 1M | null | — | **repaired**: divergent/collapsing sibling out |
| gold $1M | **ok** | GOLD 420k / XAUM 200k / PAXG 200k / XAUt0 180k | +9229bps | 151 | spot admitted; 1-oz pool routes; real spread flagged (A) |
| silver $1M | no_eligible_variants | — | — | — | **correct**: registry's only silver variant is an ETF wrapper, not an ounce — the baseline plan's "spot variant blocked" assumption was wrong, not the formula |
| usd $1M | ok | CASH 1M | null | **5.05** | broken AUSD book **ejected** (was a 1,608,821bps warning) (A) |

Magnitudes are demo-Titan-inflated; the structural fixes are what the check
mode asserts. Warning vocabulary added by v2: `price_divergence_excluded:`,
`plan_repaired:`, `plan_fell_back_to_single_variant`.

## Operational finding (2026-08-25, route-hardening phase)

The Jupiter key's rate tier is **10 requests per ~10s window** (measured:
10 consecutive 200s then 429s, `x-ratelimit-remaining` counting down, shared
bucket across `/swap/v2/order` and `/swap/v1/quote`). One `/route` call needs
~22 Jupiter quotes, so Jupiter coverage inside sweeps has been silently
partial all along (rungs degrading to `error`), and live restricted re-quotes
(`edge.basis: 'restricted_requotes'`) rarely complete on this tier despite
pacing + retries. The machinery is verified by effect-tests; the tier upgrade
belongs on the prod-keys gate checklist alongside the Titan production URL.

## Route-hardening acceptance (2026-08-25, same day)

Extended panel (adds bitcoin $10k/$25M, micron $50k, concurrency probe,
evaluate-sell entry) passes all structural expectations. Live highlights:
spacex upgraded to `edge.basis: 'restricted_requotes'` (the overlap fix
completing end-to-end); bitcoin $25M honestly concentrates into one leg with
an $11.5M unallocatable remainder; equity entries run the off-hours parity
multiplier (`market_closed_spread_tolerance`); two concurrent route calls
answered 200/200 in ~5s. Two expectations were corrected to match design
during this run: a collapsed leg may survive when the one-shot repair budget
is already spent, and depth exhaustion legitimately concentrates a plan into
a single leg.

## Refinement pass (2026-08-25 night, from joint testing)

Panel fully green after: `collapse_unrepairable:<mint>` disclosure when a
collapsed leg has no alternative variant (apple's single-pool case);
median-gate geometry corrected in the harness (survivors legitimately span up
to 2x the gate pairwise — micron's ~1,747bps at a 1,000bps off-hours gate is
two survivors on opposite sides of the median); `allocation.blendedImpactBps`
+ `extreme_impact` warning for catastrophic-but-optimal plans (the HOOD case);
per-rung failure `reason` distinguishing "no route" from "quotes failed —
depth unknown". Live bitcoin: blended impact 12.11bps, no warning — correct.
