import { Effect } from 'effect';

import { route, type PlatformAuthContext } from '@/effect/next-route';
import { BadRequestError, ForbiddenError, NotFoundError } from '@tokens/effect';
import { decodeLimit, decodeOffset } from '@tokens/effect';
import { tapErrorAndDefault } from '@tokens/effect';
import { annotateAssetAdvisories, loadAdvisoriesOrEmpty, summarizeAssetAdvisories } from '@/lib/advisories';
import { loadStablecoinHealthOrEmpty } from '@/lib/stablecoin-health';
import { getByAssetId as cloudRunGetByAssetId } from '@/lib/cloudrun/assets';
import {
    assetMarketsGetLatestByAssetId,
    assetVariantsListByAssetIds,
    coingeckoGetCoinById,
    coingeckoGetPriceLatestByCoinId,
    sanctumListActive,
    tokensGetByAddress,
    variantFillQualityGetLatestByMints,
    stockInstrumentsGetByAssetId,
    stockPricesGetLatestByAssetId,
} from '@/lib/cloudrun';
import {
    decodeUnknownOrBadRequest,
    NonNegativeIntFromString,
    SolanaAddress,
    TimeInterval as TimeIntervalSchema,
} from '@tokens/effect';
import { type TimeInterval } from '@/lib/birdeye';
import { validateOhlcvRange } from '@/lib/ohlcv-bounds';

import type { CanonicalAsset } from '@tokens/asset-registry';
import { PRE_STOCKS, resolveAlias as resolveRegistryAlias } from '@tokens/asset-registry';
import { prestocksGetLatestByMints } from '@/lib/cloudrun/prestocksReads';
import {
    resolveAssetImageUrl,
    aggregateTokenStats,
    buildCuratedMintRank,
    listSymbols,
    mergeAssetStatsWithAggregates,
    optionalSymbol,
    optionalText,
    parsePrimaryVariantStrategy,
    pickPrimaryVariant,
    selectCanonicalAssetStats,
    executionQualitySnapshotFromConvexFillQuality,
    computeCompanyMarketCapUsd,
    computePreStocksDerived,
    isCanonicalPublicEquityAsset,
    isStockPricedCategory,
    type TokenMarketSnapshot,
    type VariantExecutionQualitySnapshot,
} from '../_asset-helpers';
import { resolveAssetRefContext } from '../_resolve-asset-ref';
import { singletonAssetIdToMint } from '../_singleton-asset-id';
import { canonicalizeAsset, canonicalizeAssetVariants } from '../_canonical-overrides';
import { normalizeCoinGeckoCoinIdForAsset } from '../_coingecko-id';
import { resolveCoinGeckoCoinIdForAsset } from '../_resolve-coingecko-coin-id';
import { ASSETS_READ_SCOPE, INCLUDE_SCOPE, VALID_INCLUDES, type AssetInclude } from '../_asset-detail-types';
import {
    includeError,
    loadMarketsInclude,
    loadOhlcvInclude,
    loadProfileInclude,
    loadRiskInclude,
    loadStockOhlcvInclude,
} from '../_asset-detail-includes';
import { scheduleCacheWarm, scheduleCoinPriceWarm, scheduleStockPriceWarm } from '../_asset-detail-warm';
import { loadVariantMarkets } from '../_load-variant-markets';
import { buildAssetDetailResponse, type PreStocksMintSnapshot } from '../_asset-detail-response';
import { DEFAULT_MARKETS_STALE_MS, EQUITY_MARKETS_STALE_MS } from '../_market-cache';

function parseIncludes(raw: string | null): { includes: Set<AssetInclude>; invalid: string[] } {
    const includes = new Set<AssetInclude>();
    const invalid: string[] = [];

    const text = (raw ?? '').trim();
    if (!text) return { includes, invalid };

    for (const part of text.split(',')) {
        const value = part.trim();
        if (!value) continue;

        if ((VALID_INCLUDES as readonly string[]).includes(value)) {
            includes.add(value as AssetInclude);
            continue;
        }

        invalid.push(value);
    }

    return { includes, invalid };
}

