import { createHash } from 'node:crypto';
import { Array as Arr, Effect } from 'effect';

import { route } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import { decodeLimit, decodeOffset } from '@tokens/effect';
import { tapErrorAndDefault } from '@tokens/effect';
import { scheduleCoinPriceWarm as scheduleCoinPriceWarmShared } from '@/lib/cloudrun/cacheWarm';
import {
    assetCollectionsGetMembers,
    assetMarketsGetLatestByAssetIds,
    assetVariantsListByAssetIds,
    coingeckoGetPriceLatestByCoinIds,
    curatedPrefetchForApi,
    getByAssetIds as cloudRunGetByAssetIds,
    listDeletedRefs,
    sanctumListActive,
    tokenMarketsGetLatestByMints,
    variantFillQualityGetLatestByMints,
    stockInstrumentsGetByAssetIds,
    stockPricesGetLatestByAssetIds,
    variantMarketsGetLatestByMints,
    type AssetMarketsGetLatestByAssetIdsResult,
    type AssetVariantsListByAssetIdsResult,
    type CoingeckoGetPriceLatestByCoinIdsResult,
    type CuratedPrefetchResult,
    type GetByAssetIdsResult,
    type StockInstrumentsGetByAssetIdsResult,
    type StockPricesGetLatestByAssetIdsResult,
    type TokenMarketsGetLatestByMintsResult,
    type VariantMarketsGetLatestByMintsResult,
} from '@/lib/cloudrun';
import { isRetryableCloudRunError, type CloudRunError } from '@/lib/cloudrun/errors';

import {
    getVariantByMint,
    resolveAlias as resolveRegistryAlias,
    type AssetCategory,
    type CanonicalAsset,
    type VariantKind,
} from '@tokens/asset-registry';
import {
    CURATED_LIST_ORDER,
    normalizeCuratedListSlug as normalizeCuratedTokenListId,
    type CuratedListSlug as CuratedTokenListId,
} from '@tokens/asset-registry/curated-lists';
import { getEffectiveCuratedAddresses } from '../../../_curated-addresses';

import {
    resolveAssetImageUrl,
    aggregateTokenStats,
    buildCuratedMintRank,
    buildSnapshotFromTokenMarketsDoc,
    mergeAssetStatsWithAggregates,
    optionalSymbol,
    optionalText,
    parsePrimaryVariantStrategy,
    pickPrimaryVariant,
    selectCanonicalAssetStats,
    computeCompanyMarketCapUsd,
    isCanonicalPublicEquityAsset,
    isStockPricedCategory,
    resolveVariantSymbol,
    executionQualitySnapshotFromConvexFillQuality,
    tokenMarketSnapshotFromConvexMarket,
    withDerivedVariantTier,
    type AssetStats,
    type TokenMarketSnapshot,
    type VariantExecutionQualitySnapshot,
} from '../_asset-helpers';
import { looksLikeSolanaMintAddress, mintToSingletonAssetId } from '../_singleton-asset-id';
import { normalizeCoinGeckoCoinIdForAsset } from '../_coingecko-id';
import { addMemberFallbackAssets } from './_member-fallback-assets';

type CuratedTokenCategoryId = 'all' | CuratedTokenListId;

type GroupBy = 'asset' | 'mint';

const SOLANA_LST_MIN_LIQUIDITY_USD = 250_000;
const ASSET_IDS_PREFERRING_REDEEMABLE_VARIANT_PRICE = new Set(['spacex']);

function categoryForCuratedListId(listId: CuratedTokenCategoryId): AssetCategory {
    switch (listId) {
        case 'majors':
            return 'crypto';
        case 'lsts':
            return 'crypto';
        case 'currencies':
            return 'stablecoin';
        case 'rwas':
            return 'rwa';
        case 'etfs':
            return 'etf';
        case 'metals':
            return 'commodity';
        case 'stocks':
            return 'equity';
        default:
            return 'crypto';
    }
}

function kindForCuratedListId(listId: CuratedTokenCategoryId): VariantKind {
    switch (listId) {
        case 'lsts':
            return 'yield';
        case 'currencies':
            return 'stablecoin';
        case 'etfs':
            return 'etf';
        case 'stocks':
            return 'tokenized_equity';
        default:
            return 'wrapped';
    }
}

function parseGroupBy(value: string | null): GroupBy {
    return value === 'mint' ? 'mint' : 'asset';
}

function uniqueStrings(values: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function normalizeRef(value: string): string {
    return value.trim().toLowerCase();
}

function assetForCanonicalPriceSelection(asset: CanonicalAsset): CanonicalAsset {
    if (!ASSET_IDS_PREFERRING_REDEEMABLE_VARIANT_PRICE.has(asset.assetId)) return asset;

    const redeemableVariants = asset.variants.filter(
        variant => variant.stockVariantTier === 'share_redeemable' || variant.stockVariantTier === 'cash_redeemable',
    );
    if (redeemableVariants.length === 0) return asset;

    return { ...asset, variants: redeemableVariants };
}

function scheduleCoinPriceWarm(coinId: string): Effect.Effect<void, never> {
    return scheduleCoinPriceWarmShared({ coinId, label: 'assets.curated.scheduleCoinPriceWarm' });
}

/** How long a last-good curated payload stays servable as a stale fallback. */
const CURATED_STALE_TTL_SECONDS = 15 * 60;

/**
 * Health check for the stale-response cache. Since every downstream call in
 * this route defaults on failure (tapErrorAndDefault), a full backend outage
 * produces a 200 whose assets are registry-derived shells with no market
 * data. Such hollow payloads must not be cached as "last good", and callers
 * are better served by the previous healthy payload when one exists.
 */
function curatedResponseLooksHealthy(payload: Record<string, unknown>): boolean {
    const assets = (payload as { assets?: unknown }).assets;
    if (!Array.isArray(assets)) return false;
    if (assets.length === 0) {
        // An empty page past the end of the list is a legitimate response.
        const pagination = (payload as { pagination?: { total?: number; offset?: number } }).pagination;
        return Boolean(
            pagination && typeof pagination.total === 'number' && (pagination.offset ?? 0) >= pagination.total,
        );
    }
    const withStats = assets.filter(
        item => typeof item === 'object' && item !== null && (item as { stats?: unknown }).stats != null,
    ).length;
    return withStats * 2 >= assets.length;
}

function isTransientCuratedFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('_tag' in error)) return false;
    const tag = (error as { _tag?: unknown })._tag;
    if (tag !== 'CloudRunHttpError' && tag !== 'CloudRunTimeoutError' && tag !== 'CloudRunTransportError') {
        return false;
    }
    return isRetryableCloudRunError(error as CloudRunError);
}

