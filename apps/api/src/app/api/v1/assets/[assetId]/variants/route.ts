import { Array as Arr, Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError, NotFoundError } from '@tokens/effect';
import { decodeUnknownOrBadRequest, SolanaAddress } from '@tokens/effect';
import { tapErrorAndDefault } from '@tokens/effect';
import { loadAdvisoriesOrEmpty } from '@/lib/advisories';
import { getByAssetId as cloudRunGetByAssetId } from '@/lib/cloudrun/assets';
import {
    assetVariantsListByAssetIds,
    getSolanaDefaultVariantsViewForApi,
    listSolanaVariantsForApi,
    tokenMarketsGetLatestByMint,
    tokenMarketsGetTopMarketsByMints,
    tokensGetByAddress,
    variantFillQualityGetLatestByMints,
    variantMarketsGetLatestByMints,
    type ListSolanaVariantsForApiResult,
} from '@/lib/cloudrun';

import type { AssetVariant, LiquidityTier, StockVariantTier, VariantAdvisory, VariantKind } from '@tokens/asset-registry';
import {
    STOCK_VARIANT_TIERS,
    liquidityTierPriority,
    normalizeLegacyTier,
    resolveAlias as resolveRegistryAlias,
} from '@tokens/asset-registry';
import {
    executionQualitySnapshotFromConvexFillQuality,
    optionalText,
    parseStockVariantTier,
    parseVariantSortBy,
    resolveVariantSymbol,
    toFiniteNumberOrNull,
    variantMatchesFilters,
    withDerivedVariantTier,
    type VariantSortBy,
    type VariantExecutionQualitySnapshot,
} from '../../_asset-helpers';
import { canonicalizeAssetVariants } from '../../_canonical-overrides';
import { resolveAssetIdFromRef } from '../../_resolve-asset-ref';
import { singletonAssetIdToMint } from '../../_singleton-asset-id';

interface VariantMarketSnapshot {
    source?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    metricsSource?: 'birdeye' | 'rwa_xyz' | 'clickhouse_trades';
    price: number | null;
    liquidity: number | null;
    volume1hUSD?: number | null;
    volume24hUSD: number | null;
    trade1h?: number | null;
    trade24h?: number | null;
    uniqueWallet1h?: number | null;
    uniqueWallet24h?: number | null;
    marketCap: number | null;
    fdv: number | null;
    holder: number | null;
    totalSupply: number | null;
    circulatingSupply: number | null;
    priceChange24hPercent: number | null;
    priceChange1hPercent: number | null;
    decimals: number | null;
    logoURI: string | null;
    lastTradeAt?: number | null;
    asOf?: number | null;
    lastFetchedAt: number;
}

interface TokenMarketTokenLite {
    address?: string;
    decimals?: number;
    symbol?: string;
    name?: string;
    icon?: string;
}

interface TokenMarketLite {
    address?: string;
    name?: string;
    liquidity?: number;
    volume24h?: number;
    price?: number;
    base?: TokenMarketTokenLite;
    quote?: TokenMarketTokenLite;
}

interface TokenMarketTopRow {
    mint: string;
    topMarket: TokenMarketLite | null;
    total: number | null;
    lastFetchedAt: number | null;
}

const VARIANT_MARKETS_CHUNK_SIZE = 250;
const TOKEN_MARKETS_CHUNK_SIZE = 50;
const CLOUDRUN_BULK_QUERY_CONCURRENCY = 4;
type SolanaVariantsForApiResult = ListSolanaVariantsForApiResult;

function uniqueNonEmptyStrings(items: string[]): string[] {
    const seen = new Set<string>();
    for (const item of items) {
        const trimmed = item.trim();
        if (trimmed) seen.add(trimmed);
    }
    return Array.from(seen);
}

