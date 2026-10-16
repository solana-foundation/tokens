import { Effect } from 'effect';

import {
    tokenMarketsGetLatestByMints,
    variantFillQualityGetLatestByMints,
    variantMarketsGetLatestByMints,
} from '@/lib/cloudrun';
import { CloudRunQueryMemo, type CloudRunMemoStore } from '@/lib/cloudrun/client';

import {
    buildSnapshotFromTokenMarketsDoc,
    executionQualitySnapshotFromConvexFillQuality,
    tokenMarketSnapshotFromConvexMarket,
    type TokenMarketSnapshot,
    type VariantExecutionQualitySnapshot,
} from './_asset-helpers';
import { scheduleCacheWarm } from './_asset-detail-warm';

const MAX_FALLBACK_MINTS = 25;
const MAX_WARM_MINTS = 10;
const STALE_MARKET_MS = 60 * 60_000;

/**
 * Load the latest variant-market snapshots for a set of mints into the
 * provided maps:
 *
 * 1. one batched `variantMarkets.getLatestByMints` query for all mints;
 * 2. for mints missing display metadata, one batched
 *    `tokenMarkets.getLatestByMints` fallback (cached DEX markets) instead of
 *    a query per mint;
 * 3. best-effort cache warms for missing/stale mints (deferred until after
 *    the response is sent).
 */
export function loadVariantMarkets(
    request: Request,
    params: {
        mints: string[];
        fallbackSymbol: string | undefined;
        fallbackName: string | undefined;
        tokenByMint: Map<string, TokenMarketSnapshot>;
        marketMetaByMint: Map<string, { lastFetchedAt: number }>;
    },
): Effect.Effect<void, unknown, never> {
    return Effect.gen(function* () {
        const { tokenByMint, marketMetaByMint } = params;
        if (params.mints.length === 0) return;

        const rows = yield* variantMarketsGetLatestByMints({ mints: params.mints });

        const missingMints: string[] = [];
        for (const row of rows) {
            const market = row.market;
            if (!market) {
                missingMints.push(row.mint);
                continue;
            }

            marketMetaByMint.set(row.mint, { lastFetchedAt: market.lastFetchedAt });

            const hasDisplayMeta =
                typeof market.symbol === 'string' &&
                market.symbol.trim() &&
                typeof market.name === 'string' &&
                market.name.trim() &&
                typeof market.decimals === 'number' &&
                Number.isFinite(market.decimals);

            if (!hasDisplayMeta) {
                missingMints.push(row.mint);
                continue;
            }

            tokenByMint.set(row.mint, tokenMarketSnapshotFromConvexMarket(row.mint, market));
        }

        // Best-effort fallback for mints missing Birdeye `token_overview` coverage:
        // derive a snapshot from cached DEX markets.
        const uniqueMissing = Array.from(new Set(missingMints.map(m => m.trim()).filter(Boolean))).slice(
            0,
            MAX_FALLBACK_MINTS,
        );
        if (uniqueMissing.length === 0) return;

        // Opportunistically warm missing/stale market caches (limit to avoid abuse).
        for (const mint of uniqueMissing.slice(0, MAX_WARM_MINTS)) {
            const meta = marketMetaByMint.get(mint);
            const isStale = !meta || Date.now() - meta.lastFetchedAt > STALE_MARKET_MS;
            const isMissing = !tokenByMint.has(mint);
            if (isMissing || isStale) {
                yield* scheduleCacheWarm(request, { mint, markets: true, variantMarket: true });
            }
        }

        const tokenMarketsDocs = yield* tokenMarketsGetLatestByMints({ mints: uniqueMissing });

        for (const { mint, doc } of tokenMarketsDocs) {
            if (!doc) continue;
            marketMetaByMint.set(mint, { lastFetchedAt: doc.lastFetchedAt });

            const snapshot = buildSnapshotFromTokenMarketsDoc({
                mint,
                assetFallbackSymbol: params.fallbackSymbol,
                assetFallbackName: params.fallbackName,
                tokenMarketsDoc: doc,
            });
            if (!snapshot) continue;
            tokenByMint.set(mint, snapshot);
        }
    });
}

/**
 * These helpers run their RPC in a nested runtime (`Effect.runPromise`), which
 * cannot see the request's `CloudRunQueryMemo` Reference. Callers that hold
 * the request memo pass it in so a speculative batch can still answer the
 * call; the error semantics of the nested run are unchanged.
 */
export async function loadTokensByMints(
    mints: string[],
    memo: CloudRunMemoStore | null = null,
): Promise<Map<string, TokenMarketSnapshot>> {
    const uniqueMints = Array.from(new Set(mints.map(m => m.trim()).filter(Boolean)));
    if (uniqueMints.length === 0) return new Map();

    const rows = await Effect.runPromise(
        variantMarketsGetLatestByMints({ mints: uniqueMints }).pipe(Effect.provideService(CloudRunQueryMemo, memo)),
    );

    const out = new Map<string, TokenMarketSnapshot>();
    for (const row of rows) {
        const market = row.market;
        if (!market) continue;

        out.set(row.mint, tokenMarketSnapshotFromConvexMarket(row.mint, market));
    }

    return out;
}

export async function loadExecutionQualityByMints(
    mints: string[],
    memo: CloudRunMemoStore | null = null,
): Promise<Map<string, VariantExecutionQualitySnapshot>> {
    const uniqueMints = Array.from(new Set(mints.map(m => m.trim()).filter(Boolean)));
    if (uniqueMints.length === 0) return new Map();

    const rows = await Effect.runPromise(
        variantFillQualityGetLatestByMints({ mints: uniqueMints }).pipe(Effect.provideService(CloudRunQueryMemo, memo)),
    );

    const out = new Map<string, VariantExecutionQualitySnapshot>();
    for (const row of rows) {
        const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
        if (!snapshot) continue;
        out.set(row.mint, snapshot);
    }

    return out;
}
