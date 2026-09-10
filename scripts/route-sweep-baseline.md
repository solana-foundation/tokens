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

## Registry census (2026-08-26) — 137 assets, 4 defects found

`--mode census`: all 84 multi-variant assets @ $100k + 53 single-variant
samples @ $50k (~2,300 quotes). First run: **zero universal-invariant
violations**, but the notable rows surfaced four real defects, all fixed and
encoded:

1. **Repair re-admitted parity-ejected variants** (the big one; jpmorgan).
   JPMon's base rung implied ~$5,700/share (15.7x off), so the parity gate
   ejected it; the surviving JPMx plan collapsed at verification; the repair
   pass then rebuilt the plan on exactly the ejected book and shipped a leg
   whose verify delta was **+330,862bps** — with the original ejection warning
   erased (disclosures were read from the repaired engine only). Fix: repair
   distrusts collapsed AND ejected mints, and ejections from both engines
   surface. jpmorgan now ships an honest repaired/collapse-disclosed plan.
2. **Positive verify-delta blowouts passed silently** (oracle +5,312bps). The
   collapse gate is negative-only; a verified output far ABOVE the curve means
   the sizes were derived from bad probe data even though the total errs in
   the caller's favor. Fix: delta > |collapseThresholdBps| →
   `verification_upside_anomaly:<mint>` + the leg is never firm.
3. **`stablecoin` kind lacked unit parity** while usd/eur variants (same
   semantics) are `native` — so every exotic fiat stable (audd, brz, gyen,
   tryb, …15 census rows) read "cannot be routed". The registry ranking
   already treats `stablecoin` as spot-like; the route layer now grants it
   kind parity (runtime clustering still guards). brz immediately routes a
   real $30k leg; audd honestly reports insufficient_quotes (no books).
4. **Registry data: IEMG misfiled.** `cdVNL7…ondo` was named "iShares Core
   MSCI EAFE ETF" but live metadata identifies it as the Emerging Markets
   fund; two different funds sat under one canonical asset. Renamed → it now
   groups with the xStocks IEMG tracker under `core-msci-em`.

**Self-check re-run after the fixes: 137 assets, zero violations.** Status
distribution moved ok 103→111, no_eligible_variants 31→17,
insufficient_quotes 3→9 — the stablecoin-parity fix converting 14 exotic
stables from "cannot be routed" to routable/retryable. One check-panel
expectation was refined during the re-run: the survivor of a two-variant
mutual ejection legitimately carries the unattributable mutual divergence
(usd's pool collapsed to AUSD+USDP this run; USDP ejected and disclosed,
AUSD ships wearing the 28,919bps number as information).

Census landscape (first run): status ok 103 / no_eligible_variants 31 /
insufficient_quotes 3; jupiterz is the most common router registry-wide (485
answers, ahead of Titan's 484); 11 plans repaired, 5 fell back, 3 restricted
re-quotes completed. abbott/chevron hit the missing_decimals→
insufficient_quotes path (round-2 fix working at scale). Size-ladder torture
(bitcoin/gold/micron at $1k, $5k, $137,777, $3M, $50M, default): all
invariants hold — the ladder degenerates to 1–2 rungs gracefully and odd
amounts sum exactly.

## Simulation → execution gaps (2026-08-26 review, backlog — not built)

The simulation phase quotes and plans; a real multi-asset execution system
needs, in rough priority order:

1. **Plan identity.** A deterministic plan id/hash so an executor can say
   "execute plan X" and audit what was quoted vs what filled. Today a plan is
   only identified by its full body. (`meta.generatedAt` shipped now as the
   freshness half of this.)
2. **Caller slippage budget.** `slippageBps` is fixed at 50 inside the quote
   clients; an executor must pass its own tolerance and see it echoed in the
   plan, per leg.
3. **Leg sequencing.** Legs are size-sorted and the docs say largest-first
   (overlap consumes shared liquidity), but an executor needs this as a
   contract-level statement plus per-leg ordering semantics when legs share
   pools (`legIndependence` already carries the data).
4. **Partial-fill re-planning.** If leg 2 fails after leg 1 filled, the
   remainder needs a re-route that excludes the filled variant and accounts
   for the already-moved price. Natural shape: `/route` with `excludeMints`
   and a reduced target — the repair pass already implements the internal
   version of this.
5. **Plan TTL semantics.** RFQ legs are firm for seconds; AMM legs drift.
   `generatedAt` + `shareStability` describe it; an executor wants an explicit
   `validForSeconds` per leg (RFQ expiry is known to Jupiter, unknown to us —
   needs Ultra order metadata).
6. **Sell-side exits.** Descoped from simulation; an execution system needs
   position exit with unit-parity conversion per variant.
7. **Concurrency + quota.** One route call ≈ 22 Jupiter quotes; concurrent
   executor traffic requires the paid tier and per-key budget partitioning
   (per-instance limiter is best-effort only).

## Received-value basis + slippage empirics (2026-08-26 evening)

Steven's $750k test showed "received $735,489" (−194bps) beside a "+31.95bps
good deal" headline. Decomposition on the live $1M payload:

| Leg | exec price | venue base ($6–8k rung) | Birdeye snapshot | vs base | vs Birdeye |
| --- | --- | --- | --- | --- | --- |
| cbBTC | $78,989 | $78,872 | $77,130 | **+15bps** | +241bps |
| WBTC | $78,908 | $78,859 | $77,066 | **+6bps** | +239bps |
| xBTC | $78,989 | $78,882 | $77,106 | **+14bps** | +244bps |

A uniform ~240bps wedge across independent variants is a price-basis
artifact, not slippage — and `priceAsOf` (now exposed) proved it: the local
Birdeye snapshot was **3+ days old** (2026-08-23) while quotes are live.
Real execution cost on the plan: **11.8bps**. Fix: the split visual values
tokens at each variant's own `curve.baseEffectivePrice` (same source as the
quotes); the Birdeye value moved to the hover with its age and a divergence
note when the wedge exceeds 100bps.

**Slippage empirics** (direct venue calls, cbBTC $150k, slippageBps 1/50/300):
- Jupiter classic: outAmount 190,611,556 / 190,602,387 / 190,590,163 —
  ±0.6bps (inter-call noise); `otherAmountThreshold` scaled exactly
  ×(1−s/10⁴) at every setting.
- Titan REST: 190,571,589 / 190,595,039 / (one transient no-route, 200 on
  retry) — same invariance.
- Jupiter Ultra: takes no slippage param; reports its own `slippageBps: 0`.

Conclusion: quoted amounts are slippage-independent; slippage is an
execution-time min-out bound. The hardcoded 50bps in the quote clients
affects nothing this API returns. Caller slippage budget stays on the
execution-phase backlog.
