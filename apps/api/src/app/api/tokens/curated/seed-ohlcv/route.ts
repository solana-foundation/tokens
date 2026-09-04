import { Array as Arr, Effect } from 'effect';

import { ohlcvBounds } from '@/lib/cloudrun';
import { getTokenOHLCV, type TimeInterval } from '@/lib/birdeye';
import { CURATED_LIST_ORDER, type CuratedListSlug as CuratedTokenListId } from '@tokens/asset-registry/curated-lists';
import { MissingEnvError, NotFoundError } from '@tokens/effect';
import { route } from '@/effect/next-route';
import {
    decodeUnknownOrBadRequest,
    NonNegativeIntFromString,
    PositiveIntFromString,
    TimeInterval as TimeIntervalSchema,
} from '@tokens/effect';
import { getEffectiveCuratedAddresses } from '../../../_curated-addresses';

type CuratedTokenCategoryId = 'all' | CuratedTokenListId;

function isCuratedTokenCategoryId(value: string): value is CuratedTokenCategoryId {
    if (value === 'all') return true;
    return CURATED_LIST_ORDER.includes(value as CuratedTokenListId);
}

function intervalToSeconds(interval: TimeInterval): number {
    switch (interval) {
        case '1m':
            return 60;
        case '5m':
            return 5 * 60;
        case '15m':
            return 15 * 60;
        case '1H':
            return 60 * 60;
        case '4H':
            return 4 * 60 * 60;
        case '1D':
            return 24 * 60 * 60;
        case '1W':
            return 7 * 24 * 60 * 60;
        default:
            return 60 * 60;
    }
}

export const POST = route((request: Request) =>
    Effect.gen(function* () {
        // Avoid exposing a bulk-write endpoint in production by default.
        if (process.env.NODE_ENV === 'production') {
            return yield* Effect.fail(new NotFoundError({ message: 'Not found' }));
        }

        const apiKey = process.env.BIRDEYE_API_KEY?.trim();
        if (!apiKey)
            return yield* Effect.fail(
                new MissingEnvError({ name: 'BIRDEYE_API_KEY', message: 'BIRDEYE_API_KEY is not set' }),
            );

        const url = new URL(request.url);
        const searchParams = url.searchParams;
        const rawListId = searchParams.get('list') ?? 'all';
        const listId: CuratedTokenCategoryId = isCuratedTokenCategoryId(rawListId) ? rawListId : 'all';

        const rawInterval = searchParams.get('interval');
        const interval: TimeInterval = rawInterval
            ? yield* decodeUnknownOrBadRequest(TimeIntervalSchema, rawInterval, 'Invalid interval')
            : ('1H' as const);

        const days = yield* decodeUnknownOrBadRequest(
            PositiveIntFromString,
            searchParams.get('days') ?? '7',
            'Invalid days',
        );
        const offset = yield* decodeUnknownOrBadRequest(
            NonNegativeIntFromString,
            searchParams.get('offset') ?? '0',
            'Invalid offset',
        );
        const limitUnclamped = yield* decodeUnknownOrBadRequest(
            PositiveIntFromString,
            searchParams.get('limit') ?? '25',
            'Invalid limit',
        );
        const limit = Math.min(limitUnclamped, 200);

        const { addresses: allAddresses } = yield* Effect.tryPromise(() => getEffectiveCuratedAddresses(listId));

        const addresses = allAddresses.slice(offset, offset + limit);

        const now = Math.floor(Date.now() / 1000);
        const requestedFrom = now - days * 24 * 60 * 60;
        const requestedTo = now;

        const intervalSeconds = intervalToSeconds(interval);

        // Per-address stats returned by each worker to avoid race conditions
        interface AddressStats {
            inserted: number;
            updated: number;
            skipped: number;
            fetchedCandles: number;
        }

        function seedAddress(
            address: string,
        ): Effect.Effect<{ address: string; ok: boolean; stats: AddressStats }, never> {
            return Effect.gen(function* () {
                const stats: AddressStats = { inserted: 0, updated: 0, skipped: 0, fetchedCandles: 0 };

                const bounds = yield* ohlcvBounds({ address, interval });

                const segmentsToFetch: Array<{ from: number; to: number }> = [];

                if (bounds.minTime === null || bounds.maxTime === null) {
                    segmentsToFetch.push({ from: requestedFrom, to: requestedTo });
                } else {
                    if (bounds.minTime > requestedFrom + intervalSeconds) {
                        segmentsToFetch.push({ from: requestedFrom, to: bounds.minTime });
                    }
                    if (bounds.maxTime < requestedTo - intervalSeconds) {
                        segmentsToFetch.push({ from: bounds.maxTime, to: requestedTo });
                    }
                }

                for (const segment of segmentsToFetch) {
                    const candles = yield* Effect.tryPromise(() =>
                        getTokenOHLCV(address, interval, segment.from, segment.to),
                    );
                    stats.fetchedCandles += candles.length;

                    // ponytail: dev-only seed endpoint (NODE_ENV=production 404s).
                    // Write path removed with Convex; add an `ohlcvUpsertMany`
                    // cloudrun-assets mutation and route through it when this
                    // endpoint needs to actually seed OHLCV again.
                    for (const candlesChunk of Arr.chunksOf(candles, 500)) {
                        void candlesChunk;
                    }
                }

                return { address, ok: true, stats };
            }).pipe(
                Effect.catch(() =>
                    Effect.succeed({
                        address,
                        ok: false,
                        stats: { inserted: 0, updated: 0, skipped: 0, fetchedCandles: 0 },
                    }),
                ),
            );
        }

        const results = yield* Effect.all(
            addresses.map(address => seedAddress(address)),
            { concurrency: 2 },
        );

        // Aggregate per-address stats into global totals after all workers complete
        let inserted = 0;
        let updated = 0;
        let skipped = 0;
        let fetchedCandles = 0;

        for (const result of results) {
            inserted += result.stats.inserted;
            updated += result.stats.updated;
            skipped += result.stats.skipped;
            fetchedCandles += result.stats.fetchedCandles;
        }

        const okCount = results.filter(r => r.ok).length;
        const failedCount = results.length - okCount;

        return {
            listId,
            interval,
            days,
            offset,
            limit,
            totalAddresses: allAddresses.length,
            processed: addresses.length,
            ok: okCount,
            failed: failedCount,
            fetchedCandles,
            inserted,
            updated,
            skipped,
            nextOffset: offset + limit < allAddresses.length ? offset + limit : null,
        };
    }),
);
