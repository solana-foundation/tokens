# Multichain data audit (2026-10-22)

Scope: what the v2 asset API (`/v2/assets`, `/v2/assets/{id}`, `/v2/variants/…`) and the tokens.xyz asset page show for market data after multichain shipped (#192 API, #212 web), and where that data is wrong, mixed, stale or mislabelled. Providers in play: **Birdeye** (per-variant market rows; Solana via the v1 mirror plus ClickHouse/rwa.xyz overlays, EVM via per-chain `token_overview`), **CoinGecko** (coin identity and `platforms` for EVM variant derivation; reference price/market cap for curated coin ids), and the **stock** reference feed for tokenized equities.

Method: full read of worker → API → web; prod sampled through the keyless `https://tokens.xyz/api/v2/…` proxy on 2026-10-22; arithmetic scan of all 497 catalog rows; per-variant inspection of ~40 assets. No code was changed. This document is findings only; fixes are a separate decision.

---

## 0. Catalog-wide numbers

Scan of all 497 `/v2/assets` rows (158 multichain; 239 with a usable `referenceMarket`, 184 of those stock; 229 with `referenceMarket: null`; 29 with an all-null `referenceMarket` object):

| Check on headline `stats` | Assets | Examples |
|---|---|---|
| `price × circulatingSupply` differs from `marketCap` by >15% | 243 | bnb, spacex, nvidia, circle, uniswap |
| `fdv < marketCap` | 176 | usd, bnb, eur, nvidia, circle |
| Multichain and every variant counted as issued supply | 139 | usd, eur, nvidia, circle, tesla, meta |
| Issued variants exist but `aggregate.marketCap` is null | 68 | ethereum, tryb, booking, duolingo |
| `referenceMarket` present but every field null | 29 | sk-hynix, roblox, worldcoin, ton, target |
| `totalSupply` set while `circulatingSupply` null | 26 | ethereum, bitcoin, zcash, hyperliquid, near |
| `volume30dUSD < volume24hUSD` | 15 | ethereum, bnb, uniswap, zora |
| `chainStats.<chain>.fdv < marketCap` | 14 | usd, eur, nike, lululemon |
| `circulatingSupply > totalSupply` | 6 | oil, copper, chipotle, spdr-sandp-500-etf |

Per-variant sample of 30 multichain assets: 2–4 dust rows (liquidity and volume both < $1k) on almost every tokenized equity; price outliers >25% off the anchor on bitcoin (21BTC at half price), tesla (Arbitrum at 40× price), ethena (Arbitrum at 2×), usd (USDC.e on Polygon at $1.64), eur (two dead-peg tokens); rows up to 114 days old still included (four USD stables and EURCV on Solana, `rwa_xyz` source).

---

## 1. Issuance classification is kind-only, so supply / market cap / FDV sums are wrong

**What the code does.** `variantIssuance` (`apps/api/src/app/api/v2/_shared-assets.ts:607`) honours an `issuance:<x>` tag, else kind `bridged` → bridged, `wrapped` → wrapped, **everything else → native**. No code path writes an `issuance:` tag. `deriveVariantKindForChain` (`apps/cloudrun-assets/src/handlers/crons.v2Assets.ts:318`) returns `stablecoin` / `lst` / `tokenized_equity` purely from the asset category, never consulting the home chain; only the default branch uses `asset_platform_id`, and that is only populated for curated coins (metadata refresh is curated-only), so non-curated tokens fall to the `platforms` guess (`spot`, counted as native).

`computeChainStats` (`_shared-assets.ts:719`) then adds `marketCap` / `fdv` / `circulatingSupply` for every `native` variant and `aggregateChainStats` sums the chains.

**Live evidence.**
- `solana`: `chainStats.solana.marketCap` **$67.3B** vs CoinGecko $61.6B; all 1,464 Solana variants are LSTs (kind `yield`) and `issuedVariantCount = 1464`. Staked SOL is counted twice, and LST units are not 1:1 SOL.
- `tesla`: six `tokenized_equity` variants on four chains, all `native`, `aggregate.marketCap` $832M of which $739M is one junk Arbitrum row (see §2). Real tokenized float ≈ $90M.
- `usd`: 50/50 variants "issued" across six chains, including Binance-Peg copies on BNB and bridged USDC.e on Polygon.
- `gold`: `IAUon` (iShares gold ETF, $76 per share) and `GLDx` ($371 per share) are summed with per-ounce PAXG/XAUT ($4,060) in `chainStats.*.circulatingSupply` — shares plus ounces in one number.

**Affected fields:** `chainStats.*.marketCap|fdv|circulatingSupply`, `aggregate.*`, `stats.marketCap|fdv|circulatingSupply` whenever `excludedFromSupplyCount > 0` (see §3), list ordering indirectly.

---

## 2. No freshness, liquidity or price-sanity guard on any sum or average

**What the code does.** `computeChainStats` and v1's `aggregateTokenStats` (`apps/api/src/app/api/v1/assets/_asset-helpers.ts:705`) add every finite value. The liquidity-weighted price average (`weightedAverageByVariantActivity`, `_asset-helpers.ts:563`) includes every variant with positive liquidity. Nothing checks `lastFetchedAt`.

Worker side: when Birdeye returns nothing, `touchVariantMarket` (`apps/cloudrun-assets/src/db/v2Assets.ts:570`, v1 twin `db.ts:929`) keeps the old metrics and only bumps `overview_last_fetched_at`, so a delisted token keeps its last price indefinitely and the chain summary's `max_market_fetched_at` looks fresh. `market.asOf` is only set for `clickhouse_trades` rows (`marketSourceSelection.ts:375`); it is null for every Birdeye and EVM row, so the documented freshness signal does not exist for EVM. `stats`, `chainStats` and `aggregate` carry no timestamp at all.

**Live evidence.**
- `tesla` Arbitrum `0x8ad3…`: price **$15,192** (real $386), liquidity $11, 2 trades → `chainStats.arbitrum.marketCap` $739M.
- `eur` Solana `EURCV` (`rwa_xyz`): `lastFetchedAt` 114 days old, in the sums; `EUROe` $0.29 and `VEUR` $0.44 in the price pool.
- `usd`: `SOFIUSD`, `XUSD`, `USDtb` ×2 on Solana 114 days old; Polygon USDC.e priced $1.64.
- `bitcoin` Solana `21BTC` $41,767 (0 volume, 60 min old), `9hX59…` $71,958.
- Solana rows for non-curated mints are 48–60 min old (trade-aware rotation) while EVM rows are 3–5 min old; the sums mix both silently.

---

## 3. Headline `stats` mixes reference and on-chain figures; `totalSupply` is never issuance-gated

**What the code does.** `headlineOnChainStats` (`_shared-assets.ts:803`) swaps `marketCap`/`fdv`/`circulatingSupply` for the aggregate only when `excludedFromSupplyCount > 0`; `totalSupply` always keeps v1's sum over spot-like kinds, which include `bridged` and `wrapped` on every chain (`_asset-helpers.ts:745-750`). `selectCanonicalAssetStats` (`_asset-helpers.ts:604`) then takes `price`, `marketCap`, `priceChange24h` from CoinGecko when present but `fdv`, `totalSupply`, `circulatingSupply`, `priceChange1h` from on-chain. For stocks `marketCap` is the company's equity cap while `fdv`/supply are the tokenized float. CoinGecko's own `circulatingSupply`/`totalSupply`/`fdvUsd` are loaded but unused.

**Live evidence (page labels quoted).**
- `bitcoin`: "Market Cap $1.64T" (CoinGecko), "Supply —", **"Total Supply 218.41K"** (wrapped BTC summed over six chains; real 20.1M), "FDV —".
- `ethereum`: "Total Supply 2.67M" (WETH ×3 + Wormhole wETH; real 122M), FDV/Supply null.
- `bnb`: Market Cap $96.4B vs FDV $285M, circulating 393K (the ERC-20 BNB only).
- Every tokenized equity: "Market Cap" = company cap (Tesla $1.52T) beside "FDV" = tokenized float ($854M) and "Supply 289.76K" tokens. Pre-existing in v1 (v1 tesla fdv $88.8M vs mcap $1.52T); multichain now sums four chains into the on-chain side.
- `gold`: `referenceMarket` is the **GLD ETF** (`source: stock`, price $371/share) while the asset and all spot variants are per ounce ($4,064); the headline price is on-chain but the reference feed is the wrong instrument.
- The headline flips semantics on a variant count: one wrapped variant switches `fdv` from v1's spot-like sum to the aggregate's all-kinds sum; `stats` and `aggregate` disagree whenever `excludedFromSupplyCount = 0` and non-spot-like kinds exist.

---

## 4. `volume30dUSD` is Solana-only while `volume24hUSD` is cross-chain

`volume30dUSD` comes only from the mirrored Solana rollup (`_shared-assets.ts:1093`, built from Solana `ohlcv_candles`). 24h volume is the cross-chain sum. Live: `ethereum` 30d $626M vs 24h $1.0B; `bnb` 30d $4.8M vs 24h $379M; `link`, `pepe` 30d null. Not rendered on the asset page; public on the API and in the docs without a scope note.

---

## 5. `chainStats.solana` does not match its own Solana variant rows

`computeChainStats` overrides Solana `liquidity`/`volume24hUSD` with the v1 rollup (`asset_markets_latest`, computed in `crons.ts:1056-1131` on its own schedule and variant set, spot-like kinds only); `trade24h`, `marketCap`, `fdv`, supply stay as per-variant sums. Live: `link` `chainStats.solana.liquidity` **$6.3K**, volume $2.5K, while the only Solana variant row says $368K / $136K (`trade24h` 4,443 matches both). The same disagreement exists inside v1 (`/v1/assets/link` `stats.liquidity` 6344 vs the primary market 368343). Root cause not pinned; needs a replica query comparing `asset_markets_latest` inputs with `variant_markets_latest` for that mint. The docs' "`chainStats.solana` is the number v1 reported" is true but v1's number is itself inconsistent.

---

## 6. Native coins have no supply on their home chains

EIP-7528 `0xeeee…` rows never get a market (`v2Assets.ts:453` excludes them from refresh); WETH/WBNB/WPOL carry the market but are kind `wrapped` → excluded from supply. Result for `ethereum`: `chainStats.*.marketCap` null on all four chains, `issuedVariantCount` counts the market-less native rows, `aggregate.marketCap` null, headline survives only through CoinGecko. 68 assets in the catalog have issued variants and a null aggregate market cap (most are EVM-home tokens whose Birdeye row lacks `marketCap`).

---

## 7. Liquidity, volume and trades double count pools inside one asset

Birdeye's per-token `liquidity`/`volume` include every pool containing the token. Summing variants of one asset (`_shared-assets.ts:741`, v1 `crons.ts:1069`) counts a USDC/USDT pool once per side under `usd`, WBTC/cbBTC under `bitcoin`, SOL/LST under `solana`. The comment "pools are distinct" (`_shared-assets.ts:715`, docs line 260) is wrong. Pre-existing in v1; no pool-level data available to correct it. Separately, Birdeye and CoinGecko on-chain disagree 3–30× on Solana liquidity (USDC $10.65B vs $341M, from the primary-selection study), so cross-provider liquidity comparisons are not meaningful.

---

## 8. List and detail responses drift for the same asset

- `/v2/assets` passes `hideBlocked: true` (`assets/route.ts`), detail `false` (`_assets-loader.ts:111-141`): `stats`, `aggregate` and price averages differ when an asset has blocked variants. Contradicts docs ("always computed from the full variant set", `assets.mdx:18-21`) and the `buildV2Asset` header comment.
- The list's CoinGecko id remap only handles `bnb`; the prefetch and detail also remap `tron-xstock → tron` and `spacex-prestocks-2 → null` (`v2AssetsReads.ts:412-423`), so `tron` gets on-chain stats and an all-null reference in the list, CoinGecko figures on detail.
- `referenceMarket` is an all-null object (29 assets: `link`, `pepe`, `roblox`, `ton`, …) because CoinGecko prices refresh for curated ids only (`crons.coingecko.ts:876`). Headline falls back to on-chain weighted averages for those, which is fine, but the object should be null and the price source differs from curated neighbours.
- Blocked/flagged variants can still be primary (`flaggedFallback`, `_shared-assets.ts:1283`; registry full-pool fallback `primary-variant-ranking.ts:175`), against the docs' "never chosen". `primaryVariantStrategy=execution_quality` is accepted and echoed but never applied (no fill quality passed, `_shared-assets.ts:1053-1060`; variants route falls back to liquidity, `variants/route.ts:59`).

---

## 9. Asset page: data bugs (not styling)

Source: `apps/web/src/app/[name]/asset-page.tsx`, `components/asset-stats-section.tsx`, `lib/asset-page-capabilities.ts`, `app/token/[address]/components/token-header.tsx`.

- **"Last trade" time is wrong.** `formatUnixSeconds` (`asset-stats-section.tsx:369`) multiplies by 1000, but `lastTradeAt` is already milliseconds (`1792681201000` in prod payloads; the v2 contract says `*At` = ms). `asOf` is seconds, so it renders correctly. The two fields have different units in one object.
- **Variant view leaks asset-level CoinGecko numbers.** `asset-stats-section.tsx:83-116` picks per field `market.x ?? globalStats.x` (v1 `include=profile`), so a `?base=0x…` variant whose Birdeye row lacks `marketCap`/`fdv`/supply shows the whole asset's CoinGecko figure under the variant's symbol. The tooltip claims the fallback only happens "when Base is unavailable".
- **EVM variant view shows the canonical chart** (`asset-page-capabilities.ts:41` resolves `chart: 'canonical'` because EVM has no `ohlcv`), titled with the variant's symbol, with Pyth realtime for the canonical asset; for assets without CoinGecko/stock candles the v1 `price-chart` route falls back to the Solana primary mint's OHLCV (`api/v1/assets/[assetId]/price-chart/route.ts:164-185`). The chart price and the Stats "Price" come from different sources.
- **Canonical "Markets" section is Solana-only** (v1 `variant-top-markets`) under cross-chain Stats, unlabelled; the Security section's Liquidity/Market Cap come from v1 `marketScoreInput` and can disagree with the Stats liquidity on the same Solana variant.
- **Risk popover on the canonical view** (`token-header.tsx:622`) is gated on `chainSupports` directly, not `caps.risk`, and shows the Solana primary mint's score with no chain marker; the streamed shell fallback renders the Solana primary as active for EVM-requested variants until v2 content arrives (`asset-page.tsx:577-580`).
- **Tooltips state wrong provenance**: "aggregate … across available Solana variant markets" on a cross-chain number; "direct stable-pair Solana trades" shown for EVM Birdeye rows; "from aggregated variant data, falls back to CoinGecko" on Market Cap/Price where CoinGecko is actually first; "from Birdeye" on `rwa_xyz` rows; volume fallback to CoinGecko still labelled on-chain.
- **Never rendered**: `chainStats` (only feeds a hidden-count), `aggregate`, `volume30dUSD`, `holder`, every `lastFetchedAt`/`asOf` freshness field. Per-chain totals are not shown anywhere despite being in the payload.
- **Formatting**: no trillion tier (`$4000.00B`), badge dropdown shows unknown liquidity as `$0.00` while cards show `—`, badge count reads "3+" when exact, the third variant-card column changes meaning per card (exec score / trades / 1h volume).

---

## 10. Cross-surface inconsistencies

- **Home and heatmap still read v1** (`app/page.tsx:184`, `heatmap/lib/build-heatmap.ts:95`, Solana-only `curated`/`trending`). Live: home "Highest Volume (24H) Bitcoin $70.9M" vs asset page "24H Volume $480M". Price precedence also differs (home: CoinGecko → primary variant; page: `stats.price`, a liquidity-weighted blend for non-CoinGecko assets). Cache windows differ (30 s/15 s vs 60 s).
- **OG / Twitter card** (`lib/token-social-image.ts:700`, `token-social-image-data.ts:141`): price is Pyth → last v1 candle → CoinGecko with a **7-day** change from candles, while the page shows the v2 price with a **24h** change. EVM variants get the canonical chart line under the variant's price. `resolveSocialAssetRef` never calls `/v2/assets/{name}`, so DB-only v2 assets, `solana-<mint>` singletons and v1-fallback mints get a card with no data although the page resolves them.
- **Registry page** reads v2 `/registry` for identity only; no market data, so no conflict.

---

## 11. Provider coverage gaps (by chain)

| | Solana | EVM (eth/base/arb/polygon/bnb) |
|---|---|---|
| Variant rows | v1 mirror, every 5 min | CoinGecko `platforms` derivation daily + `NATIVE_COIN_DEPLOYMENTS` |
| Market rows | Birdeye + ClickHouse overlay (price/volume/trades) + rwa.xyz, ~2 min curated / trade-aware rotation otherwise | Birdeye `token_overview` only, 250 stalest per 15 min, `minAgeMs` 10 min |
| `holder` | present | mostly null |
| `price` | present | null on some long-tail Ethereum tokens; junk on dust pools (tesla Arbitrum) |
| `marketCap`/`fdv` | Birdeye; ClickHouse recomputes `circ × price` | Birdeye as-is; per-chain (verified: WBTC Ethereum 116K × $81.6K = $9.48B) |
| Native coin (SOL vs ETH/BNB/POL) | wSOL row carries supply | `0xeeee…` has no row; WETH/WBNB/WPOL are `wrapped` → no supply |
| 30d volume | from `ohlcv_candles` | none |
| Decimals | Birdeye, defaults to 9 if missing | CoinGecko `detail_platforms`, Birdeye only if null; variant row and market row can disagree |
| Reference market | CoinGecko (curated ids only) / stock feed | same (asset-level) |
| Advisories / risk / execution quality / OHLCV / DEX markets | yes | none (`capability_not_supported`) |

---

## 12. Documentation that no longer matches the code (`apps/docs/content/docs/v2/endpoints/assets.mdx`)

- 264–267, 239: price, market cap **and supply** come from `referenceMarket` — supply/FDV/1h change are on-chain; stocks use the on-chain price unless dust.
- 259–263: "pools are distinct" (§7), "`chainStats.solana` is the number v1 reported" (§5).
- 156–158: "issued (native) variants only" — issuance is just the kind (§1).
- 281–282: "compromised and blocked variants are never chosen" (§8).
- 305–307: `execution_quality` sort documented but not implemented (§8).
- 18–21 and `overview.mdx` 57–60: "computed from the full variant set" fails on the list route (§8).
- 328–330: `market.asOf` as a freshness signal is null for Birdeye/EVM (§2).
- 350–354 example: `usd` shown with `referenceMarket.coinId: "usd-coin"`; the live `usd` asset has `coingeckoId: null` and `referenceMarket: null`.
- `docs/operations/v2-multichain-assets.md` kind-derivation section: does not say stablecoin/equity kinds skip the home-chain check.

---

## 13. By design, worth confirming rather than fixing

- Primary variant = best tradeable-here variant (`primaryScope=executable`, Solana only has `swap`). For EVM-home assets that is a thin Solana wrapper: `link` primary liquidity $368K vs Ethereum $35M; `pepe` $2.9M vs $33M. The badge and cards highlight it without saying why.
- `/usdc` and `/usdt` resolve to the `usd` aggregate (`resolvedBy: alias`): the page shows all-stablecoin totals ($179.6B market cap), not USDC's. Pre-existing.
- Chain tabs appear for any chain with a derived row, including dust (bitcoin Polygon: one variant, $161 liquidity, 4 trades).
- `stats.price` for assets without CoinGecko is a liquidity-weighted average across every chain and kind; depegged bridged copies move it (eur pool includes $0.29 and $0.44 tokens; current weight is small).

---

## 14. Open questions needing a decision before any fix plan

1. **Headline semantics.** When a reference exists (CoinGecko or stock), should every valuation/supply field come from it, with on-chain sums shown separately as "tokenized/on-chain", or should the headline stay on-chain and the reference live in the pill? Today it is a per-field mix.
2. **Source of truth for issuance.** Options: curated `issuance:` tags via admin, a static override table keyed `<chain>:<address>`, CoinGecko `asset_platform_id` for all registered coins (needs the metadata refresh widened), or a new `derivative` class for LST/ETF/leveraged kinds. Likely a combination.
3. **Inclusion policy for sums and averages.** Thresholds for stale (hours), dust (liquidity/volume floor) and price outliers (deviation from reference or weighted median), and whether excluded rows are reported in `aggregate`.
4. **30d volume.** Keep Solana-only and label it, null it on multichain assets, or build cross-chain 30d from EVM data that does not exist yet.
5. **Native coin supply on EVM.** Give `0xeeee…` rows a market (CoinGecko supply or chain RPC), or treat WETH/WBNB/WPOL as the issued representation.
6. **Solana rollup vs variant rows (§5).** Investigate before deciding whether the v1 rollup should keep overriding `chainStats.solana`.
7. **Reference instrument mapping.** `gold` → GLD ETF share price; ETF-share tokens vs per-ounce tokens inside one asset. Which assets have the same mismatch (silver, oil, treasuries)?
8. **Surface parity.** Whether home/heatmap/OG move to v2 now or after the API semantics settle.
9. **List/detail parity and blocked variants.** Compute stats from the full set and filter after, or document the difference.
10. **Freshness contract.** Whether `stats`/`chainStats`/`aggregate` should carry `asOf`/coverage fields, and whether touch rows should stop looking fresh.

---

# Part 2 — Direct comparison against CoinGecko and Birdeye (2026-10-22, 16:30–17:40Z)

Part 1 compared our API against itself and against the code. This part pulls the same assets straight from the provider APIs with the local keys and diffs them against what we serve. Third opinions: CoinGecko on-chain (GeckoTerminal) and Jupiter price v3 for Solana. Scripts and raw payloads are in `/tmp/pa-data` (not kept in the repo).

Samples: 107 variants across all six chains for 15 assets (Birdeye `token_overview`), all 252 CoinGecko ids in the catalog (`coins/markets`, `coins/list?include_platform=true`), v2 detail for every CoinGecko-linked asset (168), 46 Solana variants against Jupiter, 11 tokens against GeckoTerminal.

## 15. Live incident: the EVM market refresh has not written since 16:22Z

Every EVM market row in the catalog (ethereum 151, bnb 106, arbitrum 24, base 14, polygon 4 rows checked) carries the identical `lastFetchedAt` = **2026-10-22T16:22:00.734Z**, unchanged across four samples taken 16:30–17:36Z while Solana rows kept advancing (newest 17:33Z). The job is scheduled every 15 minutes in prod, so four or more runs have produced no writes. Two possibilities, indistinguishable from outside: the scheduler is not firing, or every Birdeye fetch is failing and `touchVariantMarket` is keeping the old metrics (the `lastFetchedAt` we serve comes from the stored Birdeye blob, so touches do not move it). Direct Birdeye calls with the local key succeed for the same addresses. Needs the worker logs for `refresh-v2-evm-variant-markets` (local gcloud auth is expired, so this was not checked). The `assets-v2-*` alert rules did not surface it to this session.

## 16. Birdeye fidelity: our stored rows are faithful copies; the problems are upstream and semantic

107 variants, our row vs live Birdeye `token_overview` at the moment of the pull (our EVM rows were already 63 min old because of §15):

| Chain | rows | median \|Δ\| price | liquidity | 24h volume | market cap | circulating |
|---|---|---|---|---|---|---|
| solana | 45 | 0.1% | 0.1% | 1.0% | 0.1% | 0.0% |
| ethereum | 22 | 0.1% | 0.7% | 3.2% | 0.1% | 0.0% |
| base | 9 | 0.4% | 0.8% | 1.8% | 0.4% | 0.0% |
| arbitrum | 11 | 0.0% | 0.4% | 2.3% | 0.1% | 0.0% |
| polygon | 5 | 0.3% | 2.5% | 1.5% | 0.3% | 0.0% |
| bnb | 9 | 0.3% | 0.5% | 6.0% | 0.3% | 0.0% |

- Decimals agree on all 107. `holder` is null on 51/107 from Birdeye itself (all EVM except a few majors), so the gap is the provider's, not ours.
- Birdeye **does** answer for the EIP-7528 native addresses we skip (`0xeeee…`): price and 24h volume are populated (Base ETH $1.0M volume, Ethereum $8.7M), but market cap and supply are 0 or null, so it cannot supply native-coin issuance either.
- The 82 Arbitrum variants we serve with `market: null` are genuinely empty on Birdeye (`success: true`, no data): xStock Arbitrum deployments with no pools. They still count in `issuedVariantCount`, `variantCount` and the chain tabs.
- Two rows where ours differs from Birdeye because of our own pipeline: `EURCV` (`rwa_xyz` source, 114 days old; Birdeye has no price either) and `TSLAon` (ours liquidity 0, Birdeye has it).

## 17. Price integrity: 23 tokenized-equity pages show a headline price that is 2–100× the stock price

Catalog-wide, 21 of 184 assets with a stock reference have `stats.price` more than 10% off the stock price; 23 of 81 equities with a CoinGecko tokenized-coin price are more than 10% off that. The live CrowdStrike page shows **Price $8,826.10** (stock $238), PayPal $525 ($57), AppLovin $2,073 ($263), AST SpaceMobile $2,762 ($38), CleanSpark $578 ($17), TON $340 ($2.82), Open $15.27 ($1.93), Comcast $93 ($23), Linde $1,070 ($509), Medtronic $193 ($95), MARA $15.8 ($7.3), Goldman $1,386 ($890). `gold` shows $4,053 against a $371 reference because the reference is the GLD ETF (Part 1 §3).

Cause, per variant: the xStock Solana mints of these names have dead or near-dead pools and Birdeye reports a stale last-trade price with a non-trivial `liquidity` figure, so the liquidity-weighted on-chain average (`selectCanonicalAssetStats`, used for stocks unless the on-chain market is under $100) is dominated by a junk row.

| mint | Birdeye `token_overview` price | Birdeye `/defi/price` (updated) | Jupiter v3 | CoinGecko on-chain | real stock |
|---|---|---|---|---|---|
| CRWDx | $13,513 (liq $92k) | $54,052 (2026-10-07) | $375 (+214% 24h) | $1,503 (liq $0.02) | $238 |
| PYPLx | $3,337 (liq $4.2k) | $3,350 (2026-08-29) | $56 | none (liq $0.06) | $57 |
| APPx | $5,960 (liq $7.4k) | $5,960 (2026-10-21) | $251 | $280 (liq $712) | $263 |
| ASTSx | $2,762 (liq $24k) | $2,762 (2026-09-29) | $38 | $65 (liq $0.59) | $38 |
| MARAx | $140 (liq $761) | $140 (2026-09-20) | $9.2 | $4.0 (liq $0.17) | $7.3 |
| GSx | $1,526 (liq $4.3k) | $1,550 (2026-08-19) | $888 | $902 (liq $1.27) | $890 |
| CLSKx | $578 (liq $1.6) | $578 (2026-10-09) | $578 (old block) | none | $17 |
| TSLAx (control) | $379 (liq $4.2M) | $378 (now) | $378 | $377 (liq $2.2M) | $378 |

Birdeye's `liquidity` for these mints ($4k–$92k) does not match CoinGecko on-chain's reserve ($0.02–$712), so a liquidity floor alone would not have excluded CRWDx. Where the pool is liquid (TSLAx), all four sources agree within 0.5%. Jupiter vs Birdeye across the 43 liquid Solana variants in the sample: median 0.1% apart, none over 5%.

Knock-on: the same junk rows drive the tokenized market caps. Against CoinGecko's own market cap for the tokenized coin (`*-xstock`), our `aggregate.marketCap` is within 20% for only 3 of 72 equities (median deviation 3,326%): CrowdStrike $362M vs $0.9M, PayPal $959M vs $0.4M, Tesla $831M vs $73M (the $739M Arbitrum row). Where prices are sane the numbers agree (Apple, Microsoft, Alphabet Solana rows ±10% of CoinGecko).

## 18. CoinGecko identity: a third of our coin ids do not exist, and one points at the wrong coin

- **84 of 252 `coingeckoId` values return nothing from CoinGecko** (`coins/markets`, `coins/list`, `search`). They are generated by convention in `packages/asset-registry/src/data/equities.ts:174` (`${slug}-xstock`) and never validated. CoinGecko's real slugs differ for most: `johnson-johnson-xstock`, `international-business-machines-xstock`, `sandisk-corporation-xstock`, `capital-one-financial-xstock`, `the-walt-disney-xstock`, `procter-gamble-xstock`, `at-t-xstock`, `pg-e-xstock`, `lowe-s-companies-xstock`, `verizon-communications-xstock`, `lam-research-corporation-xstock`, `constellation-energy-corporation-xstock`, `warner-bros-discovery-xstock`, `helius-medical-technologies-xstock`, `s-p-global-xstock`, `arista-networks-inc-xstock`, `vertiv-holdings-co-xstock`, `chipotle-mexican-grill-xstock`. Four non-stock ids are also wrong: `worldcoin` (real: `worldcoin-wld`), `aster` (`aster-2`), `ferrari` (`ferrari-rstock`), `fwdi`/`gpro`/`cadd` (Backpack/bStocks ids or nothing). For ~45 of the 84 CoinGecko has **no xStock coin at all**; the asset's real Solana token is an Ondo, Backpack or bStocks issue (e.g. micron → `micron-technology-bstock`, lockheed → `lockheed-ondo-tokenized-stock`, alibaba → `alibaba-bstocks-tokenized-stock`). Effect today: all-null `referenceMarket`, no EVM derivation, and no CoinGecko metadata for those 84 assets. Fixing the ids would surface 81 assets' deployments on our chains (68 Ethereum, 65 BNB, 67 Solana, 14 Arbitrum, 2 Base addresses).
- **`chewy` → CoinGecko `chewy` is a meme coin** (price 1.9e-13, Solana mint `y7wrhy…`), not Chewy Inc. Our Chewy asset is a Backpack equity mint. Any CoinGecko-derived field for it is wrong. No other name/symbol mismatch among the 168 valid ids.
- **181 of our variant addresses belong to a different CoinGecko coin than the asset's id**: 105 Ondo mints (`*-ondo-tokenized-stock`), 22 Backpack (`*-backpack-securities`), LSTs (`jito-staked-sol`, `binance-staked-sol`, …), wrapped/bridged coins (`wrapped-bitcoin`, `coinbase-wrapped-btc`, `ethereum-wormhole`, `l2-standard-bridged-weth-base`, `okx-wrapped-btc`). CoinGecko therefore has per-issuer and per-wrapper market data we never read: each LST's own supply and cap, each wrapper's global cap, each issuer's tokenized float.
- **Same-issuer deployments on other chains that CoinGecko lists and we lack: 215 across 109 assets**, almost all Ondo on Ethereum (105) and BNB (104). Ondo issues every tokenized stock on Solana + Ethereum + BNB; because the asset is linked to the xStock id, only xStock EVM rows are derived.
- **41 Solana xStock mints CoinGecko lists for our equities that we have no variant for** (moderna, nike, reddit, airbnb, boeing, …). Birdeye shows them minted with 6–31 holders and no liquidity: pre-launch or dormant. Not a display gap, but the registry is unaware of them, and `chewy`'s "missing" mint is the meme coin.
- **50 of our Solana variant addresses are unknown to CoinGecko**: 30 Sanctum LSTs, our Backpack equity mints (airbnb, blackrock, chewy, netflix, riot, iren, tsmc), `ONDO`, `cbADA`, `cbLTC`, `wAVAX`, `21BTC`, `TAO`, `NEAR`, `UNI` bridge mints.
- **CoinGecko lists our coins on chains we do not ingest**: TON (68 coins), Mantle (67), Optimism (47), Ink (45), X Layer (45), HyperEVM (43). xStocks are on 8+ chains; Dinari tokenized stocks live on Base/Arbitrum/Ethereum/Avalanche (272 coins); Coinbase tokenized stocks on Base (152); rStock on Arbitrum/Morph (1,261); bStocks on BNB (98).

## 19. CoinGecko's "home platform" cannot decide native vs bridged

`asset_platform_id` as returned today: `tesla-xstock` → **arbitrum-one** (the Solana mint is the liquid one), `usd-coin` → ethereum (Solana USDC is natively issued), `tether` → ethereum, `chainlink` → ethereum, `wrapped-bitcoin` → ethereum, `jito-staked-sol` → solana, `tesla-ondo-tokenized-stock` → ethereum. Applying the Part 1 §1 home-chain rule to stablecoins and equities would mark Solana USDC and Solana TSLAx as bridged. The field is "where CoinGecko first listed it", not issuance. Issuance needs a curated source.

## 20. CoinGecko vs our headline numbers (168 matched ids)

- Crypto with a CoinGecko reference: `price`, `marketCap`, `priceChange24h` match CoinGecko within 0.5% (as designed). `fdv` (uniswap +14%, vvv +42%, nasdaq −59%, chiliz −14%) and `circulatingSupply` (infinex +401%, usd-ai +400%, lighter +300%, zora +124%, ondo +105%, uniswap +18%) differ because ours are on-chain sums that include bridged and wrapped rows. `totalSupply` differs by −94% to −100% for every L1 (bitcoin, ethereum, cardano, litecoin, near, zcash, …): ours is the wrapped float, CoinGecko's is the coin's supply. `volume24hUSD` is −90% to −99% of CoinGecko's for crypto because ours is DEX volume on six chains and theirs includes CEXs; the pill shows both.
- Wrapped/LST coins where CoinGecko has a coin per token: our per-variant Birdeye rows match CoinGecko's coin-level market cap within ~1% for `wrapped-bitcoin` (4 chains summed = $9.48B vs $9.43B), `coinbase-wrapped-btc` (4 chains, $7.79B vs $7.77B), every major LST, `l2-standard-bridged-weth-base`, `arbitrum-bridged-weth-arbitrum-one`. So Birdeye's per-chain supply is per-chain and summing the chains of one wrapper reproduces CoinGecko's global figure. Outliers: `okx-wrapped-btc` −67% (Birdeye circ 231 vs CoinGecko 700), `circle-internet-group-ondo-tokenized-stock` −98% (our Solana-only row 16k vs CoinGecko's three-chain 1.16M), `wrapped-solana` (CoinGecko's coin is not comparable).
- CoinGecko on-chain (GeckoTerminal) reports the **global** coin market cap on every chain (USDC $72.1B on Solana and on Ethereum) while its `fdv` is per-chain supply; Birdeye reports per-chain for both. Mixing providers per chain would double count.

## 21. Additions to the decision list (§14)

11. **Validate and repair `coingecko_id`.** Replace the `${slug}-xstock` convention with ids resolved against CoinGecko (search by Solana mint address is deterministic); decide which issuer's coin an asset links to when it has Ondo/Backpack/xStock mints, or whether to link several.
12. **Per-issuer identity.** Whether to link CoinGecko coin ids per variant (Ondo, Backpack, xStock, LST, wrapper) rather than per asset, which would unlock issuer-level supply/cap, Ondo's EVM deployments (209 rows) and remove the need to sum junk rows.
13. **Equity price source.** For tokenized equities use the stock reference as the headline price and treat on-chain prices as per-variant only, or require agreement with a second source (Jupiter / CoinGecko on-chain) before an on-chain price can enter an average.
14. **Chains to ingest.** TON, Mantle, Optimism, Ink, X Layer, HyperEVM, Avalanche carry most of the xStock/Dinari deployments CoinGecko knows.
15. **EVM refresh monitoring.** The §15 stall was invisible; the staleness of the newest EVM row should be an alert.
