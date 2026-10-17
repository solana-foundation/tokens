import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import { NotFoundError } from '@tokens/effect';
import { getAdvisoryRevisionSync } from '@/lib/advisories';
import { currentAssetId, loadAssetIdRenames } from '@/lib/asset-id-renames';
import { v2AssetsGetDetail } from '@/lib/cloudrun';

import { buildAssetFromDetail, loadAdvisories, loadPreStocks } from '../../_assets-loader';
import {
    decodeAssetIdPath,
    decodePrimaryVariantStrategyParam,
    type V2AssetResponse,
    type V2Variant,
} from '../../_shared-assets';

/**
 * GET /api/v2/assets/{assetId} — one canonical asset with every variant on
 * every chain, per-chain stats, the cross-chain aggregate and the off-chain
 * reference market. `{assetId}` is an asset id or alias (renames are
 * followed); token addresses are rejected — look those up under
 * /v2/variants/{chain}/{address}. Blocked variants are served here with
 * their advisory (list surfaces hide them).
 */

interface RouteCtx {
    params: Promise<{ assetId: string }>;
}

const STALE_TTL_SECONDS = 15 * 60;
/** The `solana` asset carries thousands of LST variants; keep the detail payload bounded as v1 does. */
const SOLANA_YIELD_MIN_LIQUIDITY_USD = 250_000;
const SOLANA_YIELD_MAX = 500;

function capSolanaYieldVariants(assetId: string, variants: V2Variant[]): V2Variant[] {
    if (assetId !== 'solana') return variants;
    let yieldKept = 0;
    return variants.filter(variant => {
        const isYield = variant.chain === 'solana' && (variant.kind === 'yield' || variant.kind === 'lst');
        if (!isYield) return true;
        if ((variant.market?.liquidity ?? 0) < SOLANA_YIELD_MIN_LIQUIDITY_USD) return false;
        if (yieldKept >= SOLANA_YIELD_MAX) return false;
        yieldKept += 1;
        return true;
    });
}

export const GET = route(
    (request: Request, ctx: RouteCtx) =>
        Effect.gen(function* () {
            const { assetId: rawAssetId } = yield* Effect.tryPromise(() => ctx.params);
            const requestedId = yield* decodeAssetIdPath(decodeURIComponent(rawAssetId));
            const url = new URL(request.url);
            const requestedStrategy = yield* decodePrimaryVariantStrategyParam(url.searchParams);

            const main = Effect.gen(function* () {
                const renames = yield* loadAssetIdRenames();
                const ref = currentAssetId(renames, requestedId);
                const detail = yield* v2AssetsGetDetail({ ref });
                if (!detail) {
                    return yield* Effect.fail(
                        new NotFoundError({
                            message: 'Asset not found',
                            resource: 'asset',
                            details: { code: 'asset_not_found', assetId: requestedId },
                        }),
                    );
                }
                const [advisoriesByMint, preStocksByMint] = yield* Effect.all([
                    loadAdvisories(),
                    loadPreStocks(detail.variants),
                ]);
                const asset = buildAssetFromDetail({
                    request,
                    detail,
                    advisoriesByMint,
                    preStocksByMint,
                    requestedStrategy,
                    includeVariants: true,
                });
                if (!asset) {
                    return yield* Effect.fail(
                        new NotFoundError({
                            message: 'Asset not found',
                            resource: 'asset',
                            details: { code: 'asset_not_found', assetId: requestedId },
                        }),
                    );
                }
                const response: V2AssetResponse = {
                    ...asset,
                    variants: capSolanaYieldVariants(asset.assetId, asset.variants ?? []),
                    resolvedBy: ref !== requestedId ? 'rename' : detail.resolvedBy,
                };
                return response;
            });

            // Last-good per asset; a 404 is a real answer and propagates (never cached as good).
            return yield* withStaleFallback(
                {
                    operation: 'v2.assets.detail',
                    cacheKey: `v2:asset:${requestedId}:${requestedStrategy ?? 'default'}:${getAdvisoryRevisionSync()}`,
                    ttlSeconds: STALE_TTL_SECONDS,
                },
                main,
            );
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60, staleWhileRevalidate: 120 } },
);
