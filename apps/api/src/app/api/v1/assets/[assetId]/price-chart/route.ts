import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError, NotFoundError } from '@tokens/effect';
import { tapErrorAndDefault } from '@tokens/effect';
import {
    decodeUnknownOrBadRequest,
    NonNegativeIntFromString,
    SolanaAddress,
    TimeInterval as TimeIntervalSchema,
} from '@tokens/effect';
import { getByAssetId as cloudRunGetByAssetId } from '@/lib/cloudrun/assets';
import { CloudRunQueryMemo } from '@/lib/cloudrun/client';
import { seedSpeculativeMemo } from '@/lib/cloudrun/speculative-batch';
import {
    assetVariantsListByAssetIds,
    coingeckoListOhlcv,
    ohlcvList,
    stockInstrumentsGetByAssetId,
    stockOhlcvList,
    tokensGetByAddress,
} from '@/lib/cloudrun';
import {
    buildCuratedMintRank,
    isCanonicalPublicEquityAsset,
    isStockPricedCategory,
    pickPrimaryVariant,
} from '../../_asset-helpers';
import { loadTokensByMints } from '../../_load-variant-markets';
import {
    scheduleCacheWarm,
    scheduleCoingeckoOhlcvWarm,
    scheduleStockOhlcvWarm,
} from '../../_asset-detail-warm';
import { resolveAssetIdFromRef } from '../../_resolve-asset-ref';
import type { TimeInterval } from '@/lib/birdeye';
import { intervalToSeconds, validateOhlcvRange } from '@/lib/ohlcv-bounds';
import type { CanonicalAsset } from '@tokens/asset-registry';
import { resolveAlias as resolveRegistryAlias } from '@tokens/asset-registry';
import { normalizeCoinGeckoCoinIdForAsset } from '../../_coingecko-id';
import { resolveCoinGeckoCoinIdForAsset } from '../../_resolve-coingecko-coin-id';
import { singletonAssetIdToMint } from '../../_singleton-asset-id';

type AssetVariantRow = {
    variantId: string;
    mint: string;
    kind: CanonicalAsset['variants'][number]['kind'];
    trustTier: CanonicalAsset['variants'][number]['trustTier'];
    stockVariantTier?: CanonicalAsset['variants'][number]['stockVariantTier'];
    tags: string[];
    issuer?: string;
    issuerUrl?: string;
    label?: string;
};

const ASSET_IDS_PREFERRING_ONCHAIN_CHART_FALLBACK = new Set(['spacex']);

function mergeRegistryVariants(
    variants: AssetVariantRow[],
    registryAsset: CanonicalAsset | null,
): CanonicalAsset['variants'] {
    const registryVariantByMint = new Map((registryAsset?.variants ?? []).map(variant => [variant.mint, variant]));
    const variantsByMint = new Map<string, CanonicalAsset['variants'][number]>();

    for (const variant of variants) {
        const registryVariant = registryVariantByMint.get(variant.mint);
        const stockVariantTier = variant.stockVariantTier ?? registryVariant?.stockVariantTier;
        variantsByMint.set(variant.mint, {
            variantId: variant.variantId,
            mint: variant.mint,
            kind: variant.kind,
            trustTier: variant.trustTier,
            tags: variant.tags,
            ...(variant.issuer ? { issuer: variant.issuer } : {}),
            ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
            ...(variant.label ? { label: variant.label } : {}),
            ...(stockVariantTier ? { stockVariantTier } : {}),
            ...(registryVariant?.symbol ? { symbol: registryVariant.symbol } : {}),
            ...(registryVariant?.name ? { name: registryVariant.name } : {}),
        });
    }

    for (const variant of registryAsset?.variants ?? []) {
        const existing = variantsByMint.get(variant.mint);
        if (!existing) {
            variantsByMint.set(variant.mint, variant);
            continue;
        }

        variantsByMint.set(variant.mint, {
            ...variant,
            ...existing,
            tags: Array.from(new Set([...variant.tags, ...existing.tags])),
            ...(existing.stockVariantTier
                ? { stockVariantTier: existing.stockVariantTier }
                : variant.stockVariantTier
                  ? { stockVariantTier: variant.stockVariantTier }
                  : {}),
        });
    }

    return Array.from(variantsByMint.values());
}

function assetForOnchainChartFallback(asset: CanonicalAsset): CanonicalAsset {
    if (!ASSET_IDS_PREFERRING_ONCHAIN_CHART_FALLBACK.has(asset.assetId)) return asset;

    const redeemableVariants = asset.variants.filter(
        variant => variant.stockVariantTier === 'share_redeemable' || variant.stockVariantTier === 'cash_redeemable',
    );
    if (redeemableVariants.length === 0) return asset;

    return { ...asset, variants: redeemableVariants };
}

