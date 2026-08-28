import { Effect } from 'effect';

import { tapErrorAndDefault } from '@tokens/effect';
import { coingeckoSearchCoins } from '@/lib/cloudrun';
import { getRedisClient, type RedisClient } from '@/lib/redis';

const COIN_ID_CACHE_NONE = '__none__';
const COIN_ID_CACHE_HIT_TTL_SECONDS = 24 * 60 * 60;
const COIN_ID_CACHE_MISS_TTL_SECONDS = 60 * 60;

function coinIdCacheKey(assetId: string): string {
    return `cg-coin-id:v1:${assetId}`;
}

/** `undefined` = no usable cache entry; `null` = cached "resolves to no coin id". */
export function coinIdCacheGet(
    assetId: string,
    redis: () => RedisClient = getRedisClient,
): Effect.Effect<string | null | undefined> {
    return Effect.tryPromise(async () => redis().get<string>(coinIdCacheKey(assetId))).pipe(
        Effect.map(value => (value === null ? undefined : value === COIN_ID_CACHE_NONE ? null : value)),
        Effect.catch(() => Effect.succeed(undefined)),
    );
}

export function coinIdCacheSet(
    assetId: string,
    coinId: string | null,
    redis: () => RedisClient = getRedisClient,
): Effect.Effect<void> {
    return Effect.tryPromise(async () =>
        redis().set(coinIdCacheKey(assetId), coinId ?? COIN_ID_CACHE_NONE, {
            ex: coinId ? COIN_ID_CACHE_HIT_TTL_SECONDS : COIN_ID_CACHE_MISS_TTL_SECONDS,
        }),
    ).pipe(
        Effect.asVoid,
        Effect.catch(() => Effect.void),
    );
}

export type CoinGeckoCoinSearchResult = {
    id: string;
    symbol: string;
    name: string;
    platforms: Record<string, string>;
};

function normalizeText(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[()]/g, '').trim();
}

export function scoreTokenizedCoinMatch(
    coin: CoinGeckoCoinSearchResult,
    asset: { name?: string | null; symbol?: string | null },
): number {
    const coinId = normalizeText(coin.id);
    const coinName = normalizeText(coin.name);
    const coinSymbol = normalizeText(coin.symbol);

    const assetName = normalizeText(asset.name ?? '');
    const assetSymbol = normalizeText(asset.symbol ?? '');

    // Never match pre-IPO/PreStocks listings for a canonical asset unless the asset itself
    // is a PreStocks asset. Canonical equities (e.g. SpaceX) price from our own stock data;
    // falling back to the PreStocks coin would show the wrong market.
    const isPreIpoListing = /prestocks?|pre-ipo/.test(coinId) || /pre[-\s]?stocks?|pre[-\s]?ipo/.test(coinName);
    const assetIsPreIpo = /pre[-\s]?stocks?|pre[-\s]?ipo/.test(assetName);
    if (isPreIpoListing && !assetIsPreIpo) return 0;

    let score = 0;

    const isOndo = coinId.includes('ondo-tokenized') || coinName.includes('ondo tokenized');
    const isXstock = coinId.endsWith('-xstock') || coinName.includes('xstock');
    if (isOndo) score += 50;
    if (isXstock) score += 25;

    if (assetName) {
        if (coinName === assetName) score += 20;
        if (coinName.startsWith(assetName)) score += 15;
        if (coinName.includes(assetName)) score += 5;
    }

    if (assetSymbol) {
        if (coinSymbol === assetSymbol) score += 10;
        if (coinId.startsWith(`${assetSymbol}-`)) score += 5;
    }

    if (coin.platforms && typeof coin.platforms === 'object' && 'solana' in coin.platforms) score += 2;

    return score;
}

export function pickBestTokenizedCoinId(
    coins: CoinGeckoCoinSearchResult[],
    asset: { name?: string | null; symbol?: string | null },
): string | null {
    if (!Array.isArray(coins) || coins.length === 0) return null;

    const scored = coins
        .map(coin => ({ coin, score: scoreTokenizedCoinMatch(coin, asset) }))
        .filter(row => row.score > 0)
        .sort((a, b) => b.score - a.score);

    return scored[0]?.coin.id ?? null;
}

export function resolveCoinGeckoCoinIdForAsset(params: {
    assetId: string;
    category: string;
    name?: string | null;
    symbol?: string | null;
    existingCoinId?: string | null;
}): Effect.Effect<string | null, never> {
    const existing = (params.existingCoinId ?? '').trim();
    if (existing) return Effect.succeed(existing);

    const category = (params.category ?? '').trim();
    const shouldSearch = category === 'equity' || category === 'etf';
    if (!shouldSearch) return Effect.succeed(null);

    const queries = [(params.name ?? '').trim(), (params.symbol ?? '').trim(), (params.assetId ?? '').trim()].filter(
        q => q.length >= 2,
    );

    if (queries.length === 0) return Effect.succeed(null);

    return Effect.gen(function* () {
        const cached = yield* coinIdCacheGet(params.assetId);
        if (cached !== undefined) return cached;

        for (const query of queries) {
            const coins = (yield* coingeckoSearchCoins({ query, limit: 25 }).pipe(
                tapErrorAndDefault('assets.resolveCoinGeckoCoinId.search', [] as CoinGeckoCoinSearchResult[], {
                    assetId: params.assetId,
                    query,
                }),
            )) as CoinGeckoCoinSearchResult[];

            const best = pickBestTokenizedCoinId(coins, { name: params.name ?? null, symbol: params.symbol ?? null });
            if (best) {
                yield* coinIdCacheSet(params.assetId, best);
                return best;
            }
        }

        yield* coinIdCacheSet(params.assetId, null);
        return null;
    });
}
