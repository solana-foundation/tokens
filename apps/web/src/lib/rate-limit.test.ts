import { afterEach, beforeEach, describe, expect, it, mock, spyOn, type Mock } from 'bun:test';

mock.module('server-only', () => ({}));

const { __resetRateLimitMemory, clientIdentifier, enforceRateLimit, rateLimitedResponse } =
    await import('./rate-limit');

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;
const savedEnv: Record<string, string | undefined> = {};
let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    __resetRateLimitMemory();
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    errorSpy.mockRestore();
});

const RULE = { scope: 'test', limit: 3, windowMs: 60_000 };

describe('clientIdentifier', () => {
    it('prefers x-real-ip, then the first forwarded hop, then unknown', () => {
        const mk = (headers: Record<string, string>) => new Request('https://x.test/', { headers });
        expect(clientIdentifier(mk({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' }))).toBe('1.1.1.1');
        expect(clientIdentifier(mk({ 'x-forwarded-for': '2.2.2.2, 10.0.0.1' }))).toBe('2.2.2.2');
        expect(clientIdentifier(mk({}))).toBe('unknown');
    });
});

describe('enforceRateLimit (memory fallback)', () => {
    it('allows up to the limit per identifier, then rejects with a retry hint', async () => {
        const results = [];
        for (let i = 0; i < 5; i++) results.push(await enforceRateLimit(RULE, 'ip-a'));
        expect(results.map(r => r.ok)).toEqual([true, true, true, false, false]);
        expect(results[3]!.backend).toBe('memory');
        expect(results[3]!.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(results[3]!.retryAfterSeconds).toBeLessThanOrEqual(60);
        // Another identifier has its own window.
        expect((await enforceRateLimit(RULE, 'ip-b')).ok).toBe(true);
    });
});

describe('enforceRateLimit (upstash)', () => {
    it('sends one EVAL per check and reads [count, ttl]', async () => {
        process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
        const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
        let count = 0;
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            calls.push({
                url,
                body: JSON.parse(String(init?.body)),
                auth: new Headers(init?.headers).get('authorization'),
            });
            count += 1;
            return Response.json({ result: [count, 42_000] });
        }) as unknown as typeof fetch;

        const first = await enforceRateLimit(RULE, 'ip-a');
        expect(first).toMatchObject({ ok: true, remaining: 2, backend: 'upstash' });
        for (let i = 0; i < 3; i++) await enforceRateLimit(RULE, 'ip-a');
        const blocked = await enforceRateLimit(RULE, 'ip-a');
        expect(blocked).toMatchObject({ ok: false, remaining: 0, retryAfterSeconds: 42, backend: 'upstash' });

        expect(calls[0]!.url).toBe('https://redis.example.test');
        expect(calls[0]!.auth).toBe('Bearer tok');
        const body = calls[0]!.body as unknown[];
        expect(body[0]).toBe('EVAL');
        expect(body[2]).toBe(1);
        expect(body[3]).toBe('web:rl:test:ip-a');
        expect(body[4]).toBe('60000');
    });

    it('fails open when Redis is unreachable, and says so', async () => {
        process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
        process.env.UPSTASH_REDIS_REST_TOKEN = 'tok';
        globalThis.fetch = (async () => {
            throw new Error('boom');
        }) as unknown as typeof fetch;
        const result = await enforceRateLimit(RULE, 'ip-a');
        expect(result).toMatchObject({ ok: true, backend: 'open' });
        expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
    });
});

describe('rateLimitedResponse', () => {
    it('is a 429 with Retry-After and no caching', async () => {
        const res = rateLimitedResponse({ ok: false, limit: 3, remaining: 0, retryAfterSeconds: 7, backend: 'memory' });
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('7');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({ error: 'rate_limited', retryAfterSeconds: 7 });
    });
});