function scheduleCoinChartWarm(params: {
    coinId: string;
    interval: TimeInterval;
    days: number;
}): Effect.Effect<void, never> {
    return scheduleCoingeckoOhlcvWarm({ ...params, label: 'assets.priceChart.scheduleCoinWarm' });
}

function scheduleStockChartWarm(params: {
    assetId: string;
    interval: TimeInterval;
    days: number;
}): Effect.Effect<void, never> {
    return scheduleStockOhlcvWarm({ ...params, label: 'assets.priceChart.scheduleStockWarm' });
}

function scheduleMintChartWarm(params: {
    mint: string;
    interval: TimeInterval;
    days: number;
}): Effect.Effect<void, never> {
    return scheduleCacheWarm(null, {
        mint: params.mint,
        variantMarket: false,
        markets: false,
        ohlcv: true,
        ohlcvInterval: params.interval,
        ohlcvDays: params.days,
        minAgeMs: 0,
        label: 'assets.priceChart.scheduleMintWarm',
    });
}

export const GET = route(
    (request: Request, ctx: { params: Promise<{ assetId: string }> }) =>
        Effect.gen(function* () {
            const { assetId: rawAssetId } = yield* Effect.tryPromise(() => ctx.params);
            const assetRef = (rawAssetId ?? '').trim();
            if (!assetRef) return yield* Effect.fail(new BadRequestError({ message: 'assetId is required' }));

            const url = new URL(request.url);
            const searchParams = url.searchParams;

            const rawInterval = searchParams.get('interval');
            const interval: TimeInterval = rawInterval
                ? yield* decodeUnknownOrBadRequest(TimeIntervalSchema, rawInterval, 'Invalid interval')
                : ('1H' as const);

            const now = Math.floor(Date.now() / 1000);
            const fromRaw = searchParams.get('from');
            const toRaw = searchParams.get('to');
            const parsedFrom = fromRaw
                ? yield* decodeUnknownOrBadRequest(NonNegativeIntFromString, fromRaw, 'Invalid from')
                : now - 7 * 24 * 60 * 60;
            const parsedTo = toRaw
                ? yield* decodeUnknownOrBadRequest(NonNegativeIntFromString, toRaw, 'Invalid to')
                : now;

            const { from, to } = yield* validateOhlcvRange({ from: parsedFrom, to: parsedTo, interval });

            // One round-trip pre-answers the chain of lookups below (see
            // `speculative-batch.ts`); every call still runs exactly as written.
            yield* seedSpeculativeMemo({ profile: 'price-chart', ref: assetRef });
            const memo = yield* Effect.service(CloudRunQueryMemo);

            const assetId = yield* resolveAssetIdFromRef(assetRef);

            const requestedDays = Math.max(1, Math.ceil((to - from) / (24 * 60 * 60)));
            const intervalSeconds = intervalToSeconds(interval);

            const assetDoc = yield* cloudRunGetByAssetId({ assetId });

            let canonical: CanonicalAsset | null = null;
            if (assetDoc) {
                const variantsRows = yield* assetVariantsListByAssetIds({ assetIds: [assetDoc.assetId] });
                const variants = (variantsRows[0]?.variants ?? []) as AssetVariantRow[];
                const registryAsset = resolveRegistryAlias(assetDoc.assetId);

                canonical = {
                    assetId: assetDoc.assetId,
                    ...(assetDoc.name ? { name: assetDoc.name } : {}),
                    ...(assetDoc.symbol ? { symbol: assetDoc.symbol } : {}),
                    category: assetDoc.category,
                    aliases: assetDoc.aliases,
                    ...(assetDoc.coingeckoId ? { coingeckoId: assetDoc.coingeckoId } : {}),
                    variants: mergeRegistryVariants(variants, registryAsset),
                };
            } else {
                // Reached only for registered per-mint assets (approved launch coins, admin `solana-<mint>` ids);
                // unregistered mints are rejected upstream in _resolve-asset-ref.ts.
                const singletonMint = singletonAssetIdToMint(assetId);
                if (singletonMint) {
                    const token = yield* tokensGetByAddress({ address: singletonMint }).pipe(
                        tapErrorAndDefault('assets.priceChart.singletonToken', null, {
                            assetId,
                            mint: singletonMint,
                        }),
                    );

                    if (token) {
                        canonical = {
                            assetId,
                            ...(token.name ? { name: token.name } : {}),
                            ...(token.symbol ? { symbol: token.symbol } : {}),
                            category: 'crypto',
                            aliases: [singletonMint],
                            variants: [
                                {
                                    variantId: `${assetId}:${singletonMint.slice(0, 8)}`,
                                    mint: singletonMint,
                                    kind: 'native',
                                    trustTier: 'tier3',
                                    tags: [],
                                    ...(token.symbol ? { symbol: token.symbol } : {}),
                                    ...(token.name ? { name: token.name } : {}),
                                },
                            ],
                        };
                    }
                } else {
                    canonical = resolveRegistryAlias(assetId);
                }
            }

            if (!canonical)
                return yield* Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));

            if (isStockPricedCategory(canonical.category)) {
                const stockInstrument = yield* stockInstrumentsGetByAssetId({ assetId: canonical.assetId }).pipe(tapErrorAndDefault('assets.priceChart.stockInstrument', null, { assetId: canonical.assetId }));

                // Commodities use the stock chart only once a benchmark instrument mapping exists;
                // equities additionally qualify via the public-equity heuristic.
                const shouldUseStockChart = Boolean(stockInstrument) || isCanonicalPublicEquityAsset(canonical);
                if (shouldUseStockChart) {
                    const candles = yield* stockOhlcvList({
                            assetId: canonical.assetId,
                            interval,
                            from,
                            to,
                        });

                    const latestTime = candles.length > 0 ? (candles[candles.length - 1]?.time ?? null) : null;
                    const isStale = latestTime === null || to - latestTime > intervalSeconds * 2;
                    if (isStale && stockInstrument) {
                        yield* scheduleStockChartWarm({
                            assetId: canonical.assetId,
                            interval,
                            days: requestedDays,
                        });
                    }

                    if (candles.length > 0) {
                        return { assetId: canonical.assetId, interval, from, to, candles };
                    }
                }
            }

            if (!ASSET_IDS_PREFERRING_ONCHAIN_CHART_FALLBACK.has(canonical.assetId)) {
                const normalizedCoinId =
                    normalizeCoinGeckoCoinIdForAsset({ assetId: canonical.assetId, coinId: canonical.coingeckoId }) ??
                    null;
                const resolvedCoinId = yield* resolveCoinGeckoCoinIdForAsset({
                    assetId: canonical.assetId,
                    category: canonical.category,
                    name: canonical.name ?? null,
                    symbol: canonical.symbol ?? null,
                    existingCoinId: normalizedCoinId,
                });
                const coinId = resolvedCoinId ?? '';
                if (coinId) {
                    const candles = yield* coingeckoListOhlcv({
                            coinId,
                            interval,
                            from,
                            to,
                        });

                    const latestTime = candles.length > 0 ? (candles[candles.length - 1]?.time ?? null) : null;
                    const isStale = latestTime === null || to - latestTime > intervalSeconds * 2;
                    if (isStale) yield* scheduleCoinChartWarm({ coinId, interval, days: requestedDays });

                    if (candles.length > 0) {
                        return { assetId: canonical.assetId, interval, from, to, candles };
                    }
                }
            }

            if (canonical.variants.length === 0) {
                return yield* Effect.fail(
                    new NotFoundError({ message: 'No variants available', resource: 'assetVariant' }),
                );
            }

            const mintRank = buildCuratedMintRank();
            const fallbackAsset = assetForOnchainChartFallback(canonical);
            const tokenByMint = yield* Effect.tryPromise(() =>
                loadTokensByMints(
                    fallbackAsset.variants.map(v => v.mint),
                    memo,
                ),
            );
            const primary = pickPrimaryVariant(fallbackAsset, mintRank, tokenByMint, undefined, {
                strategy: fallbackAsset.category === 'equity' ? 'stock_redeemability' : 'liquidity',
            });
            const requestedMintRaw = (searchParams.get('mint') ?? '').trim();
            const mint =
                requestedMintRaw.length > 0
                    ? yield* decodeUnknownOrBadRequest(SolanaAddress, requestedMintRaw, 'Invalid mint')
                    : (primary?.mint ?? null);
            if (!mint) {
                return yield* Effect.fail(
                    new NotFoundError({ message: 'No primary variant available', resource: 'assetVariant' }),
                );
            }
            if (!canonical.variants.some(v => v.mint === mint)) {
                return yield* Effect.fail(
                    new BadRequestError({ message: '`mint` must be a variant of this asset', details: { mint } }),
                );
            }

            const candles = yield* ohlcvList({
                    address: mint,
                    interval,
                    from,
                    to,
                });

            const latestTime = candles.length > 0 ? (candles[candles.length - 1]?.time ?? null) : null;
            const isStale = latestTime === null || to - latestTime > intervalSeconds * 2;
            if (isStale) yield* scheduleMintChartWarm({ mint, interval, days: requestedDays });

            return { assetId: canonical.assetId, interval, from, to, candles };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60, staleWhileRevalidate: 300 } },
);
