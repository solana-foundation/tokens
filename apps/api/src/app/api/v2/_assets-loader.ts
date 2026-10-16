/**
 * Shared loading steps for the v2 asset routes: advisories, PreStocks
 * references and the per-asset build context from a detail / prefetch result.
 */
import { Effect } from 'effect';

import { tapErrorAndDefault } from '@tokens/effect';
import type { StablecoinHealth, VariantAdvisory } from '@tokens/asset-registry';
import { loadAdvisoriesOrEmpty } from '@/lib/advisories';
import { loadStablecoinHealthOrEmpty } from '@/lib/stablecoin-health';
import { variantFillQualityGetLatestByMints, type VariantFillQualityGetLatestByMintsResult } from '@/lib/cloudrun';
import type { AssetResult } from '../../../../../cloudrun-assets/src/handlers/assets';
import { executionQualitySnapshotFromConvexFillQuality, type VariantExecutionQualitySnapshot } from '../v1/assets/_asset-helpers';
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
    type V2AssetDetailInclude,
    type V2EnrichmentInputs,
    type V2PrimaryVariantStrategy,
} from './_shared-assets';
import { chainSupports } from '@tokens/asset-registry/chains';

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

const FILL_QUALITY_CHUNK = 250;

/** Fill-quality snapshots for the variants whose chain supports execution quality, keyed by mint. */
export function loadExecutionQuality(
    variants: readonly V2VariantResult[],
): Effect.Effect<ReadonlyMap<string, VariantExecutionQualitySnapshot>, never> {
    const mints = Array.from(
        new Set(variants.filter(v => chainSupports(v.chain, 'executionQuality')).map(v => v.address)),
    );
    if (mints.length === 0) return Effect.succeed(new Map());
    const chunks: string[][] = [];
    for (let i = 0; i < mints.length; i += FILL_QUALITY_CHUNK) chunks.push(mints.slice(i, i + FILL_QUALITY_CHUNK));
    return Effect.all(
        chunks.map(chunk =>
            variantFillQualityGetLatestByMints({ mints: chunk }).pipe(
                tapErrorAndDefault('v2.assets.executionQuality', [] as VariantFillQualityGetLatestByMintsResult, {
                    count: chunk.length,
                }),
            ),
        ),
        { concurrency: 4 },
    ).pipe(
        Effect.map(results => {
            const byMint = new Map<string, VariantExecutionQualitySnapshot>();
            for (const row of results.flat()) {
                const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
                if (snapshot) byMint.set(row.mint, snapshot);
            }
            return byMint;
        }),
    );
}

/** Peg / structural health for stablecoin assets (chains with `risk` only), keyed by mint. Fail-open. */
export function loadStablecoinHealth(
    asset: Pick<AssetResult, 'category'>,
    variants: readonly V2VariantResult[],
): Effect.Effect<ReadonlyMap<string, StablecoinHealth>, never> {
    if (asset.category !== 'stablecoin') return Effect.succeed(new Map());
    const mints = variants.filter(v => chainSupports(v.chain, 'risk')).map(v => v.address);
    return loadStablecoinHealthOrEmpty(mints);
}

/** Resolve the requested `include=` set into enrichment inputs (none requested → undefined, no keys on variants). */
export function loadEnrichments(
    include: ReadonlySet<string>,
    asset: Pick<AssetResult, 'category'>,
    variants: readonly V2VariantResult[],
): Effect.Effect<V2EnrichmentInputs | undefined, never> {
    const wants = (key: V2AssetDetailInclude) => include.has(key);
    if (!wants('executionQuality') && !wants('pegHealth') && !wants('preStocks')) return Effect.succeed(undefined);
    return Effect.all([
        wants('executionQuality') ? loadExecutionQuality(variants) : Effect.succeed(null),
        wants('pegHealth') ? loadStablecoinHealth(asset, variants) : Effect.succeed(null),
    ]).pipe(
        Effect.map(([executionQualityByMint, stablecoinHealthByMint]) => ({
            executionQualityByMint,
            stablecoinHealthByMint,
            preStocks: wants('preStocks'),
        })),
    );
}

/** Build one asset from a `v2AssetsGetDetail` result (detail surfaces keep hidden variants). */
export function buildAssetFromDetail(params: {
    request: Request;
    detail: V2AssetDetailResult;
    advisoriesByMint: ReadonlyMap<string, VariantAdvisory>;
    preStocksByMint: ReadonlyMap<string, PreStocksMintSnapshot>;
    requestedStrategy: V2PrimaryVariantStrategy | null;
    includeVariants: boolean;
    enrichments?: V2EnrichmentInputs;
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
        ...(params.enrichments ? { enrichments: params.enrichments } : {}),
    });
}
