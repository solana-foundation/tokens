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

## Stability findings (2026-08-26) — the multi-ping question

`--mode stability` measures the same request repeated. Bitcoin $1M x5, 20s apart:

| Ping | cbBTC | WBTC | xBTC | edge | blended |
|---|---|---|---|---|---|
| 1 | $500k | $440k | $60k | 48.21bps | 11.26 |
| 2 | $620k | $320k | $60k | 38.91bps | 14.29 |
| 3 | $740k | $200k | $60k | 34.45bps | 24.90 |
| 4 | $580k | $360k | $60k | 44.27bps | 13.07 |
| 5 | $540k | $400k | $60k | 46.43bps | 10.46 |

Shares swing ±$92k stdev / $240k peak-to-peak; the **total holds within
5.7bps** and all 15 verify deltas were positive (mean +19.5). So: totals firm,
shares soft — now stated by the API rather than left for the caller to
discover.

**Three mechanisms, found in this order:**
1. *Curve steepness* — WBTC's $1M rung swinging 66→176bps. Real, but a slope
   RATIO cannot detect it: every BTC variant's top segment is 27–71x steeper
   than its prior segment (convexity is universal there). Absolute local
   impact works.
2. *Coverage gaps* — a run where cbBTC lost two rungs to rate limiting handed
   its entire $840k share to WBTC. Detected from the rung `reason` field.
3. **Marginal near-ties — the dominant, structural one.** Greedy equalizes
   marginal output across legs at the optimum, so any interior split has
   near-equal competing marginals *by construction* and ordinary quote noise
   moves the boundary. Signature in the data: cbBTC/WBTC (interior) swapped
   $220–240k every ping, while xBTC held exactly $60k because its curve cliffs
   right after that size, leaving a marginal gap noise cannot cross.

All three feed `shareConfidence` / `shareStability`; the third is why most
multi-leg plans correctly report `soft`.

## Hardening round 2 (2026-08-26) — multi-shape stability + label accuracy

Seven stability runs across every plan shape (`/tmp` receipts; 28 pings,
~600 quotes). The question this round asks: do the `shareConfidence` labels
*predict* the movement we measure?

| Run | Shares moved? | Labels | Verdict |
| --- | --- | --- | --- |
| bitcoin $1M x5, 20s | cbBTC/WBTC ±$100k stdev, $200k range; xBTC pinned | all soft | true positives (xBTC conservatively soft) |
| bitcoin $1M x3, **90s** | $300k range — same magnitude as 20s | cbBTC/WBTC soft, xBTC firm | movement is per-quote noise + structural near-ties, NOT time-accumulating drift |
| gold $1M x5 | shares pinned at caps; verify deltas collapse to −9,998bps | all soft | conservative; demo-Titan magnitudes |
| spacex $1M x5 | pinned 800/200 | all soft | conservative (60bps local-impact rule) |
| bitcoin $10k x3 | pinned | all firm | true negatives |
| usd $2M x3 | winning variant flipped AUSD→FDUSD | soft | true positive at identity level |
| **tesla $1M x5** | **plan identity flipped TSLAon↔TSLAx 4 times** | **pings 2/5: TSLAon $1M `firm`** | **the one falsified label** |

**Tesla falsification + fix.** The flapping pings' only in-response tell:
the winning fill's `router` is `jupiterz` — an RFQ. An RFQ offer is firm for
seconds with no persistence guarantee; whether it exists at all alternates
between requests (the vanished-RFQ pattern), which is also what drove the
repairs on pings 1/3/4. Rule shipped: an RFQ-filled leg is never `firm`.
(A clamp-based rule was tried first and rejected: TSLAon's curve shows no
impact drop — its `curve_not_concave` came from rounding wobble, and the flag
also fires on rounding artifacts in clean fixtures.) Recheck x3: TSLAon
$1M soft/soft/soft.

**Second find: selection starvation mis-statused.** gold and spacex ping 1
returned `no_eligible_variants` with `variants: 0` — every parity-capable
variant lost to `missing_decimals` when the Jupiter metadata fallback got
rate-limited right after the previous run's burst. That reads "asset cannot
be routed" for what is "retry". Fixed: zero probed variants + any
missing_decimals exclusion → `insufficient_quotes` (decimals exclusions
happen after the structural filters, so they are exactly the
would-have-been-eligible coverage losses).

Knob probes (all honest): 13 boundary 400s/404; $5M maxVariants=6 survived a
triple-collapse repair + ejection + restricted-requote upgrade in one
request; providers=jupiter degrades to `verification.status: 'interpolated'`
under the rate tier; providers=titan splits clean; allocate=false agrees with
allocate=true on selection; alias/$1/$50M clean. Negative verify deltas now
appear on bitcoin (3 of 15, min −14bps) — small honest drift, not collapse.
