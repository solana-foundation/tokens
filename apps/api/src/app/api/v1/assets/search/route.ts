import { Array as Arr, Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError } from '@tokens/effect';
import { decodeLimit } from '@tokens/effect';
import { tapErrorAndDefault } from '@tokens/effect';
import {
    annotateAssetAdvisories,
    filterHiddenVariants,
    loadAdvisoriesOrEmpty,
    summarizeAssetAdvisories,
    type AssetAdvisorySummaryEntry,
} from '@/lib/advisories';
import { scheduleCoinPriceWarm as scheduleCoinPriceWarmShared } from '@/lib/cloudrun/cacheWarm';
import {
    assetMarketsGetLatestByAssetIds,
    assetVariantsListByAssetIds,
    assetVariantsListByMints,
    coingeckoGetCoinById,
    coingeckoGetPriceLatestByCoinIds,
    getByAssetId as cloudRunGetByAssetId,
    listDeletedRefs,
    sanctumResolveRef,
    search as cloudRunSearch,
    searchPrefetchForApi,
    stockInstrumentsGetByAssetIds,
    stockPricesGetLatestByAssetIds,
    tokenMarketsGetLatestByMints,
    tokensSearchTokens,
    variantFillQualityGetLatestByMints,
    variantMarketsGetLatestByMints,
    type SearchPrefetchResult,
    type StockInstrumentsGetByAssetIdsResult,
    type StockPricesGetLatestByAssetIdsResult,
    type TokenMarketsGetLatestByMintsResult,
} from '@/lib/cloudrun';

import type { AssetCategory, CanonicalAsset } from '@tokens/asset-registry';
import {
    getVariantByMint,
    isHiddenAdvisory,
    listCategories,
    resolveAlias as resolveRegistryAlias,
    searchAssets as searchRegistryAssets,
} from '@tokens/asset-registry';
import {
    resolveAssetImageUrl,
    aggregateTokenStats,
    buildCuratedMintRank,
    buildSnapshotFromTokenMarketsDoc,
    mergeAssetStatsWithAggregates,
    normalizeText,
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

function parseCategory(raw: string | null): AssetCategory | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const categories = listCategories();
    return categories.includes(trimmed as AssetCategory) ? (trimmed as AssetCategory) : null;
}

function normalizeOptionalText(value: string | undefined | null): string | null {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return null;
    if (trimmed === '—') return null;
    if (trimmed === '???') return null;
    return trimmed;
}

function normalizeOptionalSymbol(value: string | undefined | null): string | null {
    const trimmed = normalizeOptionalText(value);
    if (!trimmed) return null;
    // Avoid accidentally surfacing a Solana mint as a "symbol".
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed)) return null;
    return trimmed.toUpperCase();
}

function uniqueStrings(values: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
        const value = raw.trim();
        if (!value) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
    }
    return out;
}

function scheduleCoinPriceWarm(coinId: string): Effect.Effect<void, never> {
    return scheduleCoinPriceWarmShared({ coinId, label: 'assets.search.scheduleCoinPriceWarm' });
}

interface AssetDocLike {
    assetId: string;
    name?: string | null;
    symbol?: string | null;
    category: AssetCategory;
    aliases: string[];
    coingeckoId?: string | null;
    imageUrl?: string | null;
}

