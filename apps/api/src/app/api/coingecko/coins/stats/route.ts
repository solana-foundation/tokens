import { route } from '@/effect/next-route';
import { Effect } from 'effect';

import { coingeckoGetCoinById, type CoingeckoGetCoinByIdResult } from '@/lib/cloudrun';

export interface CoinGeckoCoinMarketStats {
    price: number;
    volume24h: number;
    priceChange24h: number;
}

/** Up to 30 ids per request; 8 lanes keeps that to about four round-trips without opening 30 connections. */
const COIN_STATS_CONCURRENCY = 8;

function toStatsEntry(id: string, doc: CoingeckoGetCoinByIdResult): readonly [string, CoinGeckoCoinMarketStats | null] {
    const md = doc?.coin?.market_data;

    const price = md?.current_price?.usd;
    if (typeof price !== 'number' || !Number.isFinite(price)) {
        return [id, null] as const;
    }

    const volume24h = md?.total_volume?.usd;
    const priceChange24h = md?.price_change_percentage_24h;

    return [
        id,
        {
            price,
            volume24h: typeof volume24h === 'number' && Number.isFinite(volume24h) ? volume24h : 0,
            priceChange24h: typeof priceChange24h === 'number' && Number.isFinite(priceChange24h) ? priceChange24h : 0,
        } satisfies CoinGeckoCoinMarketStats,
    ] as const;
}

function parseIds(raw: string): string[] {
    const parts = raw
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);

    const unique: string[] = [];
    const seen = new Set<string>();

    for (const id of parts) {
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(id);
    }

    return unique;
}

export const GET = route(
    (request: Request) =>
        Effect.gen(function* () {
            const url = new URL(request.url);
            const searchParams = url.searchParams;

            const rawIds = searchParams.get('ids') ?? '';
            const ids = parseIds(rawIds).slice(0, 30);

            if (ids.length === 0) {
                return { stats: {} satisfies Record<string, CoinGeckoCoinMarketStats | null> };
            }

            const out: Record<string, CoinGeckoCoinMarketStats | null> = {};
            for (const id of ids) out[id] = null;

            // Bounded fan-out inside the request fiber: the per-request Cloud Run
            // memo applies, a client abort cancels the reads, and a Cloud Run
            // failure keeps its tag (timeout -> 504, 429 -> 429).
            const results = yield* Effect.forEach(
                ids,
                id => coingeckoGetCoinById({ id }).pipe(Effect.map(doc => toStatsEntry(id, doc))),
                { concurrency: COIN_STATS_CONCURRENCY },
            );

            for (const [id, stats] of results) out[id] = stats;

            return { stats: out };
        }),
    { platform: { requiredScopes: ['internal:read'] } },
);
