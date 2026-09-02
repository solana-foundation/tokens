import { describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import type { RedisClient, RedisSetOptions } from '@/lib/redis';
import {
    coinIdCacheGet,
    coinIdCacheSet,
    pickBestTokenizedCoinId,
    type CoinGeckoCoinSearchResult,
} from './_resolve-coingecko-coin-id';

function coin(partial: Partial<CoinGeckoCoinSearchResult> & Pick<CoinGeckoCoinSearchResult, 'id' | 'name' | 'symbol'>) {
    return {
        platforms: {},
        ...partial,
    } satisfies CoinGeckoCoinSearchResult;
}

describe('pickBestTokenizedCoinId', () => {
    it('prefers Ondo tokenized match for Verizon', () => {
        const coins: CoinGeckoCoinSearchResult[] = [
            coin({ id: 'verizon-xstock', name: 'Verizon xStock', symbol: 'VZX' }),
            coin({ id: 'verizon-ondo-tokenized', name: 'Verizon (Ondo Tokenized)', symbol: 'VZON' }),
        ];

        expect(pickBestTokenizedCoinId(coins, { name: 'Verizon', symbol: 'VZ' })).toBe('verizon-ondo-tokenized');
    });

    it('handles Ondo ids that include -stock suffix', () => {
        const coins: CoinGeckoCoinSearchResult[] = [
            coin({ id: 'airbnb-ondo-tokenized-stock', name: 'Airbnb (Ondo Tokenized Stock)', symbol: 'ABNBON' }),
        ];

        expect(pickBestTokenizedCoinId(coins, { name: 'Airbnb', symbol: 'ABNB' })).toBe('airbnb-ondo-tokenized-stock');
    });

    it('does not select unrelated non-tokenized coins', () => {
        const coins: CoinGeckoCoinSearchResult[] = [
            coin({ id: 'amc', name: 'AMC', symbol: 'AMC' }),
            coin({
                id: 'amc-entertainment-ondo-tokenized-stocks',
                name: 'AMC Entertainment (Ondo Tokenized Stock)',
                symbol: 'AMCON',
            }),
        ];

        expect(pickBestTokenizedCoinId(coins, { name: 'AMC Entertainment', symbol: 'AMC' })).toBe(
            'amc-entertainment-ondo-tokenized-stocks',
        );
    });
});

function stubRedis(store: Map<string, string>): () => RedisClient {
    const client = {
        get: async <T = string>(key: string) => (store.get(key) ?? null) as T | null,
        set: async (key: string, value: string | number, _options?: RedisSetOptions) => {
            store.set(key, String(value));
            return 'OK' as const;
        },
    } as RedisClient;
    return () => client;
}

describe('coinIdCache', () => {
    it('roundtrips a resolved coin id', async () => {
        const redis = stubRedis(new Map());
        await Effect.runPromise(coinIdCacheSet('verizon', 'verizon-ondo-tokenized', redis));
        expect(await Effect.runPromise(coinIdCacheGet('verizon', redis))).toBe('verizon-ondo-tokenized');
    });

    it('roundtrips a null resolution as null, not a miss', async () => {
        const redis = stubRedis(new Map());
        await Effect.runPromise(coinIdCacheSet('spacex', null, redis));
        expect(await Effect.runPromise(coinIdCacheGet('spacex', redis))).toBeNull();
    });

    it('returns undefined on cache miss', async () => {
        expect(await Effect.runPromise(coinIdCacheGet('spacex', stubRedis(new Map())))).toBe(undefined);
    });

    it('fails open when redis is unavailable', async () => {
        const broken = () => {
            throw new Error('redis down');
        };
        expect(await Effect.runPromise(coinIdCacheGet('spacex', broken))).toBe(undefined);
        await Effect.runPromise(coinIdCacheSet('spacex', null, broken));
    });
});
