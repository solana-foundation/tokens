import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.module('server-only', () => ({}));

const { __resetCloudRunClientForTesting } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
const { signPlaygroundProxyAuthPayload } = await import('@/effect/playground-proxy-auth');
const { POST } = await import('./route');

const ENV_KEYS = [
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'TOKENS_REDIS_TARGET',
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_PLAYGROUND_PROXY_SECRET',
    'TOKENS_USAGE_LOG_MODE',
] as const;
const savedEnv: Record<string, string | undefined> = {};
const ORIGINAL_FETCH = globalThis.fetch;
const originalLog = console.log;
let logs: string[] = [];
let upstreamCalls: Array<{ name: string; body: unknown }> = [];

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

beforeEach(() => {
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    process.env.TOKENS_CLOUDRUN_AUTH_TOKEN = 'tok';
    process.env.TOKENS_CLOUDRUN_ASSETS_URL = 'https://assets.example.run.app';
    process.env.TOKENS_CLOUDRUN_PRICES_URL = 'https://prices.example.run.app';
    process.env.TOKENS_CLOUDRUN_USAGE_URL = 'https://usage.example.run.app';
    process.env.TOKENS_PLAYGROUND_PROXY_SECRET = 'test-playground-secret';
    process.env.TOKENS_USAGE_LOG_MODE = 'off';
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    logs = [];
    upstreamCalls = [];
    console.log = (...args: unknown[]) => {
        logs.push(String(args[0]));
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const name = String(input).split('/').pop() ?? '';
        upstreamCalls.push({ name, body: init?.body ? JSON.parse(String(init.body)) : null });
        const json = (payload: unknown) =>
            new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
        if (name === 'limitsEnforce') return json({ allowed: true });
        if (name === 'tokensGetSearchTokensByAddresses') return json([{ address: SOL, symbol: 'SOL' }]);
        return json(null);
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    console.log = originalLog;
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    resetEnvForTests();
    __resetCloudRunClientForTesting();
});

async function post(body: string | null): Promise<Response> {
    const now = Date.now();
    const auth = await signPlaygroundProxyAuthPayload({
        apiKeyId: 'k',
        keyPrefix: 'tk_test',
        projectId: 'p',
        ownerClerkUserId: 'u',
        scopes: ['assets:read'],
        iat: now,
        exp: now + 60_000,
    });
    return POST(
        new Request('https://api.example.test/api/v1/assets/market-snapshots', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-tokens-playground-auth': auth },
            ...(body === null ? {} : { body }),
        }),
        {} as never,
    );
}

function apiErrorLog(): Record<string, unknown> | undefined {
    return logs
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .find(line => line.event === 'api_error');
}

describe('POST /v1/assets/market-snapshots — request body handling', () => {
    it('a valid body is forwarded once, deduplicated', async () => {
        const res = await post(JSON.stringify({ mints: [SOL, USDC, SOL] }));
        expect(res.status).toBe(200);
        const upstream = upstreamCalls.find(c => c.name === 'tokensGetSearchTokensByAddresses');
        expect(upstream?.body).toEqual({ addresses: [SOL, USDC] });
        expect(apiErrorLog() === undefined).toBe(true);
    });

    it('malformed JSON is the caller’s error: 400, not a 500 wrapped SyntaxError', async () => {
        const res = await post('{"mints":[');
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { _tag: string; message: string; details?: unknown } };
        expect(body.error._tag).toBe('BadRequestError');
        expect(body.error.message).toBe('Invalid JSON body');
        expect(upstreamCalls.some(c => c.name === 'tokensGetSearchTokensByAddresses')).toBe(false);
        expect(apiErrorLog()?.status).toBe(400);
    });

    it('an empty body gets the same 400', async () => {
        const res = await post(null);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toBe('Invalid JSON body');
    });

    it('a body that fails the schema is a 400 whose details name the offending field, and the log carries them', async () => {
        const res = await post(JSON.stringify({ mints: ['0xdAC17F958D2ee523a2206206994597C13D831ec7'] }));
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string; details: string } };
        expect(body.error.message).toBe('Invalid body');
        expect(body.error.details).toContain('["mints"][0]');

        const logged = apiErrorLog();
        expect(logged?.error_type).toBe('BadRequestError');
        expect(logged?.error_message).toBe('Invalid body');
        expect(String(logged?.error_details)).toContain('["mints"][0]');
    });
});