/**
 * Cache key for the stale-response fallback. Mirrors the handler's own param
 * normalization so equivalent requests share one last-good entry. Raw values
 * that the handler would reject (e.g. `limit=abc`) still produce a key, but
 * those requests fail with a 4xx and never reach the fallback path.
 */
function curatedStaleCacheKey(request: Request): string | null {
    try {
        const searchParams = new URL(request.url).searchParams;
        const rawListId = (searchParams.get('list') ?? 'all').trim();
        const listId = rawListId === 'all' ? 'all' : (normalizeCuratedTokenListId(rawListId) ?? 'all');
        const groupBy = parseGroupBy(searchParams.get('groupBy'));
        const includeVariants = groupBy === 'asset' && (searchParams.get('variants') ?? '').trim() === 'all';
        const variantsMode = (searchParams.get('variantsMode') ?? '').trim();
        const strategy = (searchParams.get('primaryVariantStrategy') ?? '').trim();
        const shouldPaginate = searchParams.has('limit') || searchParams.has('offset');
        const offset = shouldPaginate ? (searchParams.get('offset') ?? '').trim() : '';
        const limit = shouldPaginate ? (searchParams.get('limit') ?? '').trim() : '';
        // `variants` is spread conditionally so pre-existing key hashes (incl.
        // the warmer's) stay stable.
        const canonical = JSON.stringify({
            listId,
            groupBy,
            variantsMode,
            strategy,
            pagination: shouldPaginate ? { offset, limit } : null,
            ...(includeVariants ? { variants: 'all' } : {}),
        });
        const shapeHash = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
        return `stale-response:v2:assets-curated:${shapeHash}`;
    } catch {
        return null;
    }
}