export const GET = route(
    (request: Request, ctx: { params: Promise<{ assetId: string }>; platformAuth: PlatformAuthContext }) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const { includes, invalid } = parseIncludes(url.searchParams.get('include'));
            if (invalid.length > 0) {
                return yield* Effect.fail(
                    new BadRequestError({
                        message: `Invalid include: ${invalid[0]}`,
                        details: { allowed: VALID_INCLUDES, invalid },
                    }),
                );
            }

            const grantedScopes = ctx.platformAuth.scopes;
            const granted = new Set(grantedScopes);
            const hasAssetsRead = granted.has(ASSETS_READ_SCOPE);
            for (const include of includes) {
                const required = INCLUDE_SCOPE[include];
                // `assets:read` is the umbrella scope for the entire assets surface.
                // Fine-grained scopes remain supported for future keys, but aren't required.
                if (hasAssetsRead || granted.has(required)) continue;
                return yield* Effect.fail(
                    new ForbiddenError({
                        message: 'Insufficient scope',
                        details: { required: [required], granted: grantedScopes },
                    }),
                );
            }

            const mintRank = buildCuratedMintRank();

            const { assetId: assetRef } = yield* Effect.tryPromise(() => ctx.params);
            const resolutionContext = yield* resolveAssetRefContext(assetRef);
            const assetId = resolutionContext.assetId;
            const tokenByMint = new Map<string, TokenMarketSnapshot>();
            const marketMetaByMint = new Map<string, { lastFetchedAt: number }>();

            let asset: CanonicalAsset | null = null;

            const assetDoc = yield* cloudRunGetByAssetId({ assetId });
            if (!assetDoc) {
                const singletonMint = singletonAssetIdToMint(assetId);
                const registryAsset = singletonMint ? null : resolveRegistryAlias(assetId);
                const resolvedAsset: CanonicalAsset | null = singletonMint
                    ? yield* tokensGetByAddress({ address: singletonMint })
                          .pipe(
                              tapErrorAndDefault('assets.detail.singletonToken', null, {
                                  assetId,
                                  mint: singletonMint,
                              }),
                          )
                          .pipe(
                              Effect.map(token => {
                                  const symbol = optionalSymbol(token?.symbol);
                                  const name = optionalText(token?.name);
                                  return {
                                      assetId,
                                      ...(name ? { name } : {}),
                                      ...(symbol ? { symbol } : {}),
                                      category: 'crypto' as const,
                                      aliases: [singletonMint],
                                      variants: [
                                          {
                                              variantId: `${assetId}:${singletonMint.slice(0, 8)}`,
                                              mint: singletonMint,
                                              kind: 'native' as const,
                                              trustTier: 'tier3' as const,
                                              tags: [],
                                              ...(symbol ? { symbol } : {}),
                                              ...(name ? { name } : {}),
                                          },
                                      ],
                                  };
                              }),
                          )
                    : registryAsset;

                if (resolvedAsset) {
                    asset = resolvedAsset;

                    yield* loadVariantMarkets(request, {
                        mints: resolvedAsset.variants.map(v => v.mint),
                        fallbackSymbol: resolvedAsset.symbol,
                        fallbackName: resolvedAsset.name,
                        tokenByMint,
                        marketMetaByMint,
                    });
                } else {
                    asset = null;
                }
            } else {
                const coingeckoId = (assetDoc.coingeckoId ?? '').trim() || null;

                const registryAsset =
                    resolveRegistryAlias(assetDoc.assetId) ?? (coingeckoId ? resolveRegistryAlias(coingeckoId) : null);
                const registryName = (registryAsset?.name ?? '').trim() || null;
                const registrySymbol = (registryAsset?.symbol ?? '').trim() || null;
                const registryVariants =
                    registryAsset &&
                    (registryAsset.assetId === assetDoc.assetId ||
                        (coingeckoId && registryAsset.coingeckoId === coingeckoId))
                        ? registryAsset.variants
                        : null;

                // Variants and the CoinGecko coin doc are independent — fetch concurrently.
                const [variantsRows, coinDoc] = yield* Effect.all(
                    [
                        assetVariantsListByAssetIds({ assetIds: [assetDoc.assetId] }),
                        coingeckoId && (!registryName || !registrySymbol)
                            ? coingeckoGetCoinById({ id: coingeckoId }).pipe(
                                  tapErrorAndDefault('assets.detail.coingeckoCoin', null, {
                                      assetId,
                                      coinId: coingeckoId,
                                  }),
                              )
                            : Effect.succeed(null),
                    ],
                    { concurrency: 'unbounded' },
                );
                const variants = variantsRows[0]?.variants ?? [];

                const coinName = (coinDoc?.name ?? '').trim() || null;
                const coinSymbol = (coinDoc?.symbol ?? '').trim() ? coinDoc!.symbol.trim().toUpperCase() : null;

                const dbName = (assetDoc.name ?? '').trim() || null;
                const dbSymbol = (assetDoc.symbol ?? '').trim() || null;

                const assetName = registryName ?? coinName ?? dbName;
                const assetSymbol = registrySymbol ?? coinSymbol ?? dbSymbol;

                const variantsByMint = new Map<string, CanonicalAsset['variants'][number]>();
                for (const variant of variants) {
                    variantsByMint.set(variant.mint, {
                        variantId: variant.variantId,
                        mint: variant.mint,
                        kind: variant.kind,
                        trustTier: variant.trustTier,
                        tags: variant.tags,
                        ...(variant.issuer ? { issuer: variant.issuer } : {}),
                        ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
                        ...(variant.label ? { label: variant.label } : {}),
                        ...(variant.stockVariantTier ? { stockVariantTier: variant.stockVariantTier } : {}),
                    });
                }

                // If Convex hasn't been re-seeded yet, supplement missing (or stale) variants from the registry so
                // `/assets/solana?mint=<lst>` remains functional immediately after registry changes.
                if (registryVariants && registryVariants.length > 0) {
                    for (const variant of registryVariants) {
                        const existing = variantsByMint.get(variant.mint);
                        const mergedTags = Array.from(
                            new Set<string>([
                                ...(existing?.tags ?? []),
                                ...(Array.isArray(variant.tags) ? variant.tags : []),
                            ]),
                        );

                        variantsByMint.set(variant.mint, {
                            variantId: variant.variantId,
                            mint: variant.mint,
                            kind: variant.kind,
                            trustTier: variant.trustTier,
                            tags: mergedTags,
                            ...(existing?.issuer
                                ? { issuer: existing.issuer }
                                : variant.issuer
                                  ? { issuer: variant.issuer }
                                  : {}),
                            ...(existing?.issuerUrl
                                ? { issuerUrl: existing.issuerUrl }
                                : variant.issuerUrl
                                  ? { issuerUrl: variant.issuerUrl }
                                  : {}),
                            ...(existing?.label
                                ? { label: existing.label }
                                : variant.label
                                  ? { label: variant.label }
                                  : {}),
                            ...(existing?.stockVariantTier
                                ? { stockVariantTier: existing.stockVariantTier }
                                : variant.stockVariantTier
                                  ? { stockVariantTier: variant.stockVariantTier }
                                  : {}),
                            ...(variant.symbol ? { symbol: variant.symbol } : {}),
                            ...(variant.name ? { name: variant.name } : {}),
                        });
                    }
                }

                const assetVariants: CanonicalAsset['variants'] = canonicalizeAssetVariants(
                    assetDoc.assetId,
                    Array.from(variantsByMint.values()),
                );

                const loadedAsset: CanonicalAsset = {
                    assetId: assetDoc.assetId,
                    ...(assetName ? { name: assetName } : {}),
                    ...(assetSymbol ? { symbol: assetSymbol } : {}),
                    category: assetDoc.category,
                    aliases: assetDoc.aliases,
                    ...(coingeckoId ? { coingeckoId } : {}),
                    variants: assetVariants,
                };
                asset = loadedAsset;

                yield* loadVariantMarkets(request, {
                    mints: loadedAsset.variants.map(v => v.mint),
                    fallbackSymbol: loadedAsset.symbol,
                    fallbackName: loadedAsset.name,
                    tokenByMint,
                    marketMetaByMint,
                });
            }

            if (!asset) {
                return yield* Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));
            }

            asset = canonicalizeAsset(asset);
            const canonicalAsset = asset;

            const normalizedCoinId =
                normalizeCoinGeckoCoinIdForAsset({
                    assetId: canonicalAsset.assetId,
                    coinId: canonicalAsset.coingeckoId,
                }) ?? null;

            const requestedPrimaryVariantStrategy = url.searchParams.get('primaryVariantStrategy');
            const primaryVariantStrategy =
                requestedPrimaryVariantStrategy === null && asset.category === 'equity'
                    ? 'stock_redeemability'
                    : parsePrimaryVariantStrategy(requestedPrimaryVariantStrategy);

            const preStocksMintSet = new Set(PRE_STOCKS.map(listing => listing.mint));
            const assetPreStocksMints = canonicalAsset.variants
                .map(variant => variant.mint)
                .filter(mint => preStocksMintSet.has(mint));

            // These lookups only depend on the canonical asset — run them concurrently
            // instead of as sequential Convex round-trips.
            const [resolvedCoinId, fillQualityRows, aggregates, stockInstrument, sanctumActiveMints, preStocksEntries] =
                yield* Effect.all(
                    [
                        resolveCoinGeckoCoinIdForAsset({
                            assetId: canonicalAsset.assetId,
                            category: canonicalAsset.category,
                            name: canonicalAsset.name ?? assetDoc?.name ?? null,
                            symbol: canonicalAsset.symbol ?? assetDoc?.symbol ?? null,
                            existingCoinId: normalizedCoinId,
                        }),
                        variantFillQualityGetLatestByMints({
                                mints: canonicalAsset.variants.map(v => v.mint),
                            }).pipe(
                            tapErrorAndDefault('assets.detail.variantFillQuality', [], {
                                assetId: canonicalAsset.assetId,
                            }),
                        ),
                        assetMarketsGetLatestByAssetId({ assetId: canonicalAsset.assetId }),
                        isStockPricedCategory(canonicalAsset.category)
                            ? stockInstrumentsGetByAssetId({
                                      assetId: canonicalAsset.assetId,
                                  }).pipe(
                                  tapErrorAndDefault('assets.detail.stockInstrument', null, {
                                      assetId: canonicalAsset.assetId,
                                  }),
                              )
                            : Effect.succeed(null),
                        canonicalAsset.assetId === 'solana'
                            ? sanctumListActive({ limit: 5000 })
                                  .pipe(
                                      tapErrorAndDefault('assets.detail.sanctumLsts', [], {
                                          assetId: canonicalAsset.assetId,
                                      }),
                                  )
                                  .pipe(
                                      Effect.map((rows: Array<{ mint: string }>) =>
                                          rows.length > 0 ? new Set(rows.map(r => r.mint)) : null,
                                      ),
                                  )
                            : Effect.succeed(null),
                        assetPreStocksMints.length > 0
                            ? prestocksGetLatestByMints({ mints: assetPreStocksMints }).pipe(
                                  tapErrorAndDefault('assets.detail.prestocks', [], {
                                      assetId: canonicalAsset.assetId,
                                  }),
                              )
                            : Effect.succeed([]),
                    ],
                    { concurrency: 'unbounded' },
                );

            // PreStocks reference marks have no provider timestamp — treat a feed
            // that hasn't refreshed in 24h as dead rather than displaying it forever.
            const PRESTOCKS_MAX_AGE_MS = 24 * 60 * 60_000;
            const preStocksByMint = new Map<string, PreStocksMintSnapshot>();
            for (const entry of preStocksEntries) {
                const snapshot = entry.snapshot;
                if (!snapshot) continue;
                if (Date.now() - snapshot.lastFetchedAt > PRESTOCKS_MAX_AGE_MS) continue;
                preStocksByMint.set(entry.mint, {
                    symbol: snapshot.symbol,
                    markPriceUsd: snapshot.markPriceUsd,
                    markValuationUsd: snapshot.markValuationUsd,
                    tokenPriceUsd: snapshot.tokenPriceUsd,
                    lastFetchedAt: snapshot.lastFetchedAt,
                });
            }

            if (resolvedCoinId && asset.coingeckoId !== resolvedCoinId) {
                asset = { ...asset, coingeckoId: resolvedCoinId };
            }

            const fillQualityByMint = new Map<string, VariantExecutionQualitySnapshot>();
            for (const row of fillQualityRows) {
                const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
                if (snapshot) fillQualityByMint.set(row.mint, snapshot);
            }

            // Annotate here so the DB, singleton, and registry-fallback branches
            // above are all covered before primary selection. Flagged variants
            // stay in the payload (never a 404) — they just carry `advisory` and
            // lose primary to an unflagged sibling.
            asset = annotateAssetAdvisories(asset, yield* loadAdvisoriesOrEmpty());
            const advisories = summarizeAssetAdvisories(asset);

            // Webacy depeg / structural health is a stablecoin-only surface this
            // round (category, never `variant.kind`). Fail-open: an outage yields
            // an empty map and `pegHealth: null` on every variant.
            const stablecoinHealthByMint =
                asset.category === 'stablecoin'
                    ? yield* loadStablecoinHealthOrEmpty(asset.variants.map(v => v.mint))
                    : undefined;

            const primaryVariant = pickPrimaryVariant(asset, mintRank, tokenByMint, fillQualityByMint, {
                strategy: primaryVariantStrategy,
            });
            const token = primaryVariant ? tokenByMint.get(primaryVariant.mint) : undefined;
            const marketMeta = primaryVariant ? marketMetaByMint.get(primaryVariant.mint) : undefined;
            const symbols = listSymbols(asset, tokenByMint);
            const stats = mergeAssetStatsWithAggregates(aggregateTokenStats(asset, tokenByMint, token), aggregates);
            const imageUrl = resolveAssetImageUrl(request, {
                assetId: asset.assetId,
                symbol: asset.symbol ?? assetDoc?.symbol ?? null,
                imageUrl: assetDoc?.imageUrl ?? null,
            });

            const coinId = resolvedCoinId ?? '';
            const stockSnapshot = stockInstrument
                ? yield* stockPricesGetLatestByAssetId({ assetId: asset.assetId }).pipe(tapErrorAndDefault('assets.detail.stockPrice', null, { assetId: asset.assetId }))
                : null;
            const shouldUseStockCanonicalMarket = Boolean(stockInstrument) || isCanonicalPublicEquityAsset(asset);
            if (stockInstrument) {
                const lastFetchedAt = stockSnapshot?.lastFetchedAt ?? null;
                const isStale = lastFetchedAt === null || Date.now() - lastFetchedAt > 10 * 60_000;
                if (isStale) yield* scheduleStockPriceWarm({ assetId: asset.assetId });
            }

            let canonicalMarket:
                | {
                      source: 'coingecko';
                      coinId: string;
                      price: number | null;
                      marketCap: number | null;
                      volume24hUSD: number | null;
                      priceChange24hPercent: number | null;
                      lastFetchedAt: number | null;
                      providerLastUpdatedAt: number | null;
                  }
                | {
                      source: 'clickhouse_stock';
                      symbol: string;
                      price: number | null;
                      marketCap: number | null;
                      volume24hUSD: number | null;
                      priceChange24hPercent: number | null;
                      lastFetchedAt: number | null;
                      providerLastUpdatedAt: number | null;
                      asOf: number | null;
                  }
                | {
                      source: 'prestocks';
                      symbol: string;
                      mint: string;
                      price: number | null;
                      marketCap: number | null;
                      markPriceUsd: number | null;
                      markValuationUsd: number | null;
                      impliedValuationUsd: number | null;
                      premiumToMarkPercent: number | null;
                      volume24hUSD: number | null;
                      priceChange24hPercent: number | null;
                      lastFetchedAt: number | null;
                      providerLastUpdatedAt: number | null;
                      asOf: number | null;
                  }
                | undefined = undefined;
            let coinSnapshot: {
                priceUsd?: number | null;
                marketCapUsd?: number | null;
                volume24hUsd?: number | null;
                priceChange24hPercent?: number | null;
                lastFetchedAt?: number | null;
                providerLastUpdatedAt?: number | null;
            } | null = null;

            const companyMarketCap = computeCompanyMarketCapUsd(asset, stockSnapshot);

            // At most one PreStocks mint exists per asset today; prefer the first
            // variant with a fresh snapshot if that ever changes.
            const preStocksCanonicalMint =
                asset.variants.map(v => v.mint).find(mint => preStocksByMint.has(mint)) ?? null;
            const preStocksCanonicalSnapshot = preStocksCanonicalMint
                ? (preStocksByMint.get(preStocksCanonicalMint) ?? null)
                : null;

            if (shouldUseStockCanonicalMarket) {
                canonicalMarket = {
                    source: 'clickhouse_stock',
                    symbol: stockInstrument?.symbol ?? asset.symbol ?? asset.assetId.toUpperCase(),
                    price: stockSnapshot?.priceUsd ?? null,
                    marketCap: companyMarketCap,
                    volume24hUSD: stockSnapshot?.volume24hUsd ?? null,
                    priceChange24hPercent: stockSnapshot?.priceChange24hPercent ?? null,
                    lastFetchedAt: stockSnapshot?.lastFetchedAt ?? null,
                    providerLastUpdatedAt: stockSnapshot?.asOf ?? null,
                    asOf: stockSnapshot?.asOf ?? null,
                };
            } else if (preStocksCanonicalMint && preStocksCanonicalSnapshot) {
                // Tokenized pre-IPO exposure: the company-level benchmark is the
                // valuation implied by the token price against the PreStocks
                // reference mark, derived from OUR on-chain price so it never
                // disagrees with the displayed price.
                const derived = computePreStocksDerived(
                    preStocksCanonicalSnapshot,
                    tokenByMint.get(preStocksCanonicalMint)?.price,
                );
                canonicalMarket = {
                    source: 'prestocks',
                    symbol: preStocksCanonicalSnapshot.symbol,
                    mint: preStocksCanonicalMint,
                    price: derived.basisPriceUsd,
                    marketCap: derived.impliedValuationUsd,
                    markPriceUsd: preStocksCanonicalSnapshot.markPriceUsd,
                    markValuationUsd: preStocksCanonicalSnapshot.markValuationUsd,
                    impliedValuationUsd: derived.impliedValuationUsd,
                    premiumToMarkPercent: derived.premiumToMarkPercent,
                    volume24hUSD: null,
                    priceChange24hPercent: null,
                    lastFetchedAt: preStocksCanonicalSnapshot.lastFetchedAt,
                    providerLastUpdatedAt: preStocksCanonicalSnapshot.lastFetchedAt,
                    asOf: preStocksCanonicalSnapshot.lastFetchedAt,
                };
            } else if (coinId) {
                coinSnapshot = yield* coingeckoGetPriceLatestByCoinId({ coinId }).pipe(tapErrorAndDefault('assets.detail.coinPrice', null, { assetId: asset.assetId, coinId }));

                const lastFetchedAt = coinSnapshot?.lastFetchedAt ?? null;
                const isStale = lastFetchedAt === null || Date.now() - lastFetchedAt > 10 * 60_000;
                if (isStale) yield* scheduleCoinPriceWarm({ coinId });

                canonicalMarket = {
                    source: 'coingecko',
                    coinId,
                    price: coinSnapshot?.priceUsd ?? null,
                    marketCap: coinSnapshot?.marketCapUsd ?? null,
                    volume24hUSD: coinSnapshot?.volume24hUsd ?? null,
                    priceChange24hPercent: coinSnapshot?.priceChange24hPercent ?? null,
                    lastFetchedAt,
                    providerLastUpdatedAt: coinSnapshot?.providerLastUpdatedAt ?? null,
                };
            }

            // Contract: `stats` stays the ON-CHAIN token stats block (aggregate /
            // primary variant) even for stock-priced assets — the benchmark headline
            // is `canonicalMarket` (source: 'clickhouse_stock'), which clients
            // (asset page header, search/curated rows) prefer when present. Do NOT
            // mix `stock.priceUsd` into `stats.price`: the stats block's market
            // cap/supply are on-chain token figures, and for commodities the units
            // can differ entirely (gold: GLD ETF share vs per-oz spot tokens).
            // EXCEPTION: `stats.marketCap` for public equities prefers the
            // underlying company's market cap (price × shares outstanding) when
            // shares data is available — the tokenized-supply aggregate remains the
            // fallback and stays available per-variant.
            // EXCEPTION: when the on-chain markets are dust (a lone tiny trade
            // on an empty pool can print an arbitrary price), the stock
            // benchmark takes over percent change, and price too for public
            // equities where one token equals one share.
            const effectiveStats = selectCanonicalAssetStats({
                coingecko: shouldUseStockCanonicalMarket ? null : coinSnapshot,
                stock: stockSnapshot ? { ...stockSnapshot, marketCapUsd: companyMarketCap } : null,
                aggregate: stats,
                preferAggregateVolume24h: !shouldUseStockCanonicalMarket,
                preferStockMarket: shouldUseStockCanonicalMarket,
                stockPriceMatchesTokenUnits: isCanonicalPublicEquityAsset(asset),
            });

            const primaryMint = primaryVariant?.mint ?? null;
            const requestedMintRaw = url.searchParams.get('mint');
            const requestedMintText = (requestedMintRaw ?? '').trim();
            const pathMint =
                requestedMintText.length === 0 &&
                resolutionContext.mint &&
                asset.variants.some(v => v.mint === resolutionContext.mint)
                    ? resolutionContext.mint
                    : null;
            let includeMint = pathMint ?? primaryMint;
            const allowCoingeckoFallback = requestedMintText.length === 0 && !pathMint;
            const variantsMode = (url.searchParams.get('variantsMode') ?? '').trim();

            if (requestedMintText.length > 0) {
                const requestedMint = yield* decodeUnknownOrBadRequest(
                    SolanaAddress,
                    requestedMintText,
                    'Invalid mint',
                );
                const isVariant = asset.variants.some(v => v.mint === requestedMint);
                if (!isVariant) {
                    return yield* Effect.fail(
                        new BadRequestError({
                            message: '`mint` must be a variant of this asset',
                            details: { mint: requestedMint },
                        }),
                    );
                }
                includeMint = requestedMint;
            }

            if (includeMint) {
                const marketMeta = marketMetaByMint.get(includeMint);
                const isMissingMarket = !tokenByMint.get(includeMint);
                const variantMarketStaleMs =
                    asset.category === 'equity' ? EQUITY_MARKETS_STALE_MS : DEFAULT_MARKETS_STALE_MS;
                const isStaleMarket = !marketMeta || Date.now() - marketMeta.lastFetchedAt > variantMarketStaleMs;

                if (isMissingMarket || isStaleMarket) {
                    yield* scheduleCacheWarm(request, {
                        mint: includeMint,
                        variantMarket: true,
                        minAgeMs: isMissingMarket ? 0 : variantMarketStaleMs,
                    });
                }
            }

            const includeEffects: Array<Effect.Effect<{ key: AssetInclude; value: unknown }, never, never>> = [];

            if (includes.has('profile')) {
                includeEffects.push(
                    loadProfileInclude({ coingeckoId: asset.coingeckoId }).pipe(
                        Effect.map(value => ({ key: 'profile' as const, value })),
                    ),
                );
            }
            if (includes.has('risk')) {
                includeEffects.push(
                    Effect.succeed(includeMint).pipe(
                        Effect.flatMap(mint =>
                            mint
                                ? loadRiskInclude({
                                      primaryMint: mint,
                                      market: tokenByMint.get(mint),
                                      stablecoinHealth: stablecoinHealthByMint?.get(mint) ?? null,
                                  })
                                : Effect.succeed(includeError('not_available', 'No primary variant available')),
                        ),
                        Effect.map(value => ({ key: 'risk' as const, value })),
                    ),
                );
            }
            if (includes.has('ohlcv')) {
                const requestedOhlcvIntervalRaw = url.searchParams.get('ohlcvInterval');
                const requestedOhlcvFromRaw = url.searchParams.get('ohlcvFrom');
                const requestedOhlcvToRaw = url.searchParams.get('ohlcvTo');

                const ohlcvInterval: TimeInterval = requestedOhlcvIntervalRaw
                    ? yield* decodeUnknownOrBadRequest(
                          TimeIntervalSchema,
                          requestedOhlcvIntervalRaw,
                          'Invalid ohlcvInterval',
                      )
                    : ('1H' as const);

                const now = Math.floor(Date.now() / 1000);
                const requestedOhlcvFrom = requestedOhlcvFromRaw
                    ? yield* decodeUnknownOrBadRequest(
                          NonNegativeIntFromString,
                          requestedOhlcvFromRaw,
                          'Invalid ohlcvFrom',
                      )
                    : now - 7 * 24 * 60 * 60;
                const requestedOhlcvTo = requestedOhlcvToRaw
                    ? yield* decodeUnknownOrBadRequest(NonNegativeIntFromString, requestedOhlcvToRaw, 'Invalid ohlcvTo')
                    : now;

                const { from: ohlcvFrom, to: ohlcvTo } = yield* validateOhlcvRange({
                    from: requestedOhlcvFrom,
                    to: requestedOhlcvTo,
                    interval: ohlcvInterval,
                    fieldPrefix: 'ohlcv',
                });

                if (shouldUseStockCanonicalMarket && requestedMintText.length === 0) {
                    includeEffects.push(
                        loadStockOhlcvInclude({
                            assetId: asset.assetId,
                            interval: ohlcvInterval,
                            from: ohlcvFrom,
                            to: ohlcvTo,
                            coingeckoId: asset.coingeckoId,
                        }).pipe(Effect.map(value => ({ key: 'ohlcv' as const, value }))),
                    );
                } else if (!includeMint) {
                    includeEffects.push(
                        Effect.succeed({
                            key: 'ohlcv' as const,
                            value: includeError('not_available', 'No primary variant available'),
                        }),
                    );
                } else {
                    includeEffects.push(
                        loadOhlcvInclude(request, {
                            primaryMint: includeMint,
                            coingeckoId: asset.coingeckoId,
                            interval: ohlcvInterval,
                            from: ohlcvFrom,
                            to: ohlcvTo,
                            allowCoingeckoFallback,
                            allowUnhealthyCoingeckoFallback: asset.assetId === 'bitcoin',
                        }).pipe(Effect.map(value => ({ key: 'ohlcv' as const, value }))),
                    );
                }
            }
            if (includes.has('markets')) {
                if (!includeMint) {
                    includeEffects.push(
                        Effect.succeed({
                            key: 'markets' as const,
                            value: includeError('not_available', 'No primary variant available'),
                        }),
                    );
                } else {
                    const marketsOffset = yield* decodeOffset(url.searchParams.get('marketsOffset'), {
                        label: 'marketsOffset',
                    });
                    const marketsLimit = yield* decodeLimit(url.searchParams.get('marketsLimit'), {
                        defaultValue: '10',
                        max: 50,
                        label: 'marketsLimit',
                    });

                    includeEffects.push(
                        loadMarketsInclude(request, {
                            primaryMint: includeMint,
                            offset: marketsOffset,
                            limit: marketsLimit,
                            staleMs: asset.category === 'equity' ? EQUITY_MARKETS_STALE_MS : DEFAULT_MARKETS_STALE_MS,
                        }).pipe(Effect.map(value => ({ key: 'markets' as const, value }))),
                    );
                }
            }

            const includeEntries =
                includeEffects.length > 0 ? yield* Effect.all(includeEffects, { concurrency: 4 }) : [];
            const includesOut: Record<string, unknown> = {};
            for (const entry of includeEntries) includesOut[entry.key] = entry.value;

            return buildAssetDetailResponse({
                asset,
                advisories,
                stablecoinHealthByMint,
                assetDescription: optionalText(assetDoc?.description) ?? null,
                primaryVariant,
                token,
                tokenByMint,
                fillQualityByMint,
                marketMeta,
                marketMetaByMint,
                effectiveStats,
                imageUrl,
                symbols,
                stockSymbol: stockInstrument?.symbol ?? null,
                canonicalMarket,
                preStocksByMint,
                mintRank,
                sanctumActiveMints,
                includeMint,
                variantsMode,
                includesOut,
                hasIncludes: includeEntries.length > 0,
                resolution:
                    resolutionContext.ref !== asset.assetId ||
                    resolutionContext.mint !== null ||
                    resolutionContext.resolvedBy !== 'assetId'
                        ? resolutionContext
                        : undefined,
                primaryVariantStrategy,
            });
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 30 } },
);
