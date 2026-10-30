import { Array as Arr, Effect } from 'effect';

import {
    tokenMarketsGetLatestByMints,
    variantFillQualityGetLatestByMints,
    variantMarketsGetLatestByMints,
    type CloudRunError,
} from '@/lib/cloudrun';

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
 * Latest variant-market snapshot per mint. Runs in the caller's fiber, so the
 * request's Cloud Run memo (speculative batch) and abort signal apply, and a
 * Cloud Run failure keeps its tag (timeout -> 504, 429 -> 429).
 */
export function loadTokensByMints(mints: string[]): Effect.Effect<Map<string, TokenMarketSnapshot>, CloudRunError> {
    const uniqueMints = Array.from(new Set(mints.map(m => m.trim()).filter(Boolean)));
    if (uniqueMints.length === 0) return Effect.succeed(new Map());

    return variantMarketsGetLatestByMints({ mints: uniqueMints }).pipe(
        Effect.map(rows => {
            const out = new Map<string, TokenMarketSnapshot>();
            for (const row of rows) {
                const market = row.market;
                if (!market) continue;
                out.set(row.mint, tokenMarketSnapshotFromConvexMarket(row.mint, market));
            }
            return out;
        }),
    );
}

const FILL_QUALITY_CHUNK_SIZE = 250;

/** Latest execution-quality snapshot per mint, in sequential chunks of 250 (the RPC's batch cap). */
export function loadExecutionQualityByMints(
    mints: string[],
): Effect.Effect<Map<string, VariantExecutionQualitySnapshot>, CloudRunError> {
    const uniqueMints = Array.from(new Set(mints.map(m => m.trim()).filter(Boolean)));
    if (uniqueMints.length === 0) return Effect.succeed(new Map());

    return Effect.forEach(Arr.chunksOf(uniqueMints, FILL_QUALITY_CHUNK_SIZE), chunk =>
        variantFillQualityGetLatestByMints({ mints: chunk }),
    ).pipe(
        Effect.map(chunks => {
            const out = new Map<string, VariantExecutionQualitySnapshot>();
            for (const rows of chunks) {
                for (const row of rows) {
                    const snapshot = executionQualitySnapshotFromConvexFillQuality(row.fillQuality);
                    if (!snapshot) continue;
                    out.set(row.mint, snapshot);
                }
            }
            return out;
        }),
    );
}