async function loadExecutionQualityByMints(mints: string[]): Promise<Map<string, VariantExecutionQualitySnapshot>> {
    const uniqueMints = uniqueNonEmptyStrings(mints);
    if (uniqueMints.length === 0) return new Map();

    const out = new Map<string, VariantExecutionQualitySnapshot>();
    for (const chunk of Arr.chunksOf(uniqueMints, 250)) {
        const rows = await Effect.runPromise(variantFillQualityGetLatestByMints({ mints: chunk }));
        for (const row of rows) {
            const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
            if (snapshot) out.set(row.mint, snapshot);
        }
    }
    return out;
}

/**
 * Cloud Run pre-shaped variant rows (Solana views) skip `withDerivedVariantTier`,
 * so attach the execution-quality snapshot and the `advisory` key here. Flagged
 * variants stay visible on this direct-URL surface (`blocked` included).
 */
function attachExecutionQuality<T extends { mint: string }>(
    variants: T[],
    fillQualityByMint: ReadonlyMap<string, VariantExecutionQualitySnapshot>,
    advisoriesByMint: ReadonlyMap<string, VariantAdvisory>,
): Array<T & { executionQuality: VariantExecutionQualitySnapshot | null; advisory: VariantAdvisory | null }> {
    return variants.map(variant => ({
        ...variant,
        executionQuality: fillQualityByMint.get(variant.mint) ?? null,
        advisory: advisoriesByMint.get(variant.mint) ?? null,
    }));
}

type SortableVariantRow = {
    mint: string;
    stockVariantTier?: StockVariantTier;
    liquidityTier?: LiquidityTier;
    market?: { liquidity?: number | null; volume24hUSD?: number | null } | null;
    executionQuality?: VariantExecutionQualitySnapshot | null;
};

