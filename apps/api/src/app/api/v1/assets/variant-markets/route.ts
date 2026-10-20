import { Effect } from 'effect';

import { route } from '@/effect/next-route';
import { decodeUnknownOrBadRequest, SolanaAddress } from '@tokens/effect';
import { loadAdvisoriesOrEmpty } from '@/lib/advisories';
import { scheduleCacheWarm } from '@/lib/cloudrun/cacheWarm';
import {
    assetVariantsListByMints,
    variantFillQualityGetLatestByMints,
    variantMarketsGetLatestByMints,
    type AssetVariantsListByMintsResult,
} from '@/lib/cloudrun';
import { getVariantByMint } from '@tokens/asset-registry';
import { executionQualitySnapshotFromConvexFillQuality } from '../_asset-helpers';
import { partitionRegisteredMints, v1RegisteredOnlyEnabled } from '../_registered-only';

type AssetVariantRows = AssetVariantsListByMintsResult;

function parseMints(raw: string): string[] {
    const parts = raw
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const mint of parts) {
        if (seen.has(mint)) continue;
        seen.add(mint);
        unique.push(mint);
    }
    return unique;
}

function scheduleVariantMarketWarm(mint: string): Effect.Effect<void, never> {
    return scheduleCacheWarm(null, {
        mint,
        variantMarket: true,
        markets: false,
        ohlcv: false,
        minAgeMs: 0,
        label: 'assets.variantMarkets.scheduleWarm',
    });
}

export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const rawMints = url.searchParams.get('mints') ?? url.searchParams.get('addresses') ?? '';
            const mintsRaw = parseMints(rawMints).slice(0, 50);
            if (mintsRaw.length === 0) return { variants: [] as Array<unknown> };

            const mints: string[] = [];
            for (const raw of mintsRaw) {
                mints.push(yield* decodeUnknownOrBadRequest(SolanaAddress, raw, 'Invalid mint'));
            }

            const [marketRows, fillQualityRows, variantRows, advisoriesByMint, partition] = yield* Effect.all(
                [
                    variantMarketsGetLatestByMints({ mints }),
                    variantFillQualityGetLatestByMints({ mints }),
                    assetVariantsListByMints({ mints }),
                    loadAdvisoriesOrEmpty(),
                    // v1 serves registered assets only: unregistered mints keep their
                    // row but carry no market, and are never warmed.
                    v1RegisteredOnlyEnabled()
                        ? partitionRegisteredMints(mints)
                        : Effect.succeed({ registered: [...mints], unregistered: [] as string[] }),
                ],
                { concurrency: 'unbounded' },
            );
            const unregistered = new Set(partition.unregistered);

            const marketByMint = new Map<string, (typeof marketRows)[number]['market']>();
            for (const row of marketRows) marketByMint.set(row.mint, row.market);
            const fillQualityByMint = new Map<
                string,
                ReturnType<typeof executionQualitySnapshotFromConvexFillQuality>
            >();
            for (const row of fillQualityRows) {
                fillQualityByMint.set(row.mint, executionQualitySnapshotFromConvexFillQuality(row.fillQuality));
            }
            const variantByMint = new Map<string, AssetVariantRows[number]['variant']>(
                variantRows.map((row: AssetVariantRows[number]) => [row.mint, row.variant] as const),
            );

            const missingOrStale = mints.filter(mint => {
                if (unregistered.has(mint)) return false;
                const market = marketByMint.get(mint) ?? null;
                if (!market) return true;
                return Date.now() - market.lastFetchedAt > 60 * 60_000;
            });

            if (missingOrStale.length > 0) {
                yield* Effect.all(
                    missingOrStale.slice(0, 5).map(mint => scheduleVariantMarketWarm(mint)),
                    { concurrency: 2 },
                );
            }

            return {
                variants: mints.map(mint => {
                    if (unregistered.has(mint)) {
                        return {
                            mint,
                            assetId: null,
                            chain: null,
                            market: null,
                            executionQuality: null,
                            advisory: advisoriesByMint.get(mint) ?? null,
                        };
                    }
                    const variant = variantByMint.get(mint) ?? null;
                    const registryMatch = variant ? null : getVariantByMint(mint);
                    const marketOut = marketByMint.get(mint) ?? null;
                    return {
                        mint,
                        // A mint the compiled registry knows but the DB has no variant row for.
                        assetId: variant?.assetId ?? registryMatch?.asset.assetId ?? null,
                        chain: variant?.chain ?? (registryMatch ? 'solana' : null),
                        market: marketOut,
                        executionQuality: fillQualityByMint.get(mint) ?? null,
                        advisory: advisoriesByMint.get(mint) ?? null,
                    };
                }),
            };
        }),
    { platform: { requiredScopes: ['assets:read'] }, cache: { maxAge: 60 } },
);
