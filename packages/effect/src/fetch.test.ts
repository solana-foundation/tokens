import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Effect } from 'effect';
import { fetchJsonWithRetry } from './fetch';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;

let logs: string[] = [];

beforeEach(() => {
    logs = [];
    console.log = (...args: unknown[]) => {
        logs.push(String(args[0]));
    };
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.log = ORIGINAL_LOG;
});

function respond(status: number, body: string, statusText = 'Error'): void {
    globalThis.fetch = (async () => new Response(body, { status, statusText })) as typeof fetch;
}

function recoverCoinNotFound(error: { status: number; body?: string }) {
    if (error.status !== 404 || !error.body) return null;

    try {
        const body = JSON.parse(error.body) as { error_code?: unknown; error_message?: unknown };
        return body.error_code === 404 && body.error_message === 'Coin not found.'
            ? { value: [] as string[], outcome: 'coin_not_found' }
            : null;
    } catch {
        return null;
    }
}

describe('fetchJsonWithRetry HTTP recovery', () => {
    it('recovers a matching HTTP error before emitting success telemetry', async () => {
        respond(404, JSON.stringify({ error_code: 404, error_message: 'Coin not found.' }), 'Not Found');

        const result = await Effect.runPromise(
            fetchJsonWithRetry<string[]>({
                url: 'https://pro-api.coingecko.com/api/v3/news?coin_id=missing',
                service: 'coingecko',
                maxRetries: 0,
                recoverHttpError: recoverCoinNotFound,
            }),
        );

        expect(result).toEqual([]);
        const event = logs
            .map(line => JSON.parse(line) as Record<string, unknown>)
            .find(line => line.event === 'external_call');
        expect(event).toMatchObject({
            event: 'external_call',
            provider: 'coingecko',
            endpoint: '/api/v3/news',
            status: 404,
            ok: true,
            recovered: true,
            outcome: 'coin_not_found',
        });
        expect(event?.error_tag).toBeUndefined();
    });

    it('keeps a different 404 body as an UpstreamHttpError', async () => {
        respond(404, JSON.stringify({ error_code: 404, error_message: 'Endpoint not found.' }), 'Not Found');

        const error = await Effect.runPromise(
            Effect.flip(
                fetchJsonWithRetry<string[]>({
                    url: 'https://pro-api.coingecko.com/api/v3/news',
                    service: 'coingecko',
                    maxRetries: 0,
                    recoverHttpError: recoverCoinNotFound,
                }),
            ),
        );

        expect(error).toMatchObject({ _tag: 'UpstreamHttpError', status: 404 });
        const event = logs
            .map(line => JSON.parse(line) as Record<string, unknown>)
            .find(line => line.event === 'external_call');
        expect(event).toMatchObject({ ok: false, status: 404, error_tag: 'UpstreamHttpError' });
    });

    it.each([
        [401, 'UpstreamHttpError'],
        [429, 'RateLimitedError'],
        [500, 'UpstreamHttpError'],
    ] as const)('does not recover HTTP %s', async (status, tag) => {
        respond(status, JSON.stringify({ error_code: status, error_message: 'Different failure.' }));

        const error = await Effect.runPromise(
            Effect.flip(
                fetchJsonWithRetry<string[]>({
                    url: 'https://pro-api.coingecko.com/api/v3/news',
                    service: 'coingecko',
                    maxRetries: 0,
                    recoverHttpError: recoverCoinNotFound,
                }),
            ),
        );

        expect(error._tag).toBe(tag);
    });
});

describe('fetchJsonWithRetry telemetry timing', () => {
    it('times the request from when it runs, not from when the Effect was built', async () => {
        respond(200, JSON.stringify({ ok: true }), 'OK');
        const effect = fetchJsonWithRetry<{ ok: boolean }>({
            url: 'https://api.example.com/v1/thing',
            service: 'example',
            maxRetries: 0,
        });

        await new Promise(resolve => setTimeout(resolve, 80));
        await Effect.runPromise(effect);

        const event = logs
            .map(line => JSON.parse(line) as Record<string, unknown>)
            .find(line => line.event === 'external_call');
        expect(event).toMatchObject({ event: 'external_call', ok: true });
        expect(event?.duration_ms as number).toBeLessThan(60);
    });
});
