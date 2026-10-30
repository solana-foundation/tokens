import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError, NotFoundError } from '@tokens/effect';
import { decodeUnknownOrBadRequest, SolanaAddress } from '@tokens/effect';
import { scheduleCacheWarm } from '@/lib/cloudrun/cacheWarm';
import { getByAssetId as cloudRunGetByAssetId } from '@/lib/cloudrun/assets';
import { assetVariantsListByAssetIds, variantMarketsGetLatestByMints } from '@/lib/cloudrun';
import { buildCuratedMintRank, pickPrimaryVariant } from '../../_asset-helpers';
import { loadTokensByMints } from '../../_load-variant-markets';
import { resolveAssetIdFromRef } from '../../_resolve-asset-ref';
import type { CanonicalAsset } from '@tokens/asset-registry';

function scheduleVariantMarketWarm(mint: string): Effect.Effect<void, never> {
    return scheduleCacheWarm(null, {
        mint,
        variantMarket: true,
        markets: false,
        ohlcv: false,
        minAgeMs: 0,
        label: 'assets.variantMarket.scheduleWarm',
    });
}

export const GET = route(
    (request: Request, ctx: { params: Promise<{ assetId: string }> }) =>
        Effect.gen(function* () {
            const { assetId: rawAssetId } = yield* Effect.tryPromise(() => ctx.params);
            const assetRef = (rawAssetId ?? '').trim();
            if (!assetRef) return yield* Effect.fail(new BadRequestError({ message: 'assetId is required' }));

            const url = new URL(request.url);
            const assetId = yield* resolveAssetIdFromRef(assetRef);

            const assetDoc = yield* cloudRunGetByAssetId({ assetId });
            if (!assetDoc)
                return yield* Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));

            const variantsRows = yield* assetVariantsListByAssetIds({ assetIds: [assetDoc.assetId] });
            const variants = variantsRows[0]?.variants ?? [];
            if (variants.length === 0) {
                return yield* Effect.fail(
                    new NotFoundError({ message: 'No variants available', resource: 'assetVariant' }),
                );
            }

            const mintRank = buildCuratedMintRank();
            const canonicalVariants: CanonicalAsset['variants'] = [];
            for (const variant of variants) {
                canonicalVariants.push({
                    variantId: variant.variantId,
                    mint: variant.mint,
                    kind: variant.kind,
                    trustTier: variant.trustTier,
                    tags: variant.tags,
                    ...(variant.issuer ? { issuer: variant.issuer } : {}),
                    ...(variant.issuerUrl ? { issuerUrl: variant.issuerUrl } : {}),
                    ...(variant.label ? { label: variant.label } : {}),
                });
            }
            const canonical: CanonicalAsset = {
                assetId: assetDoc.assetId,
                ...(assetDoc.name ? { name: assetDoc.name } : {}),
                ...(assetDoc.symbol ? { symbol: assetDoc.symbol } : {}),
                category: assetDoc.category,
                aliases: assetDoc.aliases,
                ...(assetDoc.coingeckoId ? { coingeckoId: assetDoc.coingeckoId } : {}),
                variants: canonicalVariants,
            };

            const tokenByMint = yield* loadTokensByMints(canonical.variants.map(v => v.mint));
            const primary = pickPrimaryVariant(canonical, mintRank, tokenByMint);
            const requestedMintRaw = (url.searchParams.get('mint') ?? '').trim();
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

            const rows = yield* variantMarketsGetLatestByMints({ mints: [mint] });
            const marketOut = rows[0]?.market ?? null;

            const isStale = marketOut ? Date.now() - marketOut.lastFetchedAt > 60 * 60_000 : true;
            if (!marketOut || isStale) yield* scheduleVariantMarketWarm(mint);

            return {
                assetId: assetDoc.assetId,
                mint,
                market: marketOut,
                lastUpdatedAt: marketOut?.lastFetchedAt ?? null,
            };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60 } },
);