function finiteNonNegative(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function compareVariantsByLiquidity(a: SortableVariantRow, b: SortableVariantRow): number {
    const liqDelta = finiteNonNegative(b.market?.liquidity) - finiteNonNegative(a.market?.liquidity);
    if (liqDelta !== 0) return liqDelta;

    const trustDelta =
        liquidityTierPriority(b.liquidityTier ?? 'tier3') - liquidityTierPriority(a.liquidityTier ?? 'tier3');
    if (trustDelta !== 0) return trustDelta;

    const volumeDelta = finiteNonNegative(b.market?.volume24hUSD) - finiteNonNegative(a.market?.volume24hUSD);
    if (volumeDelta !== 0) return volumeDelta;

    return a.mint.localeCompare(b.mint);
}

function compareVariantsByExecutionQuality(a: SortableVariantRow, b: SortableVariantRow): number {
    const aQuality = a.executionQuality ?? null;
    const bQuality = b.executionQuality ?? null;
    if (aQuality && !bQuality) return -1;
    if (!aQuality && bQuality) return 1;

    const eligibleDelta =
        Number(bQuality?.isEligibleForPrimary === true) - Number(aQuality?.isEligibleForPrimary === true);
    if (eligibleDelta !== 0) return eligibleDelta;

    const scoreDelta = finiteNonNegative(bQuality?.executionScore) - finiteNonNegative(aQuality?.executionScore);
    if (scoreDelta !== 0) return scoreDelta;

    const fillVolumeDelta = finiteNonNegative(bQuality?.volume24hUSD) - finiteNonNegative(aQuality?.volume24hUSD);
    if (fillVolumeDelta !== 0) return fillVolumeDelta;

    return compareVariantsByLiquidity(a, b);
}

function stockRedeemabilitySortScore(value: StockVariantTier | null | undefined): number {
    switch (value) {
        case 'share_redeemable':
            return 100;
        case 'cash_redeemable':
            return 50;
        case 'not_redeemable':
        default:
            return 0;
    }
}

function compareVariantsByStockRedeemability(a: SortableVariantRow, b: SortableVariantRow): number {
    const tierDelta = stockRedeemabilitySortScore(b.stockVariantTier) - stockRedeemabilitySortScore(a.stockVariantTier);
    if (tierDelta !== 0) return tierDelta;
    return compareVariantsByLiquidity(a, b);
}

function sortVariantRows<T extends SortableVariantRow>(items: T[], sortBy: VariantSortBy): T[] {
    items.sort(
        sortBy === 'execution_quality'
            ? compareVariantsByExecutionQuality
            : sortBy === 'stock_redeemability'
              ? compareVariantsByStockRedeemability
              : compareVariantsByLiquidity,
    );
    return items;
}

function deriveSnapshotFromTokenMarket(
    best: TokenMarketLite | null | undefined,
    lastFetchedAt: number | null | undefined,
    mint: string,
): { snapshot: VariantMarketSnapshot; symbol?: string; name?: string } | null {
    if (!best || typeof lastFetchedAt !== 'number' || !Number.isFinite(lastFetchedAt)) return null;

    const base = best.base ?? null;
    const quote = best.quote ?? null;

    const token =
        base && typeof base.address === 'string' && base.address === mint
            ? base
            : quote && typeof quote.address === 'string' && quote.address === mint
              ? quote
              : (base ?? quote ?? null);

    const decimals = toFiniteNumberOrNull(token?.decimals);

    const liquidity = toFiniteNumberOrNull(best.liquidity);
    const volume24hUSD = toFiniteNumberOrNull(best.volume24h);
    const price = toFiniteNumberOrNull(best.price);

    const snapshot: VariantMarketSnapshot = {
        price,
        liquidity,
        volume24hUSD,
        marketCap: null,
        fdv: null,
        holder: null,
        totalSupply: null,
        circulatingSupply: null,
        priceChange24hPercent: null,
        priceChange1hPercent: null,
        decimals,
        logoURI: typeof token?.icon === 'string' && token.icon.trim() ? token.icon.trim() : null,
        lastFetchedAt,
    };

    const symbol = typeof token?.symbol === 'string' && token.symbol.trim() ? token.symbol.trim() : undefined;
    const name = typeof token?.name === 'string' && token.name.trim() ? token.name.trim() : undefined;

    return { snapshot, ...(symbol ? { symbol } : {}), ...(name ? { name } : {}) };
}

function deriveSnapshotFromTokenMarkets(
    doc: { markets: Array<TokenMarketLite>; lastFetchedAt: number } | null,
    mint: string,
): { snapshot: VariantMarketSnapshot; symbol?: string; name?: string } | null {
    if (!doc) return null;
    const markets = Array.isArray(doc.markets) ? doc.markets : [];
    if (markets.length === 0) return null;

    const sorted = [...markets].sort(
        (a, b) => (toFiniteNumberOrNull(b?.liquidity) ?? 0) - (toFiniteNumberOrNull(a?.liquidity) ?? 0),
    );
    const best = sorted.find(m => (toFiniteNumberOrNull(m?.price) ?? 0) > 0) ?? sorted[0];
    if (!best) return null;

    return deriveSnapshotFromTokenMarket(best, doc.lastFetchedAt, mint);
}

function deriveSnapshotFromTopTokenMarket(
    row: TokenMarketTopRow | null | undefined,
): { snapshot: VariantMarketSnapshot; symbol?: string; name?: string } | null {
    if (!row) return null;
    return deriveSnapshotFromTokenMarket(row.topMarket, row.lastFetchedAt, row.mint);
}

const VALID_KINDS: VariantKind[] = [
    'native',
    'wrapped',
    'bridged',
    'spot',
    'etf',
    'yield',
    'leveraged',
    'basket',
    'lst',
    'stablecoin',
    'tokenized_equity',
];

const VALID_LIQUIDITY_TIERS: LiquidityTier[] = ['tier1', 'tier2', 'tier3'];

function parseKind(raw: string | null): VariantKind | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return VALID_KINDS.includes(trimmed as VariantKind) ? (trimmed as VariantKind) : null;
}

function parseTier(raw: string | null): LiquidityTier | null {
    return normalizeLegacyTier(raw);
}

