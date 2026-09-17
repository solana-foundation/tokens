import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { BadRequestError, NotFoundError, decodeLimit, tapErrorAndDefault } from '@tokens/effect';
import { loadAdvisoriesOrEmpty } from '@/lib/advisories';
import { getByAssetId as cloudRunGetByAssetId } from '@/lib/cloudrun/assets';
import { assetVariantsListByAssetIds, launchpadListByQuoteMints } from '@/lib/cloudrun';

import type { AssetVariant } from '@tokens/asset-registry';
import { resolveAlias as resolveRegistryAlias } from '@tokens/asset-registry';

import { resolveAssetIdFromRef } from '../../_resolve-asset-ref';
import { singletonAssetIdToMint } from '../../_singleton-asset-id';
import { canonicalizeAssetVariants } from '../../_canonical-overrides';
import { buildAssetLaunchesResponse, type AssetLaunchesResponse } from '../../_launches-response';

export type { AssetLaunchesResponse } from '../../_launches-response';

/**
 * Coins launched on a launchpad (stonk.fun) against any of this asset's
 * mints as the quote token. Empty for assets nothing was launched against.
 */
export const GET = route(
    (request: Request, ctx: { params: Promise<{ assetId: string }> }) =>
        Effect.gen(function* () {
            const { assetId: rawAssetId } = yield* Effect.tryPromise(() => ctx.params);
            const assetRef = (rawAssetId ?? '').trim();
            if (!assetRef) return yield* Effect.fail(new BadRequestError({ message: 'assetId is required' }));

            const url = new URL(request.url);
            const limit = yield* decodeLimit(url.searchParams.get('limit'), { defaultValue: '25', max: 100 });

            const assetId = yield* resolveAssetIdFromRef(assetRef);
            const singletonMint = singletonAssetIdToMint(assetId);

            let outAssetId = assetId;
            let quoteMints: string[] = [];

            if (singletonMint) {
                quoteMints = [singletonMint];
            } else {
                const assetDoc = yield* cloudRunGetByAssetId({ assetId });
                if (!assetDoc) {
                    const registry = resolveRegistryAlias(assetId);
                    if (!registry) {
                        return yield* Effect.fail(new NotFoundError({ message: 'Asset not found', resource: 'asset' }));
                    }
                    outAssetId = registry.assetId;
                    quoteMints = registry.variants.map(v => v.mint);
                } else {
                    outAssetId = assetDoc.assetId;
                    const variantsRows = yield* assetVariantsListByAssetIds({ assetIds: [assetDoc.assetId] });
                    const dbVariants = (variantsRows[0]?.variants ?? []) as unknown as AssetVariant[];
                    quoteMints = canonicalizeAssetVariants(outAssetId, dbVariants).map(v => v.mint);
                }
            }

            const empty: AssetLaunchesResponse = {
                assetId: outAssetId,
                total: 0,
                limit,
                launches: [],
                lastUpdatedAt: null,
            };
            if (quoteMints.length === 0) return empty;

            // Over-fetch so hidden (blocked) mints don't shrink the page.
            const rows = yield* launchpadListByQuoteMints({ quoteMints, limit: Math.min(limit * 2, 200) }).pipe(
                tapErrorAndDefault('assets.launches.list', [], { assetId: outAssetId }),
            );
            if (rows.length === 0) return empty;

            const advisoriesByMint = yield* loadAdvisoriesOrEmpty();
            return buildAssetLaunchesResponse({ assetId: outAssetId, rows, advisoriesByMint, limit });
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60 } },
);