export const GET = route(
    (request: Request) => {
        const main = Effect.gen(function* () {
            const url = new URL(request.url);
            const searchParams = url.searchParams;
            const rawListId = searchParams.get('list') ?? 'all';
            const listId: CuratedTokenCategoryId = (() => {
                const trimmed = rawListId.trim();
                if (trimmed === 'all') return 'all';
                return normalizeCuratedTokenListId(trimmed) ?? 'all';
            })();
            const groupBy = parseGroupBy(searchParams.get('groupBy'));
            const includeVariants = groupBy === 'asset' && (searchParams.get('variants') ?? '').trim() === 'all';
            const shouldPaginate = searchParams.has('limit') || searchParams.has('offset');
            const offset = shouldPaginate ? yield* decodeOffset(searchParams.get('offset')) : 0;
            const limit = shouldPaginate
                ? yield* decodeLimit(searchParams.get('limit'), {
                      defaultValue: '250',
                      max: 500,
                  })
                : null;
            const variantsMode = (searchParams.get('variantsMode') ?? '').trim();
            const requestedPrimaryVariantStrategy = searchParams.get('primaryVariantStrategy');
            const primaryVariantStrategy =
                requestedPrimaryVariantStrategy === null && listId === 'stocks'
                    ? 'stock_redeemability'
                    : parsePrimaryVariantStrategy(requestedPrimaryVariantStrategy);

            const mintRank = buildCuratedMintRank();

            const memberListIds: CuratedTokenListId[] = listId === 'all' ? [...CURATED_LIST_ORDER] : [listId];

            // Registry-derived addresses are computed locally in both paths — the
            // registry is a compiled artifact shipped with the app and doesn't
            // require a Cloud Run round-trip.
            const { addresses: memberMints, sanctumLstMints } = yield* Effect.tryPromise(() =>
                getEffectiveCuratedAddresses(listId),
            );
            const memberAssetIds = memberMints.map(mint => {
                if (sanctumLstMints.has(mint)) return 'solana';
                const registryMatch = getVariantByMint(mint);
                if (registryMatch) return registryMatch.asset.assetId;
                return mintToSingletonAssetId(mint);
            });

            // Registry-derived CoinGecko IDs for the memberAssetIds. Convex assets
            // may lack a coingeckoId when Convex is behind the registry — passing
            // these to the composite ensures the server can prefetch their prices
            // in the same round-trip (avoids a residual per-call fetch on this
            // route).
            const registryCoingeckoIds: string[] = [];
            {
                const seen = new Set<string>();
                for (const assetId of memberAssetIds) {
                    const registryAsset = resolveRegistryAlias(assetId);
                    const coinId = normalizeCoinGeckoCoinIdForAsset({
                        assetId,
                        coinId: registryAsset?.coingeckoId ?? null,
                    });
                    if (coinId && !seen.has(coinId)) {
                        seen.add(coinId);
                        registryCoingeckoIds.push(coinId);
                    }
                }
            }

            // Cloud Run composite prefetch: collapses collections + tombstones +
            // sanctum + assets + variants + markets + fillQuality + aggregates +
            // stocks + coingecko-prices + tokenMarkets-fallback into a single
            // RTT. When Cloud Run is disabled we fall through to the per-handler
            // Convex path preserved below.
            const shouldLoadSanctumForPrefetch = listId === 'all' || listId === 'lsts';
            const includeStockForPrefetch = listId === 'all' || listId === 'stocks';
            const prefetch: CuratedPrefetchResult | null = yield* curatedPrefetchForApi({
                listId,
                memberMints,
                memberAssetIds,
                includeSanctum: shouldLoadSanctumForPrefetch,
                includeStock: includeStockForPrefetch,
                ...(registryCoingeckoIds.length > 0 ? { additionalCoingeckoIds: registryCoingeckoIds } : {}),
            }).pipe(
                // A missing Cloud Run configuration is the only reason to use
                // the legacy per-handler path. Runtime/5xx/timeout failures
                // propagate to the outer last-good cache instead of launching
                // a second, much wider fallback fan-out during an incident.
                Effect.catchTag('MissingEnvError', () => Effect.succeed(null)),
            );

            const collectionAssetIdsChunks: string[][] = prefetch
                ? prefetch.collectionAssetIds
                : ((yield* Effect.all(
                      memberListIds.map(id =>
                          assetCollectionsGetMembers({ slug: id, limit: 2000 }).pipe(
                              tapErrorAndDefault('assets.curated.collections', [] as string[], { listId: id }),
                          ),
                      ),
                      { concurrency: 2 },
                  )) as string[][]);

            const rawAssetIds = uniqueStrings([...memberAssetIds, ...(collectionAssetIdsChunks.flat() as string[])]);
            const deletedAssetRefRows: string[] = prefetch
                ? prefetch.deletedAssetRefs
                : rawAssetIds.length > 0
                  ? (yield* Effect.all(
                        Arr.chunksOf(rawAssetIds, 500).map(chunk =>
                            listDeletedRefs({ refs: chunk }).pipe(Effect.catch(() => Effect.succeed([] as string[]))),
                        ),
                        { concurrency: 2 },
                    )).flat()
                  : [];
            const deletedAssetRefs = new Set(deletedAssetRefRows.map((ref: string) => normalizeRef(ref)));
            const assetIds = rawAssetIds.filter(assetId => !deletedAssetRefs.has(normalizeRef(assetId)));

            // Load from Convex first (when seeded)…
            const canonicalAssetById = new Map<string, CanonicalAsset>();
            const assetImageById = new Map<string, string>();
            if (assetIds.length > 0) {
                const assetRows: GetByAssetIdsResult = [];
                if (prefetch) {
                    assetRows.push(...prefetch.assets);
                } else {
                    for (let i = 0; i < assetIds.length; i += 500) {
                        const chunk = assetIds.slice(i, i + 500);
                        const rows = yield* cloudRunGetByAssetIds({ assetIds: chunk }).pipe(
                            tapErrorAndDefault('assets.curated.assets', [] as GetByAssetIdsResult, {
                                count: chunk.length,
                            }),
                        );
                        assetRows.push(...rows);
                    }
                }
                const assetById = new Map<string, (typeof assetRows)[number]['asset']>();
                for (const row of assetRows) assetById.set(row.assetId, row.asset);
                const dbAssets = assetIds
                    .map(id => assetById.get(id) ?? null)
                    .filter((a): a is NonNullable<typeof a> => a !== null);

                const variantsRows: AssetVariantsListByAssetIdsResult = [];
                if (prefetch) {
                    variantsRows.push(...prefetch.variants);
                } else {
                    const variantAssetIds = dbAssets.map(a => a.assetId);
                    for (let i = 0; i < variantAssetIds.length; i += 250) {
                        const chunk = variantAssetIds.slice(i, i + 250);
                        const rows = yield* assetVariantsListByAssetIds({ assetIds: chunk }).pipe(
                            tapErrorAndDefault('assets.curated.variants', [] as AssetVariantsListByAssetIdsResult, {
                                count: chunk.length,
                            }),
                        );
                        variantsRows.push(...rows);
                    }
                }
                const variantsByAssetId = new Map<string, (typeof variantsRows)[number]['variants']>();
                for (const row of variantsRows) variantsByAssetId.set(row.assetId, row.variants);

                for (const a of dbAssets) {
                    const normalizedAssetId = looksLikeSolanaMintAddress(a.assetId)
                        ? mintToSingletonAssetId(a.assetId)
                        : a.assetId;

                    if (a.imageUrl && a.imageUrl.trim()) assetImageById.set(normalizedAssetId, a.imageUrl.trim());
                    const variants: CanonicalAsset['variants'] = [];
                    for (const variant of variantsByAssetId.get(a.assetId) ?? []) {
                        variants.push({
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

                    const variantsForList = variants;
                    // If no variants are present yet, allow fallbacks below to fill from the registry/singletons.
                    if (variantsForList.length === 0) continue;

                    // If the canonical registry maps these mints to a different assetId, prefer the registry.
                    // This prevents stale Convex seeds from surfacing legacy per-mint assets (e.g. `susd`)
                    // instead of the canonical aggregate asset (e.g. `usd`) in curated lists.
                    const registryAssetIds = new Set<string>();
                    for (const variant of variantsForList) {
                        const match = getVariantByMint(variant.mint);
                        if (match) registryAssetIds.add(match.asset.assetId);
                    }
                    if (registryAssetIds.size === 1) {
                        const registryAssetId = Array.from(registryAssetIds)[0] ?? null;
                        if (registryAssetId && registryAssetId !== a.assetId) continue;
                    }

                    const registryAsset =
                        resolveRegistryAlias(a.assetId) ?? (a.coingeckoId ? resolveRegistryAlias(a.coingeckoId) : null);
                    const name = (registryAsset?.name ?? '').trim() || (a.name ?? '').trim();
                    const symbol = (registryAsset?.symbol ?? '').trim() || (a.symbol ?? '').trim();
                    const coingeckoId = (a.coingeckoId ?? '').trim() || (registryAsset?.coingeckoId ?? '').trim();

                    canonicalAssetById.set(normalizedAssetId, {
                        assetId: normalizedAssetId,
                        ...(name ? { name } : {}),
                        ...(symbol ? { symbol } : {}),
                        category: a.category,
                        aliases: a.aliases,
                        ...(coingeckoId ? { coingeckoId } : {}),
                        variants: variantsForList,
                    });
                }
            }

            // …then ensure *every* DB collection member is represented, even before seeding.
            addMemberFallbackAssets({
                assetIds,
                canonicalAssetById,
                category: categoryForCuratedListId(listId),
                kind: kindForCuratedListId(listId),
                listId,
            });

            function mergeRegistryVariantMetadata(asset: CanonicalAsset): CanonicalAsset {
                const registryAsset =
                    resolveRegistryAlias(asset.assetId) ??
                    (asset.coingeckoId ? resolveRegistryAlias(asset.coingeckoId) : null);
                if (!registryAsset) return asset;

                const matchesCanonical =
                    registryAsset.assetId === asset.assetId ||
                    (asset.coingeckoId && registryAsset.coingeckoId === asset.coingeckoId) ||
                    (registryAsset.coingeckoId && registryAsset.coingeckoId === asset.assetId);
                if (!matchesCanonical) return asset;

                const registryByMint = new Map(registryAsset.variants.map(v => [v.mint, v] as const));

                const mergedVariants = asset.variants.map(variant => {
                    const registryVariant = registryByMint.get(variant.mint);
                    if (!registryVariant) return variant;

                    const mergedTags = Array.from(
                        new Set<string>([...(variant.tags ?? []), ...(registryVariant.tags ?? [])]),
                    );

                    return {
                        variantId: registryVariant.variantId,
                        mint: registryVariant.mint,
                        kind: registryVariant.kind,
                        trustTier: registryVariant.trustTier,
                        tags: mergedTags,
                        ...(variant.issuer
                            ? { issuer: variant.issuer }
                            : registryVariant.issuer
                              ? { issuer: registryVariant.issuer }
                              : {}),
                        ...(variant.issuerUrl
                            ? { issuerUrl: variant.issuerUrl }
                            : registryVariant.issuerUrl
                              ? { issuerUrl: registryVariant.issuerUrl }
                              : {}),
                        ...(variant.label
                            ? { label: variant.label }
                            : registryVariant.label
                              ? { label: registryVariant.label }
                              : {}),
                        ...(variant.stockVariantTier
                            ? { stockVariantTier: variant.stockVariantTier }
                            : registryVariant.stockVariantTier
                              ? { stockVariantTier: registryVariant.stockVariantTier }
                              : {}),
                        ...(registryVariant.symbol
                            ? { symbol: registryVariant.symbol }
                            : variant.symbol
                              ? { symbol: variant.symbol }
                              : {}),
                        ...(registryVariant.name
                            ? { name: registryVariant.name }
                            : variant.name
                              ? { name: variant.name }
                              : {}),
                    };
                });

                return { ...asset, variants: mergedVariants };
            }

            const canonicalAssets = Array.from(canonicalAssetById.values()).map(mergeRegistryVariantMetadata);

            // variants=all needs sanctum ranks too: shouldIncludeMintRow gates
            // nested solana LST variants on sanctum membership.
            const shouldLoadSanctumLsts =
                (groupBy === 'mint' || includeVariants) && (listId === 'lsts' || listId === 'all');
            // Prefetch already loaded sanctum when the caller asked for it (listId=all|lsts);
            // plain groupBy=asset short-circuits below because shouldLoadSanctumLsts is false anyway.
            const sanctumLsts = shouldLoadSanctumLsts
                ? prefetch && prefetch.sanctumLsts.length > 0
                    ? prefetch.sanctumLsts
                    : yield* sanctumListActive({ limit: 5000 }).pipe(
                          tapErrorAndDefault('assets.curated.sanctumLsts', [], { listId }),
                      )
                : [];
            const sanctumRankByMint = new Map<string, number>();
            for (const row of sanctumLsts) sanctumRankByMint.set(row.mint, row.sourceRank);
            const shouldSortBySanctumRank = listId === 'lsts' && sanctumRankByMint.size > 0;

            const uniqueMints: string[] = [];
            const seen = new Set<string>();
            for (const asset of canonicalAssets) {
                for (const variant of asset.variants) {
                    if (seen.has(variant.mint)) continue;
                    seen.add(variant.mint);
                    uniqueMints.push(variant.mint);
                }
            }

            const tokenByMint = new Map<string, TokenMarketSnapshot>();
            const fillQualityByMint = new Map<string, VariantExecutionQualitySnapshot>();
            const marketMetaByMint = new Map<string, { lastFetchedAt: number }>();
            if (uniqueMints.length > 0) {
                // Prefetched rows already cover the caller's known mints universe.
                // If a variant's mint is missing from the prefetch (e.g. registry
                // added a mint that wasn't part of memberMints), fall back to a
                // per-mint fetch — but for the common case we skip the extra RTTs.
                if (prefetch) {
                    const prefetchMints = new Set(prefetch.variantMarkets.map(r => r.mint));
                    for (const row of prefetch.variantMarkets) {
                        const market = row.market;
                        if (!market) continue;
                        if (!Number.isFinite(market.lastFetchedAt) || market.lastFetchedAt <= 0) continue;
                        marketMetaByMint.set(row.mint, { lastFetchedAt: market.lastFetchedAt });
                        tokenByMint.set(row.mint, tokenMarketSnapshotFromConvexMarket(row.mint, market));
                    }
                    const missingMints = uniqueMints.filter(m => !prefetchMints.has(m));
                    if (missingMints.length > 0) {
                        for (let i = 0; i < missingMints.length; i += 250) {
                            const chunk = missingMints.slice(i, i + 250);
                            const rows = yield* variantMarketsGetLatestByMints({ mints: chunk }).pipe(
                                tapErrorAndDefault(
                                    'assets.curated.variantMarkets.gapfill',
                                    [] as VariantMarketsGetLatestByMintsResult,
                                    { count: chunk.length },
                                ),
                            );
                            for (const row of rows) {
                                const market = row.market;
                                if (!market) continue;
                                if (!Number.isFinite(market.lastFetchedAt) || market.lastFetchedAt <= 0) continue;
                                marketMetaByMint.set(row.mint, { lastFetchedAt: market.lastFetchedAt });
                                tokenByMint.set(row.mint, tokenMarketSnapshotFromConvexMarket(row.mint, market));
                            }
                        }
                        for (let i = 0; i < missingMints.length; i += 250) {
                            const chunk = missingMints.slice(i, i + 250);
                            const rows = yield* variantFillQualityGetLatestByMints({ mints: chunk }).pipe(
                                tapErrorAndDefault('assets.curated.fillQuality.gapfill', [], { count: chunk.length }),
                            );
                            for (const row of rows) {
                                const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
                                if (snapshot) fillQualityByMint.set(row.mint, snapshot);
                            }
                        }
                    }
                    for (const row of prefetch.fillQuality) {
                        const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
                        if (snapshot) fillQualityByMint.set(row.mint, snapshot);
                    }
                } else {
                    // Convex query caps at 250 mints; chunk to ensure full coverage for large curated lists.
                    for (let i = 0; i < uniqueMints.length; i += 250) {
                        const chunk = uniqueMints.slice(i, i + 250);
                        const rows = yield* variantMarketsGetLatestByMints({ mints: chunk }).pipe(
                            tapErrorAndDefault(
                                'assets.curated.variantMarkets',
                                [] as VariantMarketsGetLatestByMintsResult,
                                { count: chunk.length },
                            ),
                        );
                        for (const row of rows) {
                            const market = row.market;
                            if (!market) continue;
                            // Skip placeholder rows inserted during seeding.
                            if (!Number.isFinite(market.lastFetchedAt) || market.lastFetchedAt <= 0) continue;
                            marketMetaByMint.set(row.mint, { lastFetchedAt: market.lastFetchedAt });
                            tokenByMint.set(row.mint, tokenMarketSnapshotFromConvexMarket(row.mint, market));
                        }
                    }

                    for (let i = 0; i < uniqueMints.length; i += 250) {
                        const chunk = uniqueMints.slice(i, i + 250);
                        const rows = yield* variantFillQualityGetLatestByMints({ mints: chunk }).pipe(
                            tapErrorAndDefault('assets.curated.variantFillQuality', [], { count: chunk.length }),
                        );
                        for (const row of rows) {
                            const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
                            if (snapshot) fillQualityByMint.set(row.mint, snapshot);
                        }
                    }
                }
            }

            const fallbackByMint = new Map<string, { symbol: string | undefined; name: string | undefined }>();
            for (const asset of canonicalAssets) {
                for (const variant of asset.variants) {
                    if (!fallbackByMint.has(variant.mint)) {
                        const fallbackSymbol =
                            resolveVariantSymbol({
                                variantSymbol: variant.symbol,
                                label: variant.label,
                                canonicalSymbol: asset.symbol,
                            }) ??
                            optionalSymbol(asset.symbol) ??
                            undefined;
                        const fallbackName = optionalText(variant.name) ?? optionalText(asset.name) ?? undefined;
                        fallbackByMint.set(variant.mint, { symbol: fallbackSymbol, name: fallbackName });
                    }
                }
            }

            function missingScoreForMint(mint: string): number {
                const token = tokenByMint.get(mint) ?? null;
                if (!token) return 1_000;

                let score = 0;
                if (!token.symbol || !token.symbol.trim()) score += 250;
                if (!token.name || !token.name.trim()) score += 250;
                if (token.decimals == null || !Number.isFinite(token.decimals) || token.decimals <= 0) score += 250;
                if (!token.logoURI || !token.logoURI.trim()) score += 150;

                // Common failure mode: Birdeye snapshot has identity but omits numeric fields.
                if (token.price == null || token.price <= 0) score += 75;
                if (token.liquidity == null || token.liquidity <= 0) score += 50;
                if (token.volume24hUSD == null || token.volume24hUSD <= 0) score += 25;

                return score;
            }

            const missingMints = uniqueMints
                .map(mint => ({ mint, score: missingScoreForMint(mint) }))
                .filter(entry => entry.score > 0)
                .sort((a, b) => b.score - a.score)
                .map(entry => entry.mint);

            // Best-effort fallback for mints missing Birdeye `token_overview` coverage:
            // derive a snapshot from cached DEX markets (limited to keep the endpoint predictable).
            const uniqueMissing = Array.from(new Set(missingMints.map(m => m.trim()).filter(Boolean))).slice(0, 25);
            if (uniqueMissing.length > 0) {
                let tokenMarketsDocs: TokenMarketsGetLatestByMintsResult;
                if (prefetch) {
                    const covered = new Set(prefetch.tokenMarketsDocs.map(d => d.mint));
                    const gap = uniqueMissing.filter(m => !covered.has(m));
                    const gapDocs =
                        gap.length > 0
                            ? yield* tokenMarketsGetLatestByMints({ mints: gap }).pipe(
                                  tapErrorAndDefault(
                                      'assets.curated.tokenMarkets.gapfill',
                                      [] as TokenMarketsGetLatestByMintsResult,
                                      { count: gap.length },
                                  ),
                              )
                            : [];
                    tokenMarketsDocs = [...prefetch.tokenMarketsDocs, ...gapDocs];
                } else {
                    tokenMarketsDocs = yield* tokenMarketsGetLatestByMints({ mints: uniqueMissing }).pipe(
                        tapErrorAndDefault('assets.curated.tokenMarkets', [] as TokenMarketsGetLatestByMintsResult, {
                            count: uniqueMissing.length,
                        }),
                    );
                }

                for (const { mint, doc } of tokenMarketsDocs) {
                    if (!doc) continue;
                    marketMetaByMint.set(mint, { lastFetchedAt: doc.lastFetchedAt });

                    const fallback = fallbackByMint.get(mint);
                    const snapshot = buildSnapshotFromTokenMarketsDoc({
                        mint,
                        assetFallbackSymbol: fallback?.symbol,
                        assetFallbackName: fallback?.name,
                        tokenMarketsDoc: doc,
                    });
                    if (!snapshot) continue;

                    const existing = tokenByMint.get(mint);
                    if (!existing) {
                        tokenByMint.set(mint, snapshot);
                        continue;
                    }

                    const merged: TokenMarketSnapshot = {
                        address: mint,
                        symbol: existing.symbol && existing.symbol.trim() ? existing.symbol : snapshot.symbol,
                        name: existing.name && existing.name.trim() ? existing.name : snapshot.name,
                        decimals:
                            typeof existing.decimals === 'number' &&
                            Number.isFinite(existing.decimals) &&
                            existing.decimals > 0
                                ? existing.decimals
                                : snapshot.decimals,
                        logoURI:
                            existing.logoURI && existing.logoURI.trim()
                                ? existing.logoURI
                                : snapshot.logoURI && snapshot.logoURI.trim()
                                  ? snapshot.logoURI
                                  : null,
                        liquidity:
                            typeof existing.liquidity === 'number' &&
                            Number.isFinite(existing.liquidity) &&
                            existing.liquidity > 0
                                ? existing.liquidity
                                : snapshot.liquidity,
                        volume24hUSD:
                            typeof existing.volume24hUSD === 'number' &&
                            Number.isFinite(existing.volume24hUSD) &&
                            existing.volume24hUSD > 0
                                ? existing.volume24hUSD
                                : snapshot.volume24hUSD,
                        price:
                            typeof existing.price === 'number' && Number.isFinite(existing.price) && existing.price > 0
                                ? existing.price
                                : snapshot.price,
                        priceChange24hPercent: existing.priceChange24hPercent ?? snapshot.priceChange24hPercent,
                        priceChange1hPercent: existing.priceChange1hPercent ?? snapshot.priceChange1hPercent,
                        marketCap:
                            typeof existing.marketCap === 'number' &&
                            Number.isFinite(existing.marketCap) &&
                            existing.marketCap > 0
                                ? existing.marketCap
                                : snapshot.marketCap,
                        fdv:
                            typeof existing.fdv === 'number' && Number.isFinite(existing.fdv) && existing.fdv > 0
                                ? existing.fdv
                                : snapshot.fdv,
                        holder:
                            typeof existing.holder === 'number' &&
                            Number.isFinite(existing.holder) &&
                            existing.holder > 0
                                ? existing.holder
                                : snapshot.holder,
                        totalSupply:
                            typeof existing.totalSupply === 'number' &&
                            Number.isFinite(existing.totalSupply) &&
                            existing.totalSupply > 0
                                ? existing.totalSupply
                                : snapshot.totalSupply,
                        circulatingSupply:
                            typeof existing.circulatingSupply === 'number' &&
                            Number.isFinite(existing.circulatingSupply) &&
                            existing.circulatingSupply > 0
                                ? existing.circulatingSupply
                                : snapshot.circulatingSupply,
                    };

                    tokenByMint.set(mint, merged);
                }
            }

            // Convex query caps at 500 assetIds; chunk to keep aggregates complete for large lists.
            const aggregateAssetIds = canonicalAssets.map(a => a.assetId);
            const assetAggregatesRows: AssetMarketsGetLatestByAssetIdsResult = [];
            if (prefetch) {
                assetAggregatesRows.push(...prefetch.assetAggregates);
            } else {
                for (let i = 0; i < aggregateAssetIds.length; i += 500) {
                    const chunk = aggregateAssetIds.slice(i, i + 500);
                    const rows = yield* assetMarketsGetLatestByAssetIds({ assetIds: chunk }).pipe(
                        tapErrorAndDefault(
                            'assets.curated.assetAggregates',
                            [] as AssetMarketsGetLatestByAssetIdsResult,
                            { count: chunk.length },
                        ),
                    );
                    assetAggregatesRows.push(...rows);
                }
            }
            const aggregatesByAssetId = new Map<string, (typeof assetAggregatesRows)[number]['market']>();
            for (const row of assetAggregatesRows) aggregatesByAssetId.set(row.assetId, row.market);

            const stockAssetIds = canonicalAssets
                .filter(asset => isStockPricedCategory(asset.category))
                .map(asset => asset.assetId);
            const stockInstrumentRows: StockInstrumentsGetByAssetIdsResult = [];
            const stockPriceRows: StockPricesGetLatestByAssetIdsResult = [];
            if (prefetch) {
                stockInstrumentRows.push(...prefetch.stockInstruments);
                stockPriceRows.push(...prefetch.stockPrices);
            } else {
                for (let i = 0; i < stockAssetIds.length; i += 500) {
                    const chunk = stockAssetIds.slice(i, i + 500);
                    if (chunk.length === 0) continue;
                    const [instrumentRows, priceRows] = yield* Effect.all([
                        stockInstrumentsGetByAssetIds({ assetIds: chunk }).pipe(
                            tapErrorAndDefault('assets.curated.stockInstruments', [], { count: chunk.length }),
                        ),
                        stockPricesGetLatestByAssetIds({ assetIds: chunk }).pipe(
                            tapErrorAndDefault('assets.curated.stockPrices', [], { count: chunk.length }),
                        ),
                    ]);
                    stockInstrumentRows.push(...instrumentRows);
                    stockPriceRows.push(...priceRows);
                }
            }
            type StockInstrument = NonNullable<(typeof stockInstrumentRows)[number]['instrument']>;
            type StockSnapshot = NonNullable<(typeof stockPriceRows)[number]['snapshot']>;
            const stockInstrumentByAssetId = new Map<string, StockInstrument>();
            for (const row of stockInstrumentRows) {
                if (row.instrument) stockInstrumentByAssetId.set(row.assetId, row.instrument);
            }
            const stockSnapshotByAssetId = new Map<string, StockSnapshot>();
            for (const row of stockPriceRows) {
                if (row.snapshot) stockSnapshotByAssetId.set(row.assetId, row.snapshot);
            }

            function applyCanonicalStats(asset: CanonicalAsset, stats: AssetStats | null): AssetStats | null {
                const stockInstrument = stockInstrumentByAssetId.get(asset.assetId) ?? null;
                const shouldUseStockCanonicalMarket = Boolean(stockInstrument) || isCanonicalPublicEquityAsset(asset);
                const coinId =
                    normalizeCoinGeckoCoinIdForAsset({ assetId: asset.assetId, coinId: asset.coingeckoId }) ?? '';
                const stockSnapshot = stockSnapshotByAssetId.get(asset.assetId) ?? null;
                return selectCanonicalAssetStats({
                    coingecko: shouldUseStockCanonicalMarket
                        ? null
                        : coinId
                          ? (priceByCoinId.get(coinId) ?? null)
                          : null,
                    stock: stockSnapshot
                        ? { ...stockSnapshot, marketCapUsd: computeCompanyMarketCapUsd(asset, stockSnapshot) }
                        : null,
                    aggregate: stats,
                    preferAggregateVolume24h: !shouldUseStockCanonicalMarket,
                    preferStockMarket: shouldUseStockCanonicalMarket,
                    stockPriceMatchesTokenUnits: isCanonicalPublicEquityAsset(asset),
                });
            }

            function canonicalMarketForAsset(asset: CanonicalAsset) {
                const stockInstrument = stockInstrumentByAssetId.get(asset.assetId) ?? null;
                const shouldUseStockCanonicalMarket = Boolean(stockInstrument) || isCanonicalPublicEquityAsset(asset);
                if (shouldUseStockCanonicalMarket) {
                    const snapshot = stockSnapshotByAssetId.get(asset.assetId) ?? null;
                    return {
                        source: 'clickhouse_stock' as const,
                        symbol: stockInstrument?.symbol ?? asset.symbol ?? asset.assetId.toUpperCase(),
                        price: snapshot?.priceUsd ?? null,
                        marketCap: computeCompanyMarketCapUsd(asset, snapshot),
                        volume24hUSD: snapshot?.volume24hUsd ?? null,
                        priceChange24hPercent: snapshot?.priceChange24hPercent ?? null,
                        lastFetchedAt: snapshot?.lastFetchedAt ?? null,
                        providerLastUpdatedAt: snapshot?.asOf ?? null,
                        asOf: snapshot?.asOf ?? null,
                    };
                }

                if ((asset.coingeckoId ?? '').trim().length === 0) return null;
                const coinId =
                    normalizeCoinGeckoCoinIdForAsset({
                        assetId: asset.assetId,
                        coinId: asset.coingeckoId,
                    }) ?? '';
                const snapshot = priceByCoinId.get(coinId) ?? null;
                return {
                    source: 'coingecko' as const,
                    coinId,
                    price: snapshot?.priceUsd ?? null,
                    marketCap: snapshot?.marketCapUsd ?? null,
                    volume24hUSD: snapshot?.volume24hUsd ?? null,
                    priceChange24hPercent: snapshot?.priceChange24hPercent ?? null,
                    lastFetchedAt: snapshot?.lastFetchedAt ?? null,
                    providerLastUpdatedAt: snapshot?.providerLastUpdatedAt ?? null,
                };
            }

            const coinIds = uniqueStrings(
                canonicalAssets
                    .map(
                        asset =>
                            normalizeCoinGeckoCoinIdForAsset({ assetId: asset.assetId, coinId: asset.coingeckoId }) ??
                            '',
                    )
                    .filter(Boolean),
            );
            const priceChunks = Arr.chunksOf(coinIds, 50);
            const canonicalPriceRows: CoingeckoGetPriceLatestByCoinIdsResult = prefetch
                ? prefetch.coingeckoPrices
                : priceChunks.length > 0
                  ? (yield* Effect.all(
                        priceChunks.map(chunk =>
                            coingeckoGetPriceLatestByCoinIds({ coinIds: chunk }).pipe(
                                tapErrorAndDefault(
                                    'assets.curated.coingeckoPrices',
                                    [] as CoingeckoGetPriceLatestByCoinIdsResult,
                                    { count: chunk.length },
                                ),
                            ),
                        ),
                        { concurrency: 2 },
                    )).flat()
                  : [];
            const priceByCoinId = new Map<string, (typeof canonicalPriceRows)[number]['snapshot']>();
            for (const row of canonicalPriceRows) priceByCoinId.set(row.coinId, row.snapshot);

            const staleCoinIds = coinIds.filter(coinId => {
                const snapshot = priceByCoinId.get(coinId) ?? null;
                const lastFetchedAt = snapshot?.lastFetchedAt ?? null;
                return lastFetchedAt === null || Date.now() - lastFetchedAt > 10 * 60_000;
            });
            if (staleCoinIds.length > 0) {
                yield* Effect.all(
                    staleCoinIds.slice(0, 10).map(id => scheduleCoinPriceWarm(id)),
                    { concurrency: 2 },
                );
            }

            function shouldIncludeMintRow(
                asset: CanonicalAsset,
                variant: CanonicalAsset['variants'][number],
                token: TokenMarketSnapshot | undefined,
            ): boolean {
                if (asset.assetId !== 'solana') return true;

                const isYieldVariant = variant.kind === 'yield' || variant.kind === 'lst';
                if (listId === 'all' && !isYieldVariant) return true;
                if (listId !== 'all' && listId !== 'lsts') return true;

                if (sanctumRankByMint.size > 0 && !sanctumRankByMint.has(variant.mint)) return false;
                if (variantsMode === 'all') return true;

                const liquidity = token?.liquidity ?? 0;
                return (
                    typeof liquidity === 'number' &&
                    Number.isFinite(liquidity) &&
                    liquidity >= SOLANA_LST_MIN_LIQUIDITY_USD
                );
            }

            function primaryVariantStrategyForAsset(asset: CanonicalAsset) {
                if (requestedPrimaryVariantStrategy === null && asset.category === 'equity')
                    return 'stock_redeemability';
                return primaryVariantStrategy;
            }

            function makeVariantWithMarketBuilder(ctx: {
                responseSymbol: string | undefined;
                imageUrl: string | null;
            }) {
                return function buildVariantWithMarket(variant: CanonicalAsset['variants'][number]) {
                    const token = tokenByMint.get(variant.mint);
                    const marketMeta = marketMetaByMint.get(variant.mint);
                    const variantSymbol = resolveVariantSymbol({
                        variantSymbol: variant.symbol,
                        marketSymbol: token?.symbol,
                        label: variant.label,
                        canonicalSymbol: ctx.responseSymbol,
                    });
                    const variantName =
                        optionalText(variant.name) ??
                        optionalText(token?.name) ??
                        optionalText(variant.label) ??
                        variantSymbol;
                    const market = token
                        ? {
                              ...(token.source ? { source: token.source } : {}),
                              ...(token.metricsSource ? { metricsSource: token.metricsSource } : {}),
                              price: token.price,
                              liquidity: token.liquidity,
                              volume1hUSD: token.volume1hUSD ?? null,
                              volume24hUSD: token.volume24hUSD,
                              trade1h: token.trade1h ?? null,
                              trade24h: token.trade24h ?? null,
                              uniqueWallet1h: token.uniqueWallet1h ?? null,
                              uniqueWallet24h: token.uniqueWallet24h ?? null,
                              marketCap: token.marketCap,
                              fdv: token.fdv,
                              holder: token.holder,
                              totalSupply: token.totalSupply,
                              circulatingSupply: token.circulatingSupply,
                              priceChange24hPercent: token.priceChange24hPercent,
                              priceChange1hPercent: token.priceChange1hPercent,
                              decimals: token.decimals,
                              logoURI: token.logoURI ?? ctx.imageUrl ?? null,
                              lastTradeAt: token.lastTradeAt ?? null,
                              asOf: token.asOf ?? null,
                              lastFetchedAt: marketMeta ? marketMeta.lastFetchedAt : null,
                          }
                        : null;
                    const executionQuality = fillQualityByMint.get(variant.mint) ?? null;

                    return withDerivedVariantTier(
                        {
                            ...variant,
                            ...(variantSymbol ? { symbol: variantSymbol } : {}),
                            ...(variantName ? { name: variantName } : {}),
                            market,
                            executionQuality,
                        },
                        market?.liquidity,
                    );
                };
            }

            const results =
                groupBy === 'mint'
                    ? (() => {
                          const rows = canonicalAssets.flatMap(asset => {
                              const primaryAsset = assetForCanonicalPriceSelection(asset);
                              const aggregates = aggregatesByAssetId.get(asset.assetId) ?? null;
                              const primaryVariantForStats = pickPrimaryVariant(
                                  primaryAsset,
                                  mintRank,
                                  tokenByMint,
                                  fillQualityByMint,
                                  { strategy: primaryVariantStrategyForAsset(asset) },
                              );
                              const primaryTokenForStats = primaryVariantForStats
                                  ? tokenByMint.get(primaryVariantForStats.mint)
                                  : undefined;
                              const stats = mergeAssetStatsWithAggregates(
                                  aggregateTokenStats(asset, tokenByMint, primaryTokenForStats),
                                  aggregates,
                              );
                              const effectiveStats = applyCanonicalStats(asset, stats);
                              const canonicalMarket = canonicalMarketForAsset(asset);
                              const responseSymbol =
                                  stockInstrumentByAssetId.get(asset.assetId)?.symbol ?? asset.symbol;
                              const imageUrl = resolveAssetImageUrl(request, {
                                  assetId: asset.assetId,
                                  symbol: responseSymbol ?? null,
                                  imageUrl: assetImageById.get(asset.assetId) ?? null,
                              });

                              const buildVariantWithMarket = makeVariantWithMarketBuilder({
                                  responseSymbol,
                                  imageUrl,
                              });

                              return asset.variants
                                  .filter(variant =>
                                      shouldIncludeMintRow(asset, variant, tokenByMint.get(variant.mint)),
                                  )
                                  .map(variant => {
                                      const out = {
                                          assetId: asset.assetId,
                                          name: asset.name,
                                          symbol: responseSymbol,
                                          category: asset.category,
                                          imageUrl,
                                          stats: effectiveStats,
                                          ...(canonicalMarket ? { canonicalMarket } : {}),
                                          primaryVariant: buildVariantWithMarket(variant),
                                      };

                                      const rank = shouldSortBySanctumRank
                                          ? (sanctumRankByMint.get(variant.mint) ?? Number.POSITIVE_INFINITY)
                                          : null;
                                      return { rank, out };
                                  });
                          });

                          if (shouldSortBySanctumRank) {
                              rows.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
                          } else {
                              rows.sort((a, b) => (b.out.stats?.volume24hUSD ?? 0) - (a.out.stats?.volume24hUSD ?? 0));
                          }

                          return rows.map(r => r.out);
                      })()
                    : canonicalAssets
                          .map(asset => {
                              const primaryAsset = assetForCanonicalPriceSelection(asset);
                              const primaryVariant = pickPrimaryVariant(
                                  primaryAsset,
                                  mintRank,
                                  tokenByMint,
                                  fillQualityByMint,
                                  {
                                      strategy: primaryVariantStrategyForAsset(asset),
                                  },
                              );
                              const token = primaryVariant ? tokenByMint.get(primaryVariant.mint) : undefined;
                              const aggregates = aggregatesByAssetId.get(asset.assetId) ?? null;

                              const stats = mergeAssetStatsWithAggregates(
                                  aggregateTokenStats(asset, tokenByMint, token),
                                  aggregates,
                              );
                              const effectiveStats = applyCanonicalStats(asset, stats);
                              const canonicalMarket = canonicalMarketForAsset(asset);
                              const responseSymbol =
                                  stockInstrumentByAssetId.get(asset.assetId)?.symbol ?? asset.symbol;
                              const imageUrl = resolveAssetImageUrl(request, {
                                  assetId: asset.assetId,
                                  symbol: responseSymbol ?? null,
                                  imageUrl: assetImageById.get(asset.assetId) ?? null,
                              });
                              const buildVariantWithMarket = makeVariantWithMarketBuilder({
                                  responseSymbol,
                                  imageUrl,
                              });
                              // Same eligibility gate as groupBy=mint rows, so nested
                              // counts agree with mint-grouping for the same params.
                              const variants = includeVariants
                                  ? asset.variants
                                        .filter(variant =>
                                            shouldIncludeMintRow(asset, variant, tokenByMint.get(variant.mint)),
                                        )
                                        .map(buildVariantWithMarket)
                                        .sort(
                                            (a, b) => (b.market?.liquidity ?? 0) - (a.market?.liquidity ?? 0),
                                        )
                                  : null;

                              return {
                                  assetId: asset.assetId,
                                  name: asset.name,
                                  symbol: responseSymbol,
                                  category: asset.category,
                                  imageUrl,
                                  stats: effectiveStats,
                                  ...(canonicalMarket ? { canonicalMarket } : {}),
                                  primaryVariant: primaryVariant ? buildVariantWithMarket(primaryVariant) : null,
                                  ...(variants ? { variants } : {}),
                              };
                          })
                          .sort((a, b) => (b.stats?.volume24hUSD ?? 0) - (a.stats?.volume24hUSD ?? 0));

            const total = results.length;
            if (!shouldPaginate || limit === null) {
                return {
                    listId,
                    primaryVariantStrategy,
                    assets: results,
                };
            }

            const assets = results.slice(offset, offset + limit);
            const nextOffset = offset + assets.length;
            const hasMore = nextOffset < total;

            return {
                listId,
                primaryVariantStrategy,
                pagination: {
                    offset,
                    limit,
                    total,
                    hasMore,
                    nextOffset: hasMore ? nextOffset : null,
                },
                assets,
            };
        });

        // Degrade gracefully: serve the last-good payload (marked
        // `stale: true`) when the live path fails with a server-side error or
        // 200s with a hollow, all-defaults body — e.g. the composite prefetch
        // AND its per-handler fallbacks both hit an upstream timeout burst
        // (2026-07-18 incident).
        const cacheKey = curatedStaleCacheKey(request);
        if (!cacheKey) return main;
        return withStaleFallback(
            {
                operation: 'assets.curated',
                cacheKey,
                ttlSeconds: CURATED_STALE_TTL_SECONDS,
                freshSeconds: 60,
                isHealthy: curatedResponseLooksHealthy,
                shouldFallback: isTransientCuratedFailure,
            },
            main,
        );
    },
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 30, staleWhileRevalidate: 60 } },
);
