import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import { NotFoundError } from '@tokens/effect';
import { getAdvisoryRevisionSync } from '@/lib/advisories';
import { v2AssetsGetDetail, v2AssetsGetVariant } from '@/lib/cloudrun';

import { buildAssetFromDetail, loadAdvisories, loadPreStocks } from '../../../_assets-loader';
import { decodeChainAddressPath, toV2AssetSummary, type V2VariantResponse } from '../../../_shared-assets';

/**
 * GET /api/v2/variants/{chain}/{address} — one token on one chain and the
 * canonical asset it represents. The chain is part of the path, so a `0x`
 * address never has to guess which EVM chain it lives on; EVM addresses are
 * accepted in any casing and answered lowercase. Tokens that are not a
 * registered variant are 404 (`variant_not_found`).
 */

interface RouteCtx {
    params: Promise<{ chain: string; address: string }>;
}

const STALE_TTL_SECONDS = 15 * 60;

export const GET = route(
    (request: Request, ctx: RouteCtx) =>
        Effect.gen(function* () {
            const raw = yield* Effect.tryPromise(() => ctx.params);
            const { chain, address, key } = yield* decodeChainAddressPath({
                chain: decodeURIComponent(raw.chain),
                address: decodeURIComponent(raw.address),
            });

            const main = Effect.gen(function* () {
                const notFound = () =>
                    new NotFoundError({
                        message: 'Variant not found',
                        resource: 'variant',
                        details: { code: 'variant_not_found', key, chain, address },
                    });
                const lookup = yield* v2AssetsGetVariant({ chain, address });
                const owner = lookup?.variants[0];
                if (!lookup || !owner) return yield* Effect.fail(notFound());

                const detail = yield* v2AssetsGetDetail({ ref: owner.assetId });
                if (!detail) return yield* Effect.fail(notFound());
                const [advisoriesByMint, preStocksByMint] = yield* Effect.all([
                    loadAdvisories(),
                    loadPreStocks(detail.variants),
                ]);
                const asset = buildAssetFromDetail({
                    request,
                    detail,
                    advisoriesByMint,
                    preStocksByMint,
                    requestedStrategy: null,
                    includeVariants: true,
                });
                const variant = asset?.variants?.find(v => v.key === key);
                if (!asset || !variant) return yield* Effect.fail(notFound());
                const response: V2VariantResponse = { variant, asset: toV2AssetSummary(asset) };
                return response;
            });

            return yield* withStaleFallback(
                {
                    operation: 'v2.variants.lookup',
                    cacheKey: `v2:variant:${key}:${getAdvisoryRevisionSync()}`,
                    ttlSeconds: STALE_TTL_SECONDS,
                },
                main,
            );
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60, staleWhileRevalidate: 120 } },
);
