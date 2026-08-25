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

## After (allocator v2)

_(filled in by the post-implementation `--mode check` run)_
