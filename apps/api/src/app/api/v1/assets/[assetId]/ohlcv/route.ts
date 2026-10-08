import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError, NotFoundError } from '@tokens/effect';
import {
    decodeUnknownOrBadRequest,
    NonNegativeIntFromString,
    SolanaAddress,
    TimeInterval as TimeIntervalSchema,
} from '@tokens/effect';
import { scheduleCacheWarm } from '@/lib/cloudrun/cacheWarm';
import { getByAssetId as cloudRunGetByAssetId } from '@/lib/cloudrun/assets';
import { assetVariantsListByAssetIds, ohlcvList } from '@/lib/cloudrun';
import { buildCuratedMintRank, pickPrimaryVariant } from '../../_asset-helpers';
import { loadTokensByMints } from '../../_load-variant-markets';
import { resolveAssetIdFromRef } from '../../_resolve-asset-ref';
import type { TimeInterval } from '@/lib/birdeye';
import { intervalToSeconds, validateOhlcvRange } from '@/lib/ohlcv-bounds';
import type { CanonicalAsset } from '@tokens/asset-registry';
import { resolveAlias as resolveRegistryAlias } from '@tokens/asset-registry';
import { singletonAssetIdToMint } from '../../_singleton-asset-id';
import { loadSingletonIdentity } from '../../_singleton-identity';

type AssetVariantRow = {
    variantId: string;
    mint: string;
    kind: CanonicalAsset['variants'][number]['kind'];
    trustTier: CanonicalAsset['variants'][number]['trustTier'];
    tags: string[];
    issuer?: string;
    issuerUrl?: string;
    label?: string;
};


function scheduleOhlcvWarm(params: { mint: string; interval: TimeInterval; days: number }): Effect.Effect<void, never> {
    return scheduleCacheWarm(null, {
        mint: params.mint,
        variantMarket: false,
        markets: false,
        ohlcv: true,
        ohlcvInterval: params.interval,
        ohlcvDays: params.days,
        minAgeMs: 0,
        label: 'assets.ohlcv.scheduleWarm',
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

            const assetId = yield* resolveAssetIdFromRef(assetRef);

            const assetDoc = yield* cloudRunGetByAssetId({ assetId });

            let canonical: CanonicalAsset | null = null;
            if (assetDoc) {
                const variantsRows = yield* assetVariantsListByAssetIds({ assetIds: [assetDoc.assetId] });
                const variants = (variantsRows[0]?.variants ?? []) as AssetVariantRow[];

                canonical = {
                    assetId: assetDoc.assetId,
                    ...(assetDoc.name ? { name: assetDoc.name } : {}),
                    ...(assetDoc.symbol ? { symbol: assetDoc.symbol } : {}),
                    category: assetDoc.category,
                    aliases: assetDoc.aliases,
                    ...(assetDoc.coingeckoId ? { coingeckoId: assetDoc.coingeckoId } : {}),
                    variants: variants.map(variant => ({
                        variantId: variant.variantId,
                        mint: variant.mint,
                        kind: variant.kind,
                        trustTier: variant.trustTier,
                        tags: variant.tags,
                        ...(variant.issuer ? { issuer: variant.issuer } : {}),
                        ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
                        ...(variant.label ? { label: variant.label } : {}),
                    })),
                };
            } else {
                const singletonMint = singletonAssetIdToMint(assetId);
                if (singletonMint) {
                    const identity = yield* loadSingletonIdentity(singletonMint);

                    if (identity) {
                        canonical = {
                            assetId,
                            ...(identity.name ? { name: identity.name } : {}),
                            ...(identity.symbol ? { symbol: identity.symbol } : {}),
                            category: 'crypto',
                            aliases: [singletonMint],
                            variants: [
                                {
                                    variantId: `${assetId}:${singletonMint.slice(0, 8)}`,
                                    mint: singletonMint,
                                    kind: 'native',
                                    trustTier: 'tier3',
                                    tags: [],
                                    ...(identity.symbol ? { symbol: identity.symbol } : {}),
                                    ...(identity.name ? { name: identity.name } : {}),
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
            if (canonical.variants.length === 0) {
                return yield* Effect.fail(
                    new NotFoundError({ message: 'No variants available', resource: 'assetVariant' }),
                );
            }

            const mintRank = buildCuratedMintRank();

            const tokenByMint = yield* Effect.tryPromise(() => loadTokensByMints(canonical.variants.map(v => v.mint)));
            const primary = pickPrimaryVariant(canonical, mintRank, tokenByMint);
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

            const rawInterval = searchParams.get('interval');
            const interval: TimeInterval = rawInterval
                ? yield* decodeUnknownOrBadRequest(TimeIntervalSchema, rawInterval, 'Invalid interval')
                : ('1H' as const);

            const now = Math.floor(Date.now() / 1000);
            const requestedFromRaw = searchParams.get('from');
            const requestedToRaw = searchParams.get('to');

            const parsedFrom = requestedFromRaw
                ? yield* decodeUnknownOrBadRequest(NonNegativeIntFromString, requestedFromRaw, 'Invalid from')
                : now - 7 * 24 * 60 * 60;
            const parsedTo = requestedToRaw
                ? yield* decodeUnknownOrBadRequest(NonNegativeIntFromString, requestedToRaw, 'Invalid to')
                : now;

            const { from: requestedFrom, to: requestedTo } = yield* validateOhlcvRange({
                from: parsedFrom,
                to: parsedTo,
                interval,
            });

            const candles = yield* ohlcvList({
                    address: mint,
                    interval,
                    from: requestedFrom,
                    to: requestedTo,
                });

            const intervalSeconds = intervalToSeconds(interval);
            const latestTime = candles.length > 0 ? (candles[candles.length - 1]?.time ?? null) : null;
            const isStale = latestTime === null || requestedTo - latestTime > intervalSeconds * 2;
            if (isStale) {
                const requestedDays = Math.max(1, Math.ceil((requestedTo - requestedFrom) / (24 * 60 * 60)));
                yield* scheduleOhlcvWarm({ mint, interval, days: requestedDays });
            }

            return {
                assetId,
                mint,
                interval,
                from: requestedFrom,
                to: requestedTo,
                candles,
            };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60, staleWhileRevalidate: 300 } },
);
