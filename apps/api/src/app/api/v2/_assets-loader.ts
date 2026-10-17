/**
 * Shared loading steps for the v2 asset routes: advisories, PreStocks
 * references and the per-asset build context from a detail / prefetch result.
 */
import { Effect } from 'effect';

import { tapErrorAndDefault } from '@tokens/effect';
import type { VariantAdvisory } from '@tokens/asset-registry';
import { loadAdvisoriesOrEmpty } from '@/lib/advisories';
import type { V2AssetDetailResult, V2VariantResult } from '@/lib/cloudrun';
import { prestocksGetLatestByMints, type GetLatestByMintsResult } from '@/lib/cloudrun/prestocksReads';
import type { PreStocksMintSnapshot } from '../v1/assets/_asset-detail-response';

import {
    buildV2Asset,
    marketByKeyFrom,
    preStocksMapFrom,
    preStocksMintsOf,
    rollupsByAssetFrom,
    type V2Asset,
    type V2PrimaryVariantStrategy,
} from './_shared-assets';

export function loadPreStocks(
    variants: readonly V2VariantResult[],
): Effect.Effect<ReadonlyMap<string, PreStocksMintSnapshot>, never> {
    const mints = preStocksMintsOf(variants);
    if (mints.length === 0) return Effect.succeed(new Map());
    return prestocksGetLatestByMints({ mints }).pipe(
        tapErrorAndDefault('v2.assets.prestocks', [] as GetLatestByMintsResult, { count: mints.length }),
        Effect.map(entries => preStocksMapFrom(entries)),
    );
}

export function loadAdvisories(): Effect.Effect<ReadonlyMap<string, VariantAdvisory>, never> {
    return loadAdvisoriesOrEmpty();
}

/** Build one asset from a `v2AssetsGetDetail` result (detail surfaces keep hidden variants). */
export function buildAssetFromDetail(params: {
    request: Request;
    detail: V2AssetDetailResult;
    advisoriesByMint: ReadonlyMap<string, VariantAdvisory>;
    preStocksByMint: ReadonlyMap<string, PreStocksMintSnapshot>;
    requestedStrategy: V2PrimaryVariantStrategy | null;
    includeVariants: boolean;
}): V2Asset | null {
    const { detail } = params;
    return buildV2Asset({
        request: params.request,
        asset: detail.asset,
        variants: detail.variants,
        marketByKey: marketByKeyFrom(detail.markets),
        rollupByChain: rollupsByAssetFrom(detail.chainRollups).get(detail.asset.assetId) ?? null,
        advisoriesByMint: params.advisoriesByMint,
        coingeckoPrice: detail.coingeckoPrice?.snapshot ?? null,
        stockInstrument: detail.stockInstrument?.instrument ?? null,
        stockPrice: detail.stockPrice?.snapshot ?? null,
        preStocksByMint: params.preStocksByMint,
        requestedStrategy: params.requestedStrategy,
        hideBlocked: false,
        listChain: null,
        includeVariants: params.includeVariants,
        rank: null,
    });
}
