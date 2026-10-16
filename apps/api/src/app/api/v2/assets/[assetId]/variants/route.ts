import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import {
    LIQUIDITY_TIERS,
    STOCK_VARIANT_TIERS,
    VARIANT_KINDS,
    type LiquidityTier,
    type StockVariantTier,
    type VariantKind,
} from '@tokens/asset-registry';
import { NotFoundError, decodeLimit, decodeOffset } from '@tokens/effect';
import { getAdvisoryRevisionSync } from '@/lib/advisories';
import { currentAssetId, loadAssetIdRenames } from '@/lib/asset-id-renames';
import { v2AssetsGetDetail } from '@/lib/cloudrun';

import { buildAssetFromDetail, loadAdvisories, loadPreStocks } from '../../../_assets-loader';
import {
    V2_VARIANT_SORTS,
    decodeAssetIdPath,
    decodeChainParam,
    decodeEnumParam,
    type V2AssetVariantsResponse,
    type V2Variant,
    type V2VariantSort,
} from '../../../_shared-assets';

/**
 * GET /api/v2/assets/{assetId}/variants — the asset's variants on every chain
 * (or one with `chain=`), filterable by kind / liquidityTier /
 * stockVariantTier, sorted and paginated. Unlike the detail route this view is
 * never capped, so it is the full list for the `solana` asset too.
 */

interface RouteCtx {
    params: Promise<{ assetId: string }>;
}

const DEFAULT_LIMIT = '100';
const MAX_LIMIT = 1000;
const STALE_TTL_SECONDS = 10 * 60;

const STOCK_TIER_ORDER: Record<StockVariantTier, number> = {
    share_redeemable: 0,
    cash_redeemable: 1,
    not_redeemable: 2,
};

function sortVariants(variants: V2Variant[], sort: V2VariantSort): V2Variant[] {
    const byLiquidity = (a: V2Variant, b: V2Variant) => (b.market?.liquidity ?? 0) - (a.market?.liquidity ?? 0);
    if (sort === 'stock_redeemability') {
        return [...variants].sort((a, b) => {
            const ta = a.stockVariantTier ? STOCK_TIER_ORDER[a.stockVariantTier] : 3;
            const tb = b.stockVariantTier ? STOCK_TIER_ORDER[b.stockVariantTier] : 3;
            return ta - tb || byLiquidity(a, b);
        });
    }
    // execution_quality falls back to liquidity until fill quality joins v2 (capability-gated, Solana only).
    return [...variants].sort(byLiquidity);
}

export const GET = route(
    (request: Request, ctx: RouteCtx) =>
        Effect.gen(function* () {
            const { assetId: rawAssetId } = yield* Effect.tryPromise(() => ctx.params);
            const requestedId = yield* decodeAssetIdPath(decodeURIComponent(rawAssetId));
            const params = new URL(request.url).searchParams;
            const chain = yield* decodeChainParam(params);
            const kind = yield* decodeEnumParam<VariantKind>(params, 'kind', VARIANT_KINDS, 'invalid_kind');
            const liquidityTier = yield* decodeEnumParam<LiquidityTier>(
                params,
                'liquidityTier',
                LIQUIDITY_TIERS,
                'invalid_liquidity_tier',
            );
            const stockVariantTier = yield* decodeEnumParam<StockVariantTier>(
                params,
                'stockVariantTier',
                STOCK_VARIANT_TIERS,
                'invalid_stock_variant_tier',
            );
            const sort =
                (yield* decodeEnumParam<V2VariantSort>(params, 'sort', V2_VARIANT_SORTS, 'invalid_sort')) ??
                'liquidity';
            const limit = yield* decodeLimit(params.get('limit'), { defaultValue: DEFAULT_LIMIT, max: MAX_LIMIT });
            const offset = yield* decodeOffset(params.get('offset'));

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
                    requestedStrategy: null,
                    includeVariants: true,
                });
                const all = asset?.variants ?? [];
                const filtered = all.filter(
                    variant =>
                        (chain === null || variant.chain === chain) &&
                        (kind === null || variant.kind === kind) &&
                        (liquidityTier === null || variant.liquidityTier === liquidityTier) &&
                        (stockVariantTier === null || variant.stockVariantTier === stockVariantTier),
                );
                const sorted = sortVariants(filtered, sort);
                const response: V2AssetVariantsResponse = {
                    assetId: detail.asset.assetId,
                    variants: sorted.slice(offset, offset + limit),
                    total: sorted.length,
                    sort,
                };
                return response;
            });

            return yield* withStaleFallback(
                {
                    operation: 'v2.assets.variants',
                    cacheKey: `v2:asset-variants:${requestedId}:${chain ?? ''}:${kind ?? ''}:${liquidityTier ?? ''}:${stockVariantTier ?? ''}:${sort}:${limit}:${offset}:${getAdvisoryRevisionSync()}`,
                    ttlSeconds: STALE_TTL_SECONDS,
                },
                main,
            );
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 30, staleWhileRevalidate: 60 } },
);
