import { createHash } from 'node:crypto';

import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { withStaleFallback } from '@/effect/stale-response-cache';
import { decodeLimit, decodeOffset } from '@tokens/effect';
import { getAdvisoryRevisionSync } from '@/lib/advisories';
import { v2AssetsCuratedPrefetch, type V2VariantResult } from '@/lib/cloudrun';

import { loadAdvisories, loadPreStocks } from '../_assets-loader';
import {
    assetsResponseLooksHealthy,
    buildV2Asset,
    decodeCategoryParam,
    decodeChainParam,
    decodeIncludeParam,
    decodeListParam,
    decodePrimaryScopeParam,
    decodePrimaryVariantStrategyParam,
    decodeQueryParam,
    marketByKeyFrom,
    rollupsByAssetFrom,
    type V2Asset,
    type V2AssetsResponse,
    hasVisibleVariantOnChain,
} from '../_shared-assets';

/**
 * GET /api/v2/assets — curated assets (one list or `all` = every curated
 * list) with their primary variant on every chain, per-chain stats and the
 * cross-chain aggregate. `chain=` narrows which variants are listed
 * (`include=variants`) and which assets qualify (≥1 variant there); stats
 * are always computed from the unfiltered set. Rows are ordered by headline
 * 24h volume, as v1's curated endpoint. `q` filters the curated set by
 * id / symbol / name / alias; the long tail of unregistered tokens lives
 * under /v2/search.
 */

const DEFAULT_LIMIT = '100';
const MAX_LIMIT = 500;
const STALE_TTL_SECONDS = 15 * 60;
const INCLUDES = ['variants'] as const;

function matchesQuery(asset: V2Asset, q: string): boolean {
    const needle = q.toLowerCase();
    const haystack = [asset.assetId, asset.name ?? '', asset.symbol ?? '', ...asset.aliases, ...asset.symbols];
    return haystack.some(value => value.toLowerCase().includes(needle));
}

export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const params = new URL(request.url).searchParams;
            const list = yield* decodeListParam(params);
            const chain = yield* decodeChainParam(params);
            const category = yield* decodeCategoryParam(params);
            const q = yield* decodeQueryParam(params);
            const requestedStrategy = yield* decodePrimaryVariantStrategyParam(params);
            const primaryScope = yield* decodePrimaryScopeParam(params);
            const include = yield* decodeIncludeParam(params, INCLUDES);
            const limit = yield* decodeLimit(params.get('limit'), { defaultValue: DEFAULT_LIMIT, max: MAX_LIMIT });
            const offset = yield* decodeOffset(params.get('offset'));
            const includeVariants = include.has('variants');
            // Stocks default to redeemability as in v1; equities inherit it per asset inside buildV2Asset.
            const strategy = requestedStrategy ?? (list === 'stocks' ? 'stock_redeemability' : null);

            const main = Effect.gen(function* () {
                const prefetch = yield* v2AssetsCuratedPrefetch({ listId: list });
                const [advisoriesByMint, preStocksByMint] = yield* Effect.all([
                    loadAdvisories(),
                    loadPreStocks(prefetch.variants),
                ]);

                const variantsByAsset = new Map<string, V2VariantResult[]>();
                for (const variant of prefetch.variants) {
                    const bucket = variantsByAsset.get(variant.assetId) ?? [];
                    bucket.push(variant);
                    variantsByAsset.set(variant.assetId, bucket);
                }
                const marketByKey = marketByKeyFrom(prefetch.markets);
                const rollupsByAsset = rollupsByAssetFrom(prefetch.chainRollups);
                const coingeckoByCoinId = new Map(
                    prefetch.coingeckoPrices.map(row => [row.coinId, row.snapshot] as const),
                );
                const stockInstrumentById = new Map(
                    prefetch.stockInstruments.map(row => [row.assetId, row.instrument] as const),
                );
                const stockPriceById = new Map(prefetch.stockPrices.map(row => [row.assetId, row.snapshot] as const));

                const built: V2Asset[] = [];
                for (const entry of prefetch.assets) {
                    const asset = entry.asset;
                    if (!asset) continue;
                    const variants = variantsByAsset.get(asset.assetId) ?? [];
                    if (variants.length === 0) continue;
                    if (chain !== null && !hasVisibleVariantOnChain(variants, chain, advisoriesByMint)) continue;
                    const coinId = asset.coingeckoId
                        ? (coingeckoByCoinId.get(asset.coingeckoId) ??
                          coingeckoByCoinId.get(asset.coingeckoId === 'bnb' ? 'binancecoin' : asset.coingeckoId))
                        : null;
                    const out = buildV2Asset({
                        request,
                        asset,
                        variants,
                        marketByKey,
                        rollupByChain: rollupsByAsset.get(asset.assetId) ?? null,
                        advisoriesByMint,
                        coingeckoPrice: coinId ?? null,
                        stockInstrument: stockInstrumentById.get(asset.assetId) ?? null,
                        stockPrice: stockPriceById.get(asset.assetId) ?? null,
                        preStocksByMint,
                        requestedStrategy: strategy,
                        primaryScope,
                        hideBlocked: true,
                        listChain: chain,
                        includeVariants,
                        rank: null,
                    });
                    if (!out) continue;
                    if (category !== null && out.category !== category) continue;
                    if (q !== null && !matchesQuery(out, q)) continue;
                    built.push(out);
                }
                built.sort((a, b) => (b.stats?.volume24hUSD ?? 0) - (a.stats?.volume24hUSD ?? 0));
                const ranked = built.map((asset, index) => ({ ...asset, rank: index }));
                const response: V2AssetsResponse = {
                    assets: ranked.slice(offset, offset + limit),
                    total: ranked.length,
                    list,
                    primaryVariantStrategy: strategy ?? 'liquidity',
                    primaryScope,
                };
                return response;
            });

            const paramsKey = createHash('sha1')
                .update(
                    [
                        list,
                        chain ?? '',
                        category ?? '',
                        q ?? '',
                        strategy ?? '',
                        primaryScope,
                        includeVariants ? 'v' : '',
                        limit,
                        offset,
                    ].join('|'),
                )
                .digest('hex')
                .slice(0, 24);
            return yield* withStaleFallback(
                {
                    operation: 'v2.assets.list',
                    cacheKey: `v2:assets:${paramsKey}:${getAdvisoryRevisionSync()}`,
                    ttlSeconds: STALE_TTL_SECONDS,
                    isHealthy: assetsResponseLooksHealthy,
                },
                main,
            );
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60, staleWhileRevalidate: 300 } },
);