export const GET = route(
    (request: Request, ctx: { params: Promise<{ assetId: string }> }) =>
        Effect.gen(function* () {
            const { assetId: assetRef } = yield* Effect.tryPromise(() => ctx.params);

            const url = new URL(request.url);
            const rawKind = url.searchParams.get('kind');
            const rawLiquidityTier = url.searchParams.get('liquidityTier');
            const rawTrustTier = url.searchParams.get('trustTier');
            const rawStockVariantTier = url.searchParams.get('stockVariantTier');
            const variantsMode = (url.searchParams.get('variantsMode') ?? '').trim();
            const sortBy = parseVariantSortBy(url.searchParams.get('sortBy'));

            const kind = parseKind(rawKind);
            if (rawKind && !kind) {
                return yield* Effect.fail(
                    new BadRequestError({
                        message: `Invalid kind: ${rawKind}`,
                        details: { kinds: VALID_KINDS },
                    }),
                );
            }

            const liquidityTier = parseTier(rawLiquidityTier);
            if (rawLiquidityTier && !liquidityTier) {
                return yield* Effect.fail(
                    new BadRequestError({
                        message: `Invalid liquidityTier: ${rawLiquidityTier}`,
                        details: { liquidityTiers: VALID_LIQUIDITY_TIERS },
                    }),
                );
            }
            const trustTier = parseTier(rawTrustTier);
            if (rawTrustTier && !trustTier) {
                return yield* Effect.fail(
                    new BadRequestError({
                        message: `Invalid trustTier: ${rawTrustTier}`,
                        details: { trustTiers: VALID_LIQUIDITY_TIERS, legacyAlias: 'experimental -> tier3' },
                    }),
                );
            }
            if (liquidityTier && trustTier && liquidityTier !== trustTier) {
                return yield* Effect.fail(
                    new BadRequestError({
                        message: 'liquidityTier and trustTier filters must match when both are provided',
                        details: { liquidityTier, trustTier },
                    }),
                );
            }
            const tierFilter = liquidityTier ?? trustTier;

            const stockVariantTier = parseStockVariantTier(rawStockVariantTier);
            if (rawStockVariantTier && !stockVariantTier) {
                return yield* Effect.fail(
                    new BadRequestError({
                        message: `Invalid stockVariantTier: ${rawStockVariantTier}`,
                        details: { stockVariantTiers: STOCK_VARIANT_TIERS },
                    }),
                );
            }

            const assetId = yield* resolveAssetIdFromRef(assetRef);

            const requestedMintRaw = url.searchParams.get('mint');
            const requestedMintText = (requestedMintRaw ?? '').trim();
            const requestedMint =
                requestedMintText.length > 0
                    ? yield* decodeUnknownOrBadRequest(SolanaAddress, requestedMintText, 'Invalid mint')
                    : null;

            // Advisory set for this request (fail-open: empty on outage). This
            // surface backs direct asset URLs, so `blocked` variants are kept —
            // they carry their advisory instead of disappearing.
            const advisoriesByMint = yield* loadAdvisoriesOrEmpty();

            const singletonMint = singletonAssetIdToMint(assetId);
            if (singletonMint) {
                if (kind && kind !== 'native') return { assetId, sortBy, variants: [] };

                const rows = yield* variantMarketsGetLatestByMints({ mints: [singletonMint] });
                const market = rows[0]?.market ?? null;
                const marketSnapshot = market ? toMarketSnapshot(market) : null;

                const doc = yield* tokenMarketsGetLatestByMint({ mint: singletonMint }).pipe(tapErrorAndDefault('assets.variants.singletonTokenMarkets', null, { mint: singletonMint }));
                const derived = marketSnapshot ? null : deriveSnapshotFromTokenMarkets(doc, singletonMint);

                const token = yield* tokensGetByAddress({ address: singletonMint }).pipe(tapErrorAndDefault('assets.variants.singletonToken', null, { mint: singletonMint }));
                const symbol =
                    typeof token?.symbol === 'string' && token.symbol.trim() ? token.symbol.trim() : undefined;
                const name = typeof token?.name === 'string' && token.name.trim() ? token.name.trim() : undefined;
                const fillQualityByMint = yield* Effect.tryPromise(() =>
                    loadExecutionQualityByMints([singletonMint]),
                ).pipe(tapErrorAndDefault('assets.variants.singletonFillQuality', new Map(), { mint: singletonMint }));

                const variant: AssetVariant & {
                    liquidityTier: LiquidityTier;
                    market: VariantMarketSnapshot | null;
                    executionQuality: VariantExecutionQualitySnapshot | null;
                } = withDerivedVariantTier(
                    {
                        variantId: `${assetId}:${singletonMint.slice(0, 8)}`,
                        mint: singletonMint,
                        kind: 'native' as const,
                        tags: [],
                        ...(symbol ? { symbol } : {}),
                        ...(name ? { name } : {}),
                        ...(symbol ? { label: symbol } : {}),
                        ...(derived?.symbol ? { symbol: derived.symbol } : {}),
                        ...(derived?.name ? { name: derived.name } : {}),
                        advisory: advisoriesByMint.get(singletonMint) ?? null,
                        market: marketSnapshot ?? derived?.snapshot ?? null,
                        executionQuality: fillQualityByMint.get(singletonMint) ?? null,
                    } satisfies Omit<AssetVariant, 'trustTier'> & {
                        market: VariantMarketSnapshot | null;
                        executionQuality: VariantExecutionQualitySnapshot | null;
                    },
                    (marketSnapshot ?? derived?.snapshot ?? null)?.liquidity,
                );
                const variants: Array<
                    AssetVariant & {
                        liquidityTier: LiquidityTier;
                        market: VariantMarketSnapshot | null;
                        executionQuality: VariantExecutionQualitySnapshot | null;
                    }
                > = variantMatchesFilters(variant, { liquidityTier: tierFilter, stockVariantTier }) ? [variant] : [];

                return { assetId, sortBy, variants: sortVariantRows(variants, sortBy) };
            }

            if (assetId === 'solana' && variantsMode !== 'all' && !stockVariantTier) {
                if (!kind && !tierFilter && !requestedMint) {
                    const view = yield* getSolanaDefaultVariantsViewForApi().pipe(tapErrorAndDefault('assets.variants.solanaDefaultView', null, { assetId }));

                    if (view) {
                        const fillQualityByMint = yield* Effect.tryPromise(() =>
                            loadExecutionQualityByMints(
                                (view.variants as Array<{ mint: string }>).map(variant => variant.mint),
                            ),
                        ).pipe(tapErrorAndDefault('assets.variants.solanaDefaultFillQuality', new Map(), { assetId }));
                        const variants = sortVariantRows(
                            attachExecutionQuality(view.variants, fillQualityByMint, advisoriesByMint),
                            sortBy,
                        );
                        return {
                            assetId: view.assetId,
                            sortBy,
                            variants,
                        };
                    }
                }

                const result: SolanaVariantsForApiResult | null = yield* listSolanaVariantsForApi({
                        ...(kind ? { kind } : {}),
                        ...(tierFilter ? { tierFilter } : {}),
                        ...(requestedMint ? { requestedMint } : {}),
                        ...(variantsMode ? { variantsMode } : {}),
                    }).pipe(tapErrorAndDefault('assets.variants.solanaListView', null, { assetId, variantsMode }));

                if (result) {
                    if (!result.requestedMintIsVariant) {
                        return yield* Effect.fail(
                            new BadRequestError({
                                message: '`mint` must be a variant of this asset',
                                details: { mint: requestedMint },
                            }),
                        );
                    }

                    const fillQualityByMint = yield* Effect.tryPromise(() =>
                        loadExecutionQualityByMints(result.variants.map(variant => variant.mint)),
                    ).pipe(tapErrorAndDefault('assets.variants.solanaListFillQuality', new Map(), { assetId }));
                    const variants = sortVariantRows(
                        attachExecutionQuality(result.variants, fillQualityByMint, advisoriesByMint),
                        sortBy,
                    );
                    return {
                        assetId: result.assetId,
                        sortBy,
                        variants,
                    };
                }
            }

            const registryAsset = resolveRegistryAlias(assetId);
            const [assetDoc, variantsRowsForRegistry] = registryAsset
                ? yield* Effect.all(
                      [
                          cloudRunGetByAssetId({ assetId }),
                          assetVariantsListByAssetIds({ assetIds: [registryAsset.assetId] }),
                      ] as const,
                      { concurrency: 2 },
                  )
                : [yield* cloudRunGetByAssetId({ assetId }), null];

            const variantsRows = assetDoc
                ? (variantsRowsForRegistry ??
                  (yield* assetVariantsListByAssetIds({ assetIds: [assetDoc.assetId] })))
                : [];
            const dbVariants: AssetVariant[] = (variantsRows[0]?.variants ?? []) as unknown as AssetVariant[];

            const registryVariants = registryAsset && registryAsset.variants.length > 0 ? registryAsset.variants : null;

            const variantsByMint = new Map<string, AssetVariant>();
            for (const variant of dbVariants) variantsByMint.set(variant.mint, variant);
            if (registryVariants && registryVariants.length > 0) {
                for (const variant of registryVariants) {
                    const prev = variantsByMint.get(variant.mint);
                    if (!prev) {
                        variantsByMint.set(variant.mint, variant);
                        continue;
                    }

                    variantsByMint.set(variant.mint, {
                        ...prev,
                        variantId: variant.variantId,
                        kind: variant.kind,
                        trustTier: variant.trustTier,
                        tags: Array.from(new Set<string>([...(prev.tags ?? []), ...(variant.tags ?? [])])),
                        ...(prev.issuer ? { issuer: prev.issuer } : variant.issuer ? { issuer: variant.issuer } : {}),
                        ...(prev.issuerUrl
                            ? { issuerUrl: prev.issuerUrl }
                            : variant.issuerUrl
                              ? { issuerUrl: variant.issuerUrl }
                              : {}),
                        ...(prev.label ? { label: prev.label } : variant.label ? { label: variant.label } : {}),
                        ...(prev.stockVariantTier
                            ? { stockVariantTier: prev.stockVariantTier }
                            : variant.stockVariantTier
                              ? { stockVariantTier: variant.stockVariantTier }
                              : {}),
                        ...(variant.symbol ? { symbol: variant.symbol } : {}),
                        ...(variant.name ? { name: variant.name } : {}),
                    });
                }
            }

            const outAssetId = assetDoc?.assetId ?? registryAsset?.assetId ?? assetId;
            const canonicalSymbol = optionalText(assetDoc?.symbol) ?? optionalText(registryAsset?.symbol);
            const allVariants: AssetVariant[] = Array.from(variantsByMint.values());
            const canonicalVariants = canonicalizeAssetVariants(outAssetId, allVariants).map(variant => ({
                ...variant,
                advisory: advisoriesByMint.get(variant.mint) ?? null,
            }));

            if (requestedMint) {
                const isVariant = canonicalVariants.some(v => v.mint === requestedMint);
                if (!isVariant) {
                    return yield* Effect.fail(
                        new BadRequestError({
                            message: '`mint` must be a variant of this asset',
                            details: { mint: requestedMint },
                        }),
                    );
                }
            }

            const filteredVariants = canonicalVariants.filter(v => {
                return variantMatchesFilters(v, { kind, stockVariantTier });
            });

            if (filteredVariants.length === 0) {
                return { assetId: outAssetId, sortBy, variants: [] };
            }

            const marketChunks = Arr.chunksOf(
                filteredVariants.map(v => v.mint),
                VARIANT_MARKETS_CHUNK_SIZE,
            );
            const rowsByChunk = yield* Effect.all(
                marketChunks.map(chunk =>
                    variantMarketsGetLatestByMints({ mints: chunk }),
                ),
                { concurrency: CLOUDRUN_BULK_QUERY_CONCURRENCY },
            );
            const rows = rowsByChunk.flat();

            const marketByMint = new Map<string, NonNullable<(typeof rows)[number]['market']>>();
            for (const row of rows) {
                if (row.market) marketByMint.set(row.mint, row.market);
            }
            const fillQualityByMint = yield* Effect.tryPromise(() =>
                loadExecutionQualityByMints(filteredVariants.map(v => v.mint)),
            ).pipe(tapErrorAndDefault('assets.variants.fillQuality', new Map(), { assetId: outAssetId }));

            function toMarketSnapshot(
                market: NonNullable<(typeof rows)[number]['market']>,
            ): VariantMarketSnapshot | null {
                // Skip placeholder rows inserted during seeding.
                if (!Number.isFinite(market.lastFetchedAt) || market.lastFetchedAt <= 0) return null;

                const decimals = toFiniteNumberOrNull(market.decimals);

                return {
                    ...(market.source ? { source: market.source } : {}),
                    ...(market.metricsSource ? { metricsSource: market.metricsSource } : {}),
                    price: toFiniteNumberOrNull(market.price),
                    liquidity: toFiniteNumberOrNull(market.liquidity),
                    volume1hUSD: toFiniteNumberOrNull(market.volume1hUSD),
                    volume24hUSD: toFiniteNumberOrNull(market.volume24hUSD),
                    trade1h: toFiniteNumberOrNull(market.trade1h),
                    trade24h: toFiniteNumberOrNull(market.trade24h),
                    uniqueWallet1h: toFiniteNumberOrNull(market.uniqueWallet1h),
                    uniqueWallet24h: toFiniteNumberOrNull(market.uniqueWallet24h),
                    marketCap: toFiniteNumberOrNull(market.marketCap),
                    fdv: toFiniteNumberOrNull(market.fdv),
                    holder: toFiniteNumberOrNull(market.holder),
                    totalSupply: toFiniteNumberOrNull(market.totalSupply),
                    circulatingSupply: toFiniteNumberOrNull(market.circulatingSupply),
                    priceChange24hPercent: toFiniteNumberOrNull(market.priceChange24hPercent),
                    priceChange1hPercent: toFiniteNumberOrNull(market.priceChange1hPercent),
                    decimals,
                    logoURI: typeof market.logoURI === 'string' && market.logoURI.trim() ? market.logoURI.trim() : null,
                    lastTradeAt: toFiniteNumberOrNull(market.lastTradeAt),
                    asOf: toFiniteNumberOrNull(market.asOf),
                    lastFetchedAt: market.lastFetchedAt,
                };
            }

            const toVariant = (v: AssetVariant, tokenMarketRow?: TokenMarketTopRow | null) => {
                const market = marketByMint.get(v.mint);
                const marketSnapshot = market ? toMarketSnapshot(market) : null;
                const derived = marketSnapshot ? null : deriveSnapshotFromTopTokenMarket(tokenMarketRow ?? null);

                const symbol = resolveVariantSymbol({
                    variantSymbol: v.symbol,
                    marketSymbol: market?.symbol ?? derived?.symbol,
                    label: v.label,
                    canonicalSymbol,
                });
                const name = optionalText(v.name) ?? optionalText(market?.name) ?? derived?.name;

                const marketWithLogo: VariantMarketSnapshot | null = marketSnapshot ?? derived?.snapshot ?? null;

                return withDerivedVariantTier(
                    {
                        variantId: v.variantId,
                        mint: v.mint,
                        kind: v.kind,
                        tags: v.tags,
                        ...(v.issuer ? { issuer: v.issuer } : {}),
                        ...(v.issuerUrl ? { issuerUrl: v.issuerUrl } : {}),
                        ...(v.label ? { label: v.label } : {}),
                        ...(v.stockVariantTier ? { stockVariantTier: v.stockVariantTier } : {}),
                        ...(symbol ? { symbol } : {}),
                        ...(name ? { name } : {}),
                        advisory: v.advisory ?? advisoriesByMint.get(v.mint) ?? null,
                        market: marketWithLogo,
                        executionQuality: fillQualityByMint.get(v.mint) ?? null,
                    },
                    marketWithLogo?.liquidity,
                );
            };

            const variantsByMintForFallback = new Map(filteredVariants.map(v => [v.mint, v] as const));
            const loadTopTokenMarketsByMints = (mints: string[]) =>
                Effect.gen(function* () {
                    const uniqueMints = uniqueNonEmptyStrings(mints);
                    if (uniqueMints.length === 0) return new Map<string, TokenMarketTopRow>();

                    const tokenMarketChunks = Arr.chunksOf(uniqueMints, TOKEN_MARKETS_CHUNK_SIZE);
                    const tokenMarketRowsByChunk = yield* Effect.all(
                        tokenMarketChunks.map(chunk =>
                            tokenMarketsGetTopMarketsByMints({ mints: chunk }).pipe(Effect.catch(() => Effect.succeed([] as TokenMarketTopRow[]))),
                        ),
                        { concurrency: CLOUDRUN_BULK_QUERY_CONCURRENCY },
                    );
                    const tokenMarketsByMint = new Map<string, TokenMarketTopRow>();
                    for (const row of tokenMarketRowsByChunk.flat() as TokenMarketTopRow[]) {
                        tokenMarketsByMint.set(row.mint, row);
                    }
                    return tokenMarketsByMint;
                });

            const shouldPrecapSolanaYield =
                outAssetId === 'solana' && variantsMode !== 'all' && (!kind || kind === 'yield');
            let variants = filteredVariants.map(v => toVariant(v));

            if (shouldPrecapSolanaYield) {
                const tokenMarketsByMint = yield* loadTopTokenMarketsByMints(
                    variants.filter(v => !v.market && v.kind === 'yield').map(v => v.mint),
                );
                if (tokenMarketsByMint.size > 0) {
                    variants = variants.map(variant => {
                        if (variant.market || variant.kind !== 'yield') return variant;
                        const source = variantsByMintForFallback.get(variant.mint);
                        if (!source) return variant;
                        return toVariant(source, tokenMarketsByMint.get(variant.mint));
                    });
                }
            } else {
                const tokenMarketsByMint = yield* loadTopTokenMarketsByMints(
                    variants.filter(v => !v.market).map(v => v.mint),
                );
                if (tokenMarketsByMint.size > 0) {
                    variants = variants.map(variant => {
                        if (variant.market) return variant;
                        const source = variantsByMintForFallback.get(variant.mint);
                        if (!source) return variant;
                        return toVariant(source, tokenMarketsByMint.get(variant.mint));
                    });
                }
            }

            let visibleVariants = tierFilter
                ? variants.filter(variant => variant.liquidityTier === tierFilter)
                : variants;

            sortVariantRows(visibleVariants, sortBy);

            if (shouldPrecapSolanaYield) {
                const SOLANA_YIELD_MIN_LIQUIDITY_USD = 250_000;
                const SOLANA_YIELD_MAX = 500;

                const yieldRows = visibleVariants.filter(v => v.kind === 'yield');

                const pinnedMint =
                    requestedMint && visibleVariants.some(v => v.mint === requestedMint && v.kind === 'yield')
                        ? requestedMint
                        : null;
                const pinnedRow = pinnedMint ? (yieldRows.find(v => v.mint === pinnedMint) ?? null) : null;

                const eligibleYield = yieldRows.filter(
                    v => v.mint === pinnedMint || (v.market?.liquidity ?? 0) >= SOLANA_YIELD_MIN_LIQUIDITY_USD,
                );

                let keepYield = eligibleYield;
                if (keepYield.length > SOLANA_YIELD_MAX) {
                    keepYield = keepYield.slice(0, SOLANA_YIELD_MAX);
                }
                if (pinnedRow && !keepYield.some(v => v.mint === pinnedRow.mint)) {
                    keepYield = [...keepYield.slice(0, Math.max(0, SOLANA_YIELD_MAX - 1)), pinnedRow];
                }

                const keepYieldMints = new Set(keepYield.map(v => v.mint));
                visibleVariants = visibleVariants.filter(v => v.kind !== 'yield' || keepYieldMints.has(v.mint));
            }

            if (!outAssetId) {
                return yield* Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));
            }
            return { assetId: outAssetId, sortBy, variants: visibleVariants };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 30 } },
);
