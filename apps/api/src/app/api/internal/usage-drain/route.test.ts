import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

const { resetEnvForTests } = await import('@/lib/env');
const { __resetRedisClientForTesting } = await import('@/lib/redis');
const { GET, POST } = await import('./route');

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_LOG = console.log;

const ENV_KEYS = [
    'CRON_SECRET',
    'TOKENS_USAGE_INGEST_SECRET',
    'TOKENS_REDIS_TARGET',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let logged: Array<Record<string, unknown>> = [];

/** Upstash REST stand-in with an empty dirty index (commands arrive batched on `/pipeline`). */
const emptyUpstash = (async (_url: unknown, init?: { body?: unknown }) => {
    const commands: unknown = JSON.parse(String(init?.body ?? '[]'));
    const batched = Array.isArray(commands) && Array.isArray(commands[0]);
    return Response.json(batched ? (commands as unknown[]).map(() => ({ result: [] })) : { result: [] });
}) as unknown as typeof fetch;

function request(authorization?: string): Request {
    return new Request('https://api.tokens.xyz/api/internal/usage-drain', {
        headers: authorization ? { authorization } : {},
    });
}

beforeEach(() => {
    for (const key of ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) savedEnv[key] = value;
        else delete savedEnv[key];
        delete process.env[key];
    }
    resetEnvForTests();
    __resetRedisClientForTesting();
    logged = [];
    console.log = (line: unknown) => {
        try {
            logged.push(JSON.parse(String(line)) as Record<string, unknown>);
        } catch {
            // not a structured event
        }
    };
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.log = ORIGINAL_LOG;
    for (const key of ENV_KEYS) {
        const value = savedEnv[key];
        if (value !== undefined) process.env[key] = value;
        else delete process.env[key];
    }
    resetEnvForTests();
    __resetRedisClientForTesting();
});

describe('GET /api/internal/usage-drain', () => {
    it('401s when no secret is configured, whatever the caller sends', async () => {
        expect((await GET(request())).status).toBe(401);
        expect((await GET(request('Bearer anything'))).status).toBe(401);
        expect((await GET(request('Bearer '))).status).toBe(401);
    });

    it('401s on a missing or wrong secret', async () => {
        process.env.CRON_SECRET = 'cron-secret';
        resetEnvForTests();

        expect((await GET(request())).status).toBe(401);
        expect((await GET(request('Bearer nope'))).status).toBe(401);
        expect((await GET(request('cron-secret'))).status).toBe(401);
        expect(logged.some(e => e.event === 'usage_drain')).toBe(false);
    });

    it('drains for the Vercel cron secret and reports the result', async () => {
        process.env.CRON_SECRET = 'cron-secret';
        process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
        resetEnvForTests();
        globalThis.fetch = emptyUpstash;

        const res = await GET(request('Bearer cron-secret'));

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, synced: 0, pending: 0 });
        expect(res.headers.get('cache-control')).toBe('no-store');
        const event = logged.find(e => e.event === 'usage_drain');
        expect(event?.trigger).toBe('schedule');
        expect(event?.status).toBe('ok');
    });

    it('also accepts TOKENS_USAGE_INGEST_SECRET, over POST', async () => {
        process.env.TOKENS_USAGE_INGEST_SECRET = 'ingest-secret';
        process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.upstash.io';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
        resetEnvForTests();
        globalThis.fetch = emptyUpstash;

        expect((await POST(request('Bearer ingest-secret'))).status).toBe(200);
    });

    it('502s and logs a failed drain when Redis is unavailable', async () => {
        process.env.CRON_SECRET = 'cron-secret';
        resetEnvForTests();

        const res = await GET(request('Bearer cron-secret'));

        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ ok: false, error: 'usage_drain_failed' });
        const event = logged.find(e => e.event === 'usage_drain');
        expect(event?.status).toBe('failed');
        // The log names the real cause, not a generic wrapper message.
        expect(String(event?.reason)).toContain('Upstash Redis is not configured');
    });
});
