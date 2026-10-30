import { afterEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';

import { fetchJsonWithRetry, UpstreamHttpError } from '@tokens/effect';
import {
    COINGECKO_NEWS_CATALOG_FRESHNESS_MS,
    createCoinGeckoNewsNotFoundRecovery,
    resolveCoinGeckoNewsCoinByMint,
    validateCoinGeckoNewsCoinId,
} from './coingecko-news';

const NOW = Date.UTC(2026, 7, 15, 12);
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.log = ORIGINAL_LOG;
});

describe('validateCoinGeckoNewsCoinId', () => {
    it('allows an active catalog id', async () => {
        const result = await Effect.runPromise(
            validateCoinGeckoNewsCoinId('bitcoin', {
                lookup: () => Effect.succeed({ lastSyncedAt: NOW - COINGECKO_NEWS_CATALOG_FRESHNESS_MS + 1 }),
                now: () => NOW,
            }),
        );

        expect(result).toEqual({ shouldFetch: true });
    });

    it('skips a missing internal-looking id and emits the reason', async () => {
        const events: Record<string, unknown>[] = [];
        const result = await Effect.runPromise(
            validateCoinGeckoNewsCoinId('stock-tzuc3szn', {
                lookup: () => Effect.succeed(null),
                now: () => NOW,
                emit: event => events.push(event),
            }),
        );

        expect(result).toEqual({ shouldFetch: false, reason: 'missing' });
        expect(events).toEqual([
            {
                event: 'coingecko_news_skipped',
                coin_id: 'stock-tzuc3szn',
                reason: 'missing',
            },
        ]);
    });

    it('skips a stale catalog row', async () => {
        const result = await Effect.runPromise(
            validateCoinGeckoNewsCoinId('old-coin', {
                lookup: () => Effect.succeed({ lastSyncedAt: NOW - COINGECKO_NEWS_CATALOG_FRESHNESS_MS - 1 }),
                now: () => NOW,
                emit: () => undefined,
            }),
        );

        expect(result).toEqual({ shouldFetch: false, reason: 'stale' });
    });

    it('fails closed when catalog validation is unavailable', async () => {
        const events: Record<string, unknown>[] = [];
        const result = await Effect.runPromise(
            validateCoinGeckoNewsCoinId('bitcoin', {
                lookup: () => Effect.fail(new Error('catalog unavailable')),
                emit: event => events.push(event),
            }),
        );

        expect(result).toEqual({ shouldFetch: false, reason: 'validation_unavailable' });
        expect(events[0]).toEqual({
            event: 'coingecko_news_skipped',
            coin_id: 'bitcoin',
            reason: 'validation_unavailable',
        });
    });

    it('leaves global news unchanged without consulting the catalog', async () => {
        let lookupCount = 0;
        const result = await Effect.runPromise(
            validateCoinGeckoNewsCoinId('   ', {
                lookup: () => {
                    lookupCount += 1;
                    return Effect.succeed(null);
                },
            }),
        );

        expect(result).toEqual({ shouldFetch: true });
        expect(lookupCount).toBe(0);
    });
});

describe('resolveCoinGeckoNewsCoinByMint', () => {
    const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

    it('resolves a fresh catalog row with a fetchable validation and no events', async () => {
        const events: Record<string, unknown>[] = [];
        const result = await Effect.runPromise(
            resolveCoinGeckoNewsCoinByMint(MINT, {
                lookup: () => Effect.succeed({ id: 'bonk', symbol: 'bonk', name: 'Bonk', lastSyncedAt: NOW }),
                now: () => NOW,
                emit: entry => void events.push(entry),
            }),
        );

        expect(result).toEqual({ coinId: 'bonk', symbol: 'bonk', name: 'Bonk', validation: { shouldFetch: true } });
        expect(events).toEqual([]);
    });

    it('emits the skip event for a stale row so the empty feed is explained', async () => {
        const events: Record<string, unknown>[] = [];
        const result = await Effect.runPromise(
            resolveCoinGeckoNewsCoinByMint(MINT, {
                lookup: () =>
                    Effect.succeed({
                        id: 'bonk',
                        symbol: 'bonk',
                        name: 'Bonk',
                        lastSyncedAt: NOW - COINGECKO_NEWS_CATALOG_FRESHNESS_MS - 1,
                    }),
                now: () => NOW,
                emit: entry => void events.push(entry),
            }),
        );

        expect(result?.validation).toEqual({ shouldFetch: false, reason: 'stale' });
        expect(events).toEqual([{ event: 'coingecko_news_skipped', coin_id: 'bonk', mint: MINT, reason: 'stale' }]);
    });

    it('returns null and emits unresolved for a missing row or a failed lookup', async () => {
        const events: Record<string, unknown>[] = [];
        const missing = await Effect.runPromise(
            resolveCoinGeckoNewsCoinByMint(MINT, {
                lookup: () => Effect.succeed(null),
                now: () => NOW,
                emit: entry => void events.push(entry),
            }),
        );
        const failed = await Effect.runPromise(
            resolveCoinGeckoNewsCoinByMint(MINT, {
                lookup: () => Effect.fail(new Error('catalog down')),
                now: () => NOW,
                emit: entry => void events.push(entry),
            }),
        );

        expect(missing).toBeNull();
        expect(failed).toBeNull();
        expect(events).toEqual([
            { event: 'coingecko_news_mint_unresolved', mint: MINT, reason: 'missing' },
            { event: 'coingecko_news_mint_unresolved', mint: MINT, reason: 'lookup_unavailable' },
        ]);
    });
});

describe('createCoinGeckoNewsNotFoundRecovery', () => {
    const recover = createCoinGeckoNewsNotFoundRecovery<string[]>([]);

    function error(body: string, status = 404) {
        return new UpstreamHttpError({
            message: 'CoinGecko request failed',
            service: 'coingecko',
            status,
            statusText: 'Not Found',
            body,
        });
    }

    it('recovers the exact CoinGecko lookup miss as an empty result', () => {
        expect(recover(error(JSON.stringify({ error_code: 404, error_message: 'Coin not found.' })))).toEqual({
            value: [],
            outcome: 'coin_not_found',
        });
    });

    it('emits recovered success telemetry for the exact lookup miss', async () => {
        const logs: string[] = [];
        console.log = (...args: unknown[]) => logs.push(String(args[0]));
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ error_code: 404, error_message: 'Coin not found.' }), {
                status: 404,
                statusText: 'Not Found',
            })) as typeof fetch;

        const result = await Effect.runPromise(
            fetchJsonWithRetry<string[]>({
                url: 'https://pro-api.coingecko.com/api/v3/news?coin_id=catalog-race',
                service: 'coingecko',
                maxRetries: 0,
                recoverHttpError: recover,
            }),
        );
        const event = logs
            .map(line => JSON.parse(line) as Record<string, unknown>)
            .find(line => line.event === 'external_call');

        expect(result).toEqual([]);
        expect(event?.provider).toBe('coingecko');
        expect(event?.endpoint).toBe('/api/v3/news');
        expect(event?.status).toBe(404);
        expect(event?.ok).toBe(true);
        expect(event?.recovered).toBe(true);
        expect(event?.outcome).toBe('coin_not_found');
    });

    it('does not recover a different 404 body', () => {
        expect(recover(error(JSON.stringify({ error_code: 404, error_message: 'Endpoint not found.' })))).toBeNull();
        expect(recover(error('<html>Not found</html>'))).toBeNull();
    });

    it('does not recover the same body for another status', () => {
        expect(recover(error(JSON.stringify({ error_code: 404, error_message: 'Coin not found.' }), 500))).toBeNull();
    });
});
