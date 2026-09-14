import { Effect } from 'effect';
import type { PegHealth, StructuralHealth, VariantAdvisory } from '@tokens/asset-registry';

import { getCuratedListSlugsForMint } from '@/lib/curated-membership';
import { variantMarketsGetLatestByMints } from '@/lib/cloudrun';
import { scheduleCacheWarm } from '@/lib/cloudrun/cacheWarm';
import { loadStablecoinHealthOrEmpty } from '@/lib/stablecoin-health';
import { computeMarketScore, type MarketScoreInput } from '@/lib/token-risk-helpers';

import type { LoadedAssetVariantContext } from './_asset-route-loader';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** `structuralHealth` as projected on `/risk-summary`: grade only, no per-category detail. */
export type StructuralHealthSummary = Pick<StructuralHealth, 'provider' | 'grade' | 'updatedAt' | 'stale'>;

export interface AssetRiskPayload {
    assetId: string;
    mint: string;
    risk:
        | {
              ok: true;
              marketScore: ReturnType<typeof computeMarketScore>;
              marketScoreInput: MarketScoreInput;
              tags: [];
              /** Active advisory on the selected mint (always present, `null` when none). */
              advisory: VariantAdvisory | null;
              /** Webacy depeg-monitor status (always present, `null` when the mint is unmonitored). */
              pegHealth: PegHealth | null;
              /** Webacy structural-health grade (always present, `null` when the mint is unmonitored). */
              structuralHealth: StructuralHealth | null;
              lastUpdatedAt: number | null;
          }
        | {
              ok: false;
              reason: 'not_found';
              message: string;
          };
}

function scheduleVariantMarketWarm(mint: string, operation: string): Effect.Effect<void, never> {
    return scheduleCacheWarm(null, {
        mint,
        variantMarket: true,
        markets: false,
        ohlcv: false,
        minAgeMs: 0,
        label: `assets.${operation}.scheduleVariantWarm`,
    });
}

export function marketScoreInputFromVariantMarket(
    mint: string,
    market: {
        liquidity?: number | null;
        marketCap?: number | null;
        holder?: number | null;
        volume24hUSD?: number | null;
    } | null,
): MarketScoreInput {
    if (!market) {
        return {
            liquidityUsd: null,
            marketCapUsd: null,
            holderCount: null,
            top10HoldersPercent: null,
            volume24hUsd: null,
            volume7dUsd: null,
            tokenMintTime: null,
            tokenAddress: mint,
        };
    }

    const volume24hUsd = market.volume24hUSD ?? null;
    const volume7dUsd = volume24hUsd != null && volume24hUsd > 0 ? volume24hUsd * 7 : null;

    return {
        liquidityUsd: market.liquidity ?? null,
        marketCapUsd: market.marketCap ?? null,
        holderCount: market.holder ?? null,
        top10HoldersPercent: null,
        volume24hUsd,
        volume7dUsd,
        tokenMintTime: null,
        tokenAddress: mint,
    };
}

export function loadAssetRisk(
    context: LoadedAssetVariantContext,
    options: { operation: 'summary' | 'details' },
): Effect.Effect<AssetRiskPayload, unknown> {
    return Effect.gen(function* () {
        const mint = context.selectedMint;
        // Market snapshot and stablecoin health are independent reads; the health
        // load fails open (empty map), so it never affects the market path.
        const [rows, healthByMint] = yield* Effect.all(
            [variantMarketsGetLatestByMints({ mints: [mint] }), loadStablecoinHealthOrEmpty([mint])],
            { concurrency: 'unbounded' },
        );
        const market = rows[0]?.market ?? null;
        const health = healthByMint.get(mint) ?? null;

        const isStaleMarket = market ? Date.now() - market.lastFetchedAt > 60 * 60_000 : true;
        if (!market || isStaleMarket) yield* scheduleVariantMarketWarm(mint, options.operation);

        if (!market && mint !== SOL_MINT) {
            return {
                assetId: context.assetDoc.assetId,
                mint,
                risk: { ok: false, reason: 'not_found', message: 'Market snapshot not available in cache' },
            };
        }

        const curatedListSlugs = yield* Effect.promise(() => getCuratedListSlugsForMint(mint));
        const marketScoreInput = { ...marketScoreInputFromVariantMarket(mint, market), curatedListSlugs };
        const marketScore = computeMarketScore(marketScoreInput);

        return {
            assetId: context.assetDoc.assetId,
            mint,
            risk: {
                ok: true,
                marketScore,
                marketScoreInput,
                tags: [],
                advisory: context.selectedVariant.advisory ?? context.advisoriesByMint.get(mint) ?? null,
                pegHealth: health?.pegHealth ?? null,
                structuralHealth: health?.structuralHealth ?? null,
                lastUpdatedAt: market?.lastFetchedAt ?? null,
            },
        };
    });
}

export function toStructuralHealthSummary(structural: StructuralHealth | null): StructuralHealthSummary | null {
    if (!structural) return null;
    return {
        provider: structural.provider,
        grade: structural.grade,
        updatedAt: structural.updatedAt,
        stale: structural.stale,
    };
}

export function toRiskSummary(payload: AssetRiskPayload): {
    assetId: string;
    mint: string;
    risk:
        | {
              ok: true;
              marketScore: ReturnType<typeof computeMarketScore>;
              pegHealth: PegHealth | null;
              structuralHealth: StructuralHealthSummary | null;
              lastUpdatedAt: number | null;
          }
        | {
              ok: false;
              reason: 'not_found';
              message: string;
          };
} {
    if (!payload.risk.ok) return payload;
    return {
        assetId: payload.assetId,
        mint: payload.mint,
        risk: {
            ok: true,
            marketScore: payload.risk.marketScore,
            pegHealth: payload.risk.pegHealth,
            structuralHealth: toStructuralHealthSummary(payload.risk.structuralHealth),
            lastUpdatedAt: payload.risk.lastUpdatedAt,
        },
    };
}

export function toRiskDetails(payload: AssetRiskPayload): AssetRiskPayload {
    return payload;
}