export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const q = (url.searchParams.get('q') ?? '').trim();
            const qOriginal = q;
            const limit = yield* decodeLimit(url.searchParams.get('limit'), { defaultValue: '20', max: 50 });
            const includeVariants = (url.searchParams.get('variants') ?? '').trim() === 'all';
            const primaryVariantStrategy = parsePrimaryVariantStrategy(url.searchParams.get('primaryVariantStrategy'));

            if (!q) {
                return yield* Effect.fail(new BadRequestError({ message: 'Missing required query param: q' }));
            }

            const rawCategory = url.searchParams.get('category');
            const category = parseCategory(rawCategory);
            if (rawCategory && !category) {
                return yield* Effect.fail(
                    new BadRequestError({
                        message: `Invalid category: ${rawCategory}`,
                        details: { categories: listCategories() },
                    }),
                );
            }

            const mintRank = buildCuratedMintRank();

            const shouldConsiderSanctumLsts = category === null || category === 'crypto';
            const shouldSearchTokens = category === null || category === 'crypto';

            // Registry-side matches computed locally (registry is compiled with
            // the app; no round-trip). Feeding these into the composite lets the
            // server include them in phase-3 batch reads (aggregates, stocks,
            // variantMarkets, coingecko prices, tokenMarkets fallback) — otherwise
            // route.ts would have to fire per-call fetches for them after the
            // prefetch returns.
            const registrySearchMatches = searchRegistryAssets(qOriginal, {
                ...(category ? { category } : {}),
                limit: Math.min(limit * 2, 50),
            });
            const additionalAssetIds = uniqueStrings(registrySearchMatches.map(a => a.assetId));
            const additionalMintsSet = new Set<string>();
            const additionalCoingeckoIdsSet = new Set<string>();
            for (const asset of registrySearchMatches) {
                for (const variant of asset.variants) {
                    if (variant.mint) additionalMintsSet.add(variant.mint);
                }
                const coinId = normalizeCoinGeckoCoinIdForAsset({
                    assetId: asset.assetId,
                    coinId: asset.coingeckoId ?? null,
                });
                if (coinId) additionalCoingeckoIdsSet.add(coinId);
            }
            const additionalMints = Array.from(additionalMintsSet);
            const additionalCoingeckoIds = Array.from(additionalCoingeckoIdsSet);

            // Cloud Run composite prefetch: collapses sanctumResolveRef +
            // cloudRunSearch + tokensSearchTokens + assetVariantsListByMints +
            // extras hydration + variantMarkets + fillQuality + aggregates +
            // stocks + coingecko prices + tokenMarkets fallback into a single
            // RTT. When Cloud Run is disabled (or the composite fails), we fall
            // through to the per-handler Convex path preserved below. Shape is
            // preserved by construction because the composite returns the same
            // rows the individual calls would.
            const prefetch: SearchPrefetchResult | null = yield* searchPrefetchForApi({
                    query: qOriginal,
                    ...(category ? { category } : {}),
                    searchLimit: Math.min(limit * 2, 50),
                    tokensLimit: Math.min(limit * 2, 50),
                    includeSanctum: shouldConsiderSanctumLsts,
                    includeTokensSearch: shouldSearchTokens,
                    ...(additionalAssetIds.length > 0 ? { additionalAssetIds } : {}),
                    ...(additionalMints.length > 0 ? { additionalMints } : {}),
                    ...(additionalCoingeckoIds.length > 0 ? { additionalCoingeckoIds } : {}),
                    combinedAssetIdsCap: Math.max(limit * 4, 250),
                }).pipe(tapErrorAndDefault<SearchPrefetchResult | null>('assets.search.composite', null, { query: qOriginal }));

            const sanctumMatch = prefetch
                ? prefetch.sanctumMatch
                : shouldConsiderSanctumLsts
                  ? yield* sanctumResolveRef({ ref: qOriginal }).pipe(
                        tapErrorAndDefault('assets.search.sanctumResolveRef', null, { query: qOriginal }),
                    )
                  : null;
            const effectiveAssetQuery = sanctumMatch ? 'solana' : q;

            const assetsFromDb = (prefetch
                ? prefetch.assets
                : yield* cloudRunSearch({
                          query: effectiveAssetQuery,
                          ...(category ? { category } : {}),
                          limit: Math.min(limit * 2, 50),
                      })) as AssetDocLike[];
            const legacyMintAssetsFromDb = assetsFromDb.filter(a => looksLikeSolanaMintAddress(a.assetId));
            const canonicalAssetsFromDb = assetsFromDb.filter(a => !looksLikeSolanaMintAddress(a.assetId));
            const assetImageById = new Map<string, string>();
            for (const asset of canonicalAssetsFromDb) {
                if (asset.imageUrl && asset.imageUrl.trim()) assetImageById.set(asset.assetId, asset.imageUrl.trim());
            }

            const tokenMatches = prefetch
                ? prefetch.tokens
                : shouldSearchTokens
                  ? ((yield* tokensSearchTokens({
                            query: qOriginal,
                            limit: Math.min(limit * 2, 50),
                        }).pipe(tapErrorAndDefault('assets.search.tokenSearch', [], { query: qOriginal }))) as Array<{
                        address: string;
                        symbol: string;
                        name: string;
                        decimals: number;
                        logoURI?: string;
                        liquidity: number;
                        volume24hUSD: number;
                        price: number;
                        priceChange24hPercent: number;
                        priceChange1hPercent?: number;
                        marketCap: number;
                    }>)
                  : [];

            const tokenMints = tokenMatches
                .map(t => t.address)
                .filter(looksLikeSolanaMintAddress)
                .slice(0, 250);
            const variantsByTokenMint = prefetch
                ? prefetch.variantsByTokenMint
                : tokenMints.length
                  ? yield* assetVariantsListByMints({ mints: tokenMints })
                  : [];

            const canonicalMintSet = new Set<string>();
            const canonicalAssetIdSet = new Set<string>();
            for (const row of variantsByTokenMint) {
                if (!row.variant) continue;
                // Treat legacy per-mint assets as singletons (never return mint-like assetIds).
                if (looksLikeSolanaMintAddress(row.variant.assetId)) continue;
                canonicalMintSet.add(row.mint);
                canonicalAssetIdSet.add(row.variant.assetId);
            }

            const existingAssetIdSet = new Set<string>(canonicalAssetsFromDb.map(a => a.assetId));
            const missingCanonicalAssetIds = Array.from(canonicalAssetIdSet)
                .filter(assetId => !existingAssetIdSet.has(assetId))
                .slice(0, 25);

            // Extras hydration: when the composite prefetch is active it already
            // batched these into a single call (`prefetch.extraAssets`), so we
            // just index into that. Otherwise fall back to the per-id fanout.
            const extraAssetDocs: Array<AssetDocLike | null> = prefetch
                ? prefetch.extraAssets.map(entry => (entry.asset as AssetDocLike | null) ?? null)
                : missingCanonicalAssetIds.length > 0
                  ? yield* Effect.all(
                        missingCanonicalAssetIds.map(assetId =>
                            cloudRunGetByAssetId({ assetId }).pipe(
                                tapErrorAndDefault('assets.search.extraAssetDoc', null, { assetId }),
                            ),
                        ),
                        { concurrency: 10 },
                    )
                  : [];

            const canonicalDocsById = new Map<string, AssetDocLike>();
            for (const asset of canonicalAssetsFromDb) canonicalDocsById.set(asset.assetId, asset);
            for (const extra of extraAssetDocs) {
                if (!extra) continue;
                const doc = extra as unknown as AssetDocLike;
                canonicalDocsById.set(doc.assetId, doc);
                if (doc.imageUrl && doc.imageUrl.trim()) assetImageById.set(doc.assetId, doc.imageUrl.trim());
            }

            // `registrySearchMatches` was already computed above the composite
            // call so its universes could be handed to the server. Reuse it.
            if (registrySearchMatches.length > 0) {
                const registryRefs = uniqueStrings(
                    registrySearchMatches.flatMap(asset => [
                        asset.assetId,
                        asset.name ?? '',
                        asset.symbol ?? '',
                        asset.coingeckoId ?? '',
                        ...asset.aliases,
                    ]),
                );
                const deletedRegistryRefs = new Set(
                    registryRefs.length > 0
                        ? yield* listDeletedRefs({
                                  refs: registryRefs.slice(0, 2000),
                              }).pipe(tapErrorAndDefault('assets.search.registryDeletedRefs', [], { query: qOriginal }))
                        : [],
                );

                for (const asset of registrySearchMatches) {
                    if (canonicalDocsById.has(asset.assetId)) continue;
                    const refs = [
                        asset.assetId,
                        asset.name ?? '',
                        asset.symbol ?? '',
                        asset.coingeckoId ?? '',
                        ...asset.aliases,
                    ];
                    if (refs.some(ref => deletedRegistryRefs.has(ref.trim().toLowerCase()))) continue;

                    canonicalDocsById.set(asset.assetId, {
                        assetId: asset.assetId,
                        ...(asset.name ? { name: asset.name } : {}),
                        ...(asset.symbol ? { symbol: asset.symbol } : {}),
                        category: asset.category,
                        aliases: asset.aliases,
                        ...(asset.coingeckoId ? { coingeckoId: asset.coingeckoId } : {}),
                    });
                }
            }
            const canonicalDocs = Array.from(canonicalDocsById.values());

            const firstPage = canonicalDocs.slice(0, limit);
            const coingeckoIdsToFetch = Array.from(
                new Set(
                    firstPage
                        .filter(a => {
                            const dbName = normalizeOptionalText(a.name);
                            const dbSymbol = normalizeOptionalSymbol(a.symbol);
                            if (dbName && dbSymbol) return false;

                            const registryAsset =
                                resolveRegistryAlias(a.assetId) ??
                                (a.coingeckoId ? resolveRegistryAlias(a.coingeckoId) : null);
                            const registryName = normalizeOptionalText(registryAsset?.name);
                            const registrySymbol = normalizeOptionalSymbol(registryAsset?.symbol);

                            // Only fetch CoinGecko metadata if we still don't have both fields.
                            if (dbName || registryName) {
                                if (dbSymbol || registrySymbol) return false;
                            }
                            if (dbSymbol || registrySymbol) {
                                if (dbName || registryName) return false;
                            }

                            return Boolean(a.coingeckoId);
                        })
                        .flatMap(a => (a.coingeckoId ? [a.coingeckoId.trim()] : []))
                        .filter(Boolean),
                ),
            ).slice(0, 50);

            const coinById = new Map<string, { name?: string; symbol?: string }>();
            if (coingeckoIdsToFetch.length > 0) {
                const rows = yield* Effect.all(
                    coingeckoIdsToFetch.map(id =>
                        coingeckoGetCoinById({ id }).pipe(
                            Effect.map(coin => [id, coin] as const),
                            Effect.catch(() => Effect.succeed([id, null] as const)),
                        ),
                    ),
                    // Avoid bursting Convex queries at scale.
                    { concurrency: 10 },
                );
                for (const [id, coin] of rows) if (coin) coinById.set(id, { name: coin.name, symbol: coin.symbol });
            }

            const assetIds = firstPage.map(a => a.assetId);
            const variantsRows = prefetch
                ? prefetch.variantsByAssetId
                : yield* assetVariantsListByAssetIds({ assetIds });
            const variantsByAssetId = new Map<string, (typeof variantsRows)[number]['variants']>();
            for (const row of variantsRows) variantsByAssetId.set(row.assetId, row.variants);

            const assets: CanonicalAsset[] = firstPage.map(a => {
                const registryAsset =
                    resolveRegistryAlias(a.assetId) ?? (a.coingeckoId ? resolveRegistryAlias(a.coingeckoId) : null);
                const coin = a.coingeckoId ? (coinById.get(a.coingeckoId) ?? null) : null;

                const name =
                    normalizeOptionalText(registryAsset?.name) ??
                    normalizeOptionalText(coin?.name) ??
                    normalizeOptionalText(a.name) ??
                    undefined;
                const symbol =
                    normalizeOptionalSymbol(registryAsset?.symbol) ??
                    normalizeOptionalSymbol(coin?.symbol) ??
                    normalizeOptionalSymbol(a.symbol) ??
                    undefined;

                const coingeckoId =
                    normalizeOptionalText(a.coingeckoId) ??
                    normalizeOptionalText(registryAsset?.coingeckoId) ??
                    undefined;

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

                return {
                    assetId: a.assetId,
                    ...(name ? { name } : {}),
                    ...(symbol ? { symbol } : {}),
                    category: a.category,
                    aliases: a.aliases,
                    ...(coingeckoId ? { coingeckoId } : {}),
                    variants,
                };
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
                const variantsByMint = new Map(asset.variants.map(v => [v.mint, v] as const));
                for (const registryVariant of registryAsset.variants) {
                    if (!variantsByMint.has(registryVariant.mint)) {
                        variantsByMint.set(registryVariant.mint, registryVariant);
                    }
                }

                const mergedVariants = Array.from(variantsByMint.values()).map(variant => {
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
                        ...(variant.advisory !== undefined ? { advisory: variant.advisory } : {}),
                    };
                });

                return {
                    ...asset,
                    category: registryAsset.category,
                    variants: mergedVariants,
                };
            }

            const mergedAssets = assets.map(mergeRegistryVariantMetadata);

            // Advisory set for this request (fail-open: empty on outage).
            // `blocked` mints are hidden from search; `compromised`/`caution`
            // stay visible with the advisory attached.
            const advisoriesByMint = yield* loadAdvisoriesOrEmpty();
            const isHiddenMint = (mint: string) => isHiddenAdvisory(advisoriesByMint.get(mint));

            const singletonSlots = Math.max(0, limit - mergedAssets.length);
            const singletonAssets: CanonicalAsset[] = [];
            if (singletonSlots > 0) {
                const seenSingletonAssetIds = new Set<string>(mergedAssets.map(a => a.assetId));

                for (const legacy of legacyMintAssetsFromDb) {
                    if (singletonAssets.length >= singletonSlots) break;
                    const mint = (legacy.assetId ?? '').trim();
                    if (!looksLikeSolanaMintAddress(mint)) continue;
                    if (isHiddenMint(mint)) continue;

                    const singletonAssetId = mintToSingletonAssetId(mint);
                    if (seenSingletonAssetIds.has(singletonAssetId)) continue;
                    seenSingletonAssetIds.add(singletonAssetId);

                    const symbol = optionalSymbol(legacy.symbol);
                    const name = optionalText(legacy.name);
                    const aliases = Array.from(
                        new Set<string>(
                            [singletonAssetId, mint, ...legacy.aliases].map(v => normalizeText(v)).filter(Boolean),
                        ),
                    );

                    singletonAssets.push({
                        assetId: singletonAssetId,
                        ...(name ? { name } : {}),
                        ...(symbol ? { symbol } : {}),
                        category: legacy.category,
                        aliases,
                        variants: [
                            {
                                variantId: `${singletonAssetId}:mint`,
                                mint,
                                kind: 'native',
                                trustTier: 'tier3',
                                tags: [],
                                ...(symbol ? { label: symbol } : {}),
                                ...(symbol ? { symbol } : {}),
                                ...(name ? { name } : {}),
                            },
                        ],
                    });
                }

                for (const token of tokenMatches) {
                    if (singletonAssets.length >= singletonSlots) break;

                    const mint = (token.address ?? '').trim();
                    if (!looksLikeSolanaMintAddress(mint)) continue;
                    if (canonicalMintSet.has(mint)) continue;
                    if (isHiddenMint(mint)) continue;

                    const registryMatch = getVariantByMint(mint);
                    if (registryMatch) {
                        if (category && registryMatch.asset.category !== category) continue;
                        if (!seenSingletonAssetIds.has(registryMatch.asset.assetId)) {
                            seenSingletonAssetIds.add(registryMatch.asset.assetId);
                            singletonAssets.push(registryMatch.asset);
                        }
                        continue;
                    }

                    const singletonAssetId = mintToSingletonAssetId(mint);
                    if (seenSingletonAssetIds.has(singletonAssetId)) continue;
                    seenSingletonAssetIds.add(singletonAssetId);

                    const symbol = optionalSymbol(token.symbol);
                    const name = optionalText(token.name);
                    const aliases = Array.from(
                        new Set<string>(
                            [singletonAssetId, mint, token.symbol, token.name]
                                .map(v => normalizeText(v))
                                .filter(Boolean),
                        ),
                    );

                    singletonAssets.push({
                        assetId: singletonAssetId,
                        ...(name ? { name } : {}),
                        ...(symbol ? { symbol } : {}),
                        category: 'crypto',
                        aliases,
                        variants: [
                            {
                                variantId: `${singletonAssetId}:mint`,
                                mint,
                                kind: 'native',
                                trustTier: 'tier3',
                                tags: [],
                                ...(symbol ? { label: symbol } : {}),
                                ...(symbol ? { symbol } : {}),
                                ...(name ? { name } : {}),
                            },
                        ],
                    });
                }
            }

            // Annotate every variant, summarize per asset (including variants
            // hidden below, so the page can show a sibling notice), then drop
            // `blocked` variants — and whole assets when nothing remains.
            const advisoriesByAssetId = new Map<string, AssetAdvisorySummaryEntry[]>();
            const combinedAssets = [...mergedAssets, ...singletonAssets].flatMap(asset => {
                const annotated = annotateAssetAdvisories(asset, advisoriesByMint);
                advisoriesByAssetId.set(asset.assetId, summarizeAssetAdvisories(annotated));
                const visible = filterHiddenVariants(annotated, advisoriesByMint);
                return visible ? [visible] : [];
            });

            const tokenByMint = new Map<string, TokenMarketSnapshot>();
            const fillQualityByMint = new Map<string, VariantExecutionQualitySnapshot>();
            const marketMetaByMint = new Map<string, { lastFetchedAt: number }>();
            const uniqueMints: string[] = [];
            const seen = new Set<string>();
            for (const asset of combinedAssets) {
                for (const variant of asset.variants) {
                    if (seen.has(variant.mint)) continue;
                    seen.add(variant.mint);
                    uniqueMints.push(variant.mint);
                }
            }

            if (uniqueMints.length > 0) {
                if (prefetch) {
                    // Composite already fetched variantMarkets + fillQuality
                    // for the combined universe. Index into the returned rows;
                    // any residual gaps (e.g. registry variant mint absent from
                    // additionalMints) fall through to a per-mint fetch below.
                    const prefetchMints = new Set(prefetch.variantMarkets.map(r => r.mint));
                    for (const row of prefetch.variantMarkets) {
                        const market = row.market;
                        if (!market) continue;
                        if (!Number.isFinite(market.lastFetchedAt) || market.lastFetchedAt <= 0) continue;
                        marketMetaByMint.set(row.mint, { lastFetchedAt: market.lastFetchedAt });
                        tokenByMint.set(row.mint, tokenMarketSnapshotFromConvexMarket(row.mint, market));
                    }
                    for (const row of prefetch.fillQuality) {
                        const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
                        if (snapshot) fillQualityByMint.set(row.mint, snapshot);
                    }
                    const missingMints = uniqueMints.filter(m => !prefetchMints.has(m));
                    if (missingMints.length > 0) {
                        for (let i = 0; i < missingMints.length; i += 250) {
                            const chunk = missingMints.slice(i, i + 250);
                            const rows = yield* variantMarketsGetLatestByMints({ mints: chunk });
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
                            const rows = yield* variantFillQualityGetLatestByMints({ mints: chunk }).pipe(tapErrorAndDefault('assets.search.fillQuality.gapfill', [], { count: chunk.length }));
                            for (const row of rows) {
                                const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
                                if (snapshot) fillQualityByMint.set(row.mint, snapshot);
                            }
                        }
                    }
                } else {
                    // Convex query caps at 250 mints; chunk to keep search results complete.
                    for (let i = 0; i < uniqueMints.length; i += 250) {
                        const chunk = uniqueMints.slice(i, i + 250);
                        const rows = yield* variantMarketsGetLatestByMints({ mints: chunk });
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
                        const rows = yield* variantFillQualityGetLatestByMints({ mints: chunk }).pipe(tapErrorAndDefault('assets.search.variantFillQuality', [], { count: chunk.length }));
                        for (const row of rows) {
                            const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
                            if (snapshot) fillQualityByMint.set(row.mint, snapshot);
                        }
                    }
                }
            }

            const fallbackByMint = new Map<string, { symbol: string | undefined; name: string | undefined }>();
            for (const asset of combinedAssets) {
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
                if (!token.logoURI || !token.logoURI.trim()) score += 150;
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
            const uniqueMissing = Array.from(new Set(missingMints.map(m => m.trim()).filter(Boolean))).slice(0, 25);
            if (uniqueMissing.length > 0) {
                let tokenMarketsDocs: TokenMarketsGetLatestByMintsResult;
                if (prefetch) {
                    const covered = new Set(prefetch.tokenMarketsDocs.map(d => d.mint));
                    const gap = uniqueMissing.filter(m => !covered.has(m));
                    const gapDocs = gap.length > 0
                        ? yield* tokenMarketsGetLatestByMints({ mints: gap }).pipe(tapErrorAndDefault('assets.search.tokenMarkets.gapfill', [] as TokenMarketsGetLatestByMintsResult, { count: gap.length }))
                        : [];
                    tokenMarketsDocs = [...prefetch.tokenMarketsDocs, ...gapDocs];
                } else {
                    tokenMarketsDocs = yield* tokenMarketsGetLatestByMints({ mints: uniqueMissing });
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

            const assetAggregatesRows = prefetch
                ? prefetch.assetAggregates
                : yield* assetMarketsGetLatestByAssetIds({ assetIds: combinedAssets.map(a => a.assetId) });
            const aggregatesByAssetId = new Map<string, (typeof assetAggregatesRows)[number]['market']>();
            for (const row of assetAggregatesRows) aggregatesByAssetId.set(row.assetId, row.market);

            const stockAssetIds = combinedAssets
                .filter(asset => isStockPricedCategory(asset.category))
                .map(asset => asset.assetId);
            const stockInstrumentRows = (prefetch
                ? prefetch.stockInstruments
                : stockAssetIds.length > 0
                  ? yield* stockInstrumentsGetByAssetIds({ assetIds: stockAssetIds.slice(0, 500) }).pipe(tapErrorAndDefault('assets.search.stockInstruments', [], { count: stockAssetIds.length }))
                  : []) as StockInstrumentsGetByAssetIdsResult;
            const stockPriceRows = (prefetch
                ? prefetch.stockPrices
                : stockAssetIds.length > 0
                  ? yield* stockPricesGetLatestByAssetIds({ assetIds: stockAssetIds.slice(0, 500) }).pipe(tapErrorAndDefault('assets.search.stockPrices', [], { count: stockAssetIds.length }))
                  : []) as StockPricesGetLatestByAssetIdsResult;
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
                const snapshot = coinId ? (priceByCoinId.get(coinId) ?? null) : null;
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
                combinedAssets
                    .map(
                        asset =>
                            normalizeCoinGeckoCoinIdForAsset({ assetId: asset.assetId, coinId: asset.coingeckoId }) ??
                            '',
                    )
                    .filter(Boolean),
            );
            const priceChunks = Arr.chunksOf(coinIds, 50);
            const canonicalPriceRows = prefetch
                ? prefetch.coingeckoPrices
                : priceChunks.length > 0
                  ? (yield* Effect.all(
                        priceChunks.map(chunk =>
                            coingeckoGetPriceLatestByCoinIds({ coinIds: chunk }),
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

            const results = combinedAssets.map(asset => {
                const aggregates = aggregatesByAssetId.get(asset.assetId) ?? null;
                const primaryVariant = pickPrimaryVariant(asset, mintRank, tokenByMint, fillQualityByMint, {
                    strategy: primaryVariantStrategy,
                });
                const token = primaryVariant ? tokenByMint.get(primaryVariant.mint) : undefined;
                const stats = mergeAssetStatsWithAggregates(aggregateTokenStats(asset, tokenByMint, token), aggregates);
                const effectiveStats = applyCanonicalStats(asset, stats);
                const canonicalMarket = canonicalMarketForAsset(asset);
                const responseSymbol = stockInstrumentByAssetId.get(asset.assetId)?.symbol ?? asset.symbol;
                const imageUrl = resolveAssetImageUrl(request, {
                    assetId: asset.assetId,
                    symbol: responseSymbol ?? null,
                    imageUrl: assetImageById.get(asset.assetId) ?? null,
                });

                function buildVariantWithMarket(variant: CanonicalAsset['variants'][number]) {
                    const variantToken = tokenByMint.get(variant.mint);
                    const variantMarketMeta = marketMetaByMint.get(variant.mint);
                    const variantSymbol = resolveVariantSymbol({
                        variantSymbol: variant.symbol,
                        marketSymbol: variantToken?.symbol,
                        label: variant.label,
                        canonicalSymbol: responseSymbol,
                    });
                    const variantName =
                        optionalText(variant.name) ??
                        optionalText(variantToken?.name) ??
                        optionalText(variant.label) ??
                        variantSymbol;
                    const market = variantToken
                        ? {
                              ...(variantToken.source ? { source: variantToken.source } : {}),
                              ...(variantToken.metricsSource ? { metricsSource: variantToken.metricsSource } : {}),
                              price: variantToken.price,
                              liquidity: variantToken.liquidity,
                              volume1hUSD: variantToken.volume1hUSD ?? null,
                              volume24hUSD: variantToken.volume24hUSD,
                              trade1h: variantToken.trade1h ?? null,
                              trade24h: variantToken.trade24h ?? null,
                              uniqueWallet1h: variantToken.uniqueWallet1h ?? null,
                              uniqueWallet24h: variantToken.uniqueWallet24h ?? null,
                              marketCap: variantToken.marketCap,
                              fdv: variantToken.fdv,
                              holder: variantToken.holder,
                              totalSupply: variantToken.totalSupply,
                              circulatingSupply: variantToken.circulatingSupply,
                              priceChange24hPercent: variantToken.priceChange24hPercent,
                              priceChange1hPercent: variantToken.priceChange1hPercent,
                              decimals: variantToken.decimals,
                              logoURI: variantToken.logoURI ?? imageUrl ?? null,
                              lastTradeAt: variantToken.lastTradeAt ?? null,
                              asOf: variantToken.asOf ?? null,
                              lastFetchedAt: variantMarketMeta ? variantMarketMeta.lastFetchedAt : null,
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
                }

                const primaryVariantWithMarket = primaryVariant ? buildVariantWithMarket(primaryVariant) : null;
                const variants = includeVariants
                    ? asset.variants
                          .map(buildVariantWithMarket)
                          .sort((a, b) => (b.market?.liquidity ?? 0) - (a.market?.liquidity ?? 0))
                    : null;

                return {
                    assetId: asset.assetId,
                    name: asset.name,
                    symbol: responseSymbol,
                    category: asset.category,
                    imageUrl,
                    stats: effectiveStats,
                    ...(canonicalMarket ? { canonicalMarket } : {}),
                    advisories: advisoriesByAssetId.get(asset.assetId) ?? [],
                    primaryVariant: primaryVariantWithMarket,
                    ...(variants ? { variants } : {}),
                };
            });

            return { query: q, category, primaryVariantStrategy, results };
        }),
    // maxAge 120 → 30: an advisory set on a mint must reach search consumers
    // in the same window as the detail endpoint (browser-side worst case was
    // >2 minutes).
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 30 } },
);
