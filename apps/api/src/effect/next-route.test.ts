import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Effect } from 'effect';

mock.module('server-only', () => ({}));

const { __resetCloudRunClientForTesting, CloudRunQueryMemo } = await import('@/lib/cloudrun/client');
const { resetEnvForTests } = await import('@/lib/env');
const { BadRequestError, NotFoundError } = await import('@tokens/effect');
const { signPlaygroundProxyAuthPayload } = await import('./playground-proxy-auth');
const { route, __resetMergedAuthLimitsForTests } = await import('./next-route');
const { loadEnv } = await import('@/lib/env');

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'TOKENS_REDIS_TARGET',
    'TOKENS_CLOUDRUN_AUTH_TOKEN',
    'TOKENS_CLOUDRUN_ASSETS_URL',
    'TOKENS_CLOUDRUN_PRICES_URL',
    'TOKENS_CLOUDRUN_USAGE_URL',
    'TOKENS_PLAYGROUND_PROXY_SECRET',
    'TOKENS_LIMITS_BACKEND',
    'TOKENS_MERGED_AUTH_LIMITS',
] as const;
const savedEnv: Record<string, string | undefined> = {};

let logs: string[] = [];
const originalLog = console.log;

beforeEach(() => {
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
    // Cloud Run env present (auth service reachable through the faked fetch);
    // Redis env deliberately ABSENT so the limits path exercises fail-open.
    process.env.TOKENS_CLOUDRUN_AUTH_TOKEN = 'tok';
    process.env.TOKENS_CLOUDRUN_ASSETS_URL = 'https://assets.example.run.app';
    process.env.TOKENS_CLOUDRUN_PRICES_URL = 'https://prices.example.run.app';
    process.env.TOKENS_CLOUDRUN_USAGE_URL = 'https://usage.example.run.app';
    resetEnvForTests();
    __resetCloudRunClientForTesting();
    __resetMergedAuthLimitsForTests();
    logs = [];
    console.log = (...args: unknown[]) => {
        logs.push(String(args[0]));
    };
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

function fakeAuthFetch(authResult: unknown): void {
    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/query/apiKeysAuthenticate')) {
            return new Response(JSON.stringify(authResult), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
}

async function playgroundHeader(scopes: string[]): Promise<string> {
    const now = Date.now();
    return signPlaygroundProxyAuthPayload({
        apiKeyId: 'k',
        keyPrefix: 'tk_test',
        projectId: 'p',
        ownerClerkUserId: 'u',
        scopes,
        iat: now,
        exp: now + 60_000,
    });
}

const okHandler = route(() => Effect.succeed({ hello: 'world' }), {
    platform: { requiredScopes: ['assets:read'] },
});

function request(headers: Record<string, string> = {}): Request {
    return new Request('https://api.example.test/api/v1/assets/thing', { headers });
}

type Envelope = { error: { _tag: string; message: string } };

describe('route() auth/limits matrices', () => {
    it('401 with the envelope when no credentials are presented', async () => {
        const res = await okHandler(request(), {} as never);
        expect(res.status).toBe(401);
        const body = (await res.json()) as Envelope;
        expect(body.error._tag).toBe('UnauthorizedError');
        expect(body.error.message).toBe('Missing API key');
        expect(res.headers.get('x-request-id')).not.toBeNull();
    });

    it('401 when the API key does not authenticate', async () => {
        fakeAuthFetch(null);
        const res = await okHandler(request({ 'x-api-key': 'tk_bogus' }), {} as never);
        expect(res.status).toBe(401);
        const body = (await res.json()) as Envelope;
        expect(body.error._tag).toBe('UnauthorizedError');
        expect(body.error.message).toBe('Invalid API key');
    });

    it('403 when the key lacks a required scope', async () => {
        const header = await playgroundHeader(['tokens:read']);
        const res = await okHandler(request({ 'x-tokens-playground-auth': header }), {} as never);
        expect(res.status).toBe(403);
        const body = (await res.json()) as Envelope;
        expect(body.error._tag).toBe('ForbiddenError');
    });

    it('200 fail-open when Redis is unconfigured, logging rate_limit_degraded', async () => {
        const header = await playgroundHeader(['assets:read']);
        const res = await okHandler(request({ 'x-tokens-playground-auth': header }), {} as never);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ hello: 'world' });
        const degraded = logs.filter(line => line.includes('rate_limit_degraded'));
        expect(degraded.length).toBe(1);
    });

    it('maps handler BadRequestError to a 400 envelope', async () => {
        const handler = route(() => Effect.fail(new BadRequestError({ message: 'bad limit' })), {
            platform: { requiredScopes: ['assets:read'] },
        });
        const header = await playgroundHeader(['assets:read']);
        const res = await handler(request({ 'x-tokens-playground-auth': header }), {} as never);
        expect(res.status).toBe(400);
        const body = (await res.json()) as Envelope;
        expect(body.error._tag).toBe('BadRequestError');
        expect(body.error.message).toBe('bad limit');
    });

    it('maps handler NotFoundError to a 404 envelope', async () => {
        const handler = route(() => Effect.fail(new NotFoundError({ message: 'nope' })), {
            platform: { requiredScopes: ['assets:read'] },
        });
        const header = await playgroundHeader(['assets:read']);
        const res = await handler(request({ 'x-tokens-playground-auth': header }), {} as never);
        expect(res.status).toBe(404);
    });

    it('maps unknown failures to a 500 envelope', async () => {
        const handler = route(() => Effect.fail(new Error('kaboom')), {
            platform: { requiredScopes: ['assets:read'] },
        });
        const header = await playgroundHeader(['assets:read']);
        const res = await handler(request({ 'x-tokens-playground-auth': header }), {} as never);
        expect(res.status).toBe(500);
    });
});

describe('route() request-scoped query memo', () => {
    it('provides a fresh memo store per request — nothing leaks between requests', async () => {
        const seen: Array<number | null> = [];
        const handler = route(() =>
            Effect.gen(function* () {
                const store = yield* Effect.service(CloudRunQueryMemo);
                if (!store) {
                    seen.push(null);
                    return { ok: false };
                }
                // Whatever a previous request put must not be visible here.
                seen.push(store.take('k') ? 1 : 0);
                store.put('k', 'v');
                return { ok: true, size: store.size };
            }),
        );
        const first = await handler(request(), {} as never);
        const second = await handler(request(), {} as never);
        expect(await first.json()).toEqual({ ok: true, size: 1 });
        expect(await second.json()).toEqual({ ok: true, size: 1 });
        expect(seen).toEqual([0, 0]);
    });
});

// -----------------------------------------------------------------------------
// Merged auth + limits (TOKENS_LIMITS_BACKEND=usage)
// -----------------------------------------------------------------------------

const AUTH_RESULT = {
    apiKeyId: 'kh7test',
    keyPrefix: 'tk_test',
    projectId: 'prj_1',
    ownerClerkUserId: 'user_1',
    scopes: ['assets:read'],
};
const OK_LIMITS = {
    allowed: true,
    rateLimit: { limit: 400, remaining: 399, resetMs: 1_790_000_000_000 },
    quota: { limit: 1_000_000_000, used: 5, remaining: 999_999_995, resetMs: 1_790_500_000_000 },
};
const BLOCKED_LIMITS = { allowed: false, service: 'rateLimit', retryAfterMs: 1234 };

type UsageCall = { name: string; body: Record<string, unknown> };

/** Fakes the usage service: legacy query/mutation + the merged mutation. */
function fakeUsageFetch(options: {
    merged?: unknown | ((body: Record<string, unknown>) => Response);
    auth?: unknown;
    limits?: unknown;
}): UsageCall[] {
    // The Cloud Run caller captures `fetch` when it is built; rebuild it so a
    // swapped stub is actually used.
    __resetCloudRunClientForTesting();
    const calls: UsageCall[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const name = url.split('/').pop() ?? '';
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        calls.push({ name, body });
        const json = (payload: unknown, status = 200) =>
            new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
        if (name === 'apiKeysAuthenticateAndEnforce') {
            if (typeof options.merged === 'function')
                return (options.merged as (b: Record<string, unknown>) => Response)(body);
            return json(options.merged ?? { auth: AUTH_RESULT, limits: OK_LIMITS });
        }
        if (name === 'apiKeysAuthenticate') return json('auth' in options ? options.auth : AUTH_RESULT);
        if (name === 'limitsEnforce') return json('limits' in options ? options.limits : OK_LIMITS);
        return json(null);
    }) as typeof fetch;
    return calls;
}

function httpRequestLog(): Record<string, unknown> | undefined {
    const line = logs.find(l => l.includes('"event":"http_request"'));
    return line ? (JSON.parse(line) as Record<string, unknown>) : undefined;
}

describe('route() merged auth + limits', () => {
    beforeEach(() => {
        process.env.TOKENS_LIMITS_BACKEND = 'usage';
    });

    it('makes one merged call carrying the apps/api defaults, and logs the same limit metadata', async () => {
        const calls = fakeUsageFetch({});
        const res = await okHandler(request({ 'x-api-key': 'tk_live' }), {} as never);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ hello: 'world' });
        expect(calls.map(c => c.name)).toEqual(['apiKeysAuthenticateAndEnforce']);
        const env = loadEnv();
        expect(calls[0]!.body.defaults).toEqual({
            rateLimit: env.defaultRateLimit,
            sustainedRateLimit: env.defaultSustainedRateLimit,
            quota: env.defaultQuota,
        });
        expect(typeof calls[0]!.body.keyHash).toBe('string');
        const log = httpRequestLog();
        expect(log?.rate_limit).toEqual(OK_LIMITS.rateLimit);
        expect(log?.quota).toEqual(OK_LIMITS.quota);
        expect(log?.api_key_id).toBe('kh7test');
    });

    it('401 with the same envelope as the legacy path when auth is null', async () => {
        fakeUsageFetch({ merged: { auth: null } });
        const merged = await okHandler(request({ 'x-api-key': 'tk_bogus' }), {} as never);
        process.env.TOKENS_MERGED_AUTH_LIMITS = 'off';
        fakeUsageFetch({ auth: null });
        const legacy = await okHandler(request({ 'x-api-key': 'tk_bogus' }), {} as never);

        expect(merged.status).toBe(401);
        expect(legacy.status).toBe(401);
        expect(await merged.json()).toEqual(await legacy.json());
    });

    it('429 with the same envelope as the legacy path when limits block, and the key fields are logged', async () => {
        fakeUsageFetch({ merged: { auth: AUTH_RESULT, limits: BLOCKED_LIMITS } });
        const merged = await okHandler(request({ 'x-api-key': 'tk_live' }), {} as never);
        const mergedLog = httpRequestLog();
        logs = [];
        process.env.TOKENS_MERGED_AUTH_LIMITS = 'off';
        fakeUsageFetch({ limits: BLOCKED_LIMITS });
        const legacy = await okHandler(request({ 'x-api-key': 'tk_live' }), {} as never);

        expect(merged.status).toBe(429);
        expect(legacy.status).toBe(429);
        expect(await merged.json()).toEqual(await legacy.json());
        expect(mergedLog?.api_key_id).toBe('kh7test');
        expect(mergedLog?.project_id).toBe('prj_1');
    });

    it('fails open with rate_limit_degraded when the limits half is null', async () => {
        fakeUsageFetch({ merged: { auth: AUTH_RESULT, limits: null, limitsError: 'ECONNRESET' } });
        const res = await okHandler(request({ 'x-api-key': 'tk_live' }), {} as never);
        expect(res.status).toBe(200);
        const degraded = logs.filter(line => line.includes('rate_limit_degraded'));
        expect(degraded.length).toBe(1);
        expect(degraded[0]).toContain('ECONNRESET');
    });

    it('an older usage service (404) falls back to the two calls, and the next request skips the merged call', async () => {
        const calls = fakeUsageFetch({
            merged: () =>
                new Response(JSON.stringify({ error: 'unknown mutation: apiKeysAuthenticateAndEnforce' }), {
                    status: 404,
                    headers: { 'content-type': 'application/json' },
                }),
        });
        const first = await okHandler(request({ 'x-api-key': 'tk_live' }), {} as never);
        expect(first.status).toBe(200);
        expect(calls.map(c => c.name)).toEqual([
            'apiKeysAuthenticateAndEnforce',
            'apiKeysAuthenticate',
            'limitsEnforce',
        ]);

        calls.length = 0;
        const second = await okHandler(request({ 'x-api-key': 'tk_live' }), {} as never);
        expect(second.status).toBe(200);
        expect(calls.map(c => c.name)).toEqual(['apiKeysAuthenticate', 'limitsEnforce']);
    });

    it("any other transport failure is auth's and fails closed, with no legacy calls", async () => {
        const calls = fakeUsageFetch({
            merged: () => new Response('boom', { status: 500 }),
        });
        const res = await okHandler(request({ 'x-api-key': 'tk_live' }), {} as never);
        expect(res.status).toBe(500);
        expect(calls.map(c => c.name)).toEqual(['apiKeysAuthenticateAndEnforce']);
    });

    it('403 for a missing scope only after the merged call (limits are consumed, as today)', async () => {
        const calls = fakeUsageFetch({
            merged: { auth: { ...AUTH_RESULT, scopes: ['tokens:read'] }, limits: OK_LIMITS },
        });
        const res = await okHandler(request({ 'x-api-key': 'tk_live' }), {} as never);
        expect(res.status).toBe(403);
        expect(calls.map(c => c.name)).toEqual(['apiKeysAuthenticateAndEnforce']);
    });

    it('the playground-auth path is untouched: no merged call, limitsEnforce still runs', async () => {
        const calls = fakeUsageFetch({});
        const header = await playgroundHeader(['assets:read']);
        const res = await okHandler(request({ 'x-tokens-playground-auth': header }), {} as never);
        expect(res.status).toBe(200);
        expect(calls.map(c => c.name)).toEqual(['limitsEnforce']);
    });

    it('TOKENS_MERGED_AUTH_LIMITS=off uses the two legacy calls', async () => {
        process.env.TOKENS_MERGED_AUTH_LIMITS = 'off';
        const calls = fakeUsageFetch({});
        const res = await okHandler(request({ 'x-api-key': 'tk_live' }), {} as never);
        expect(res.status).toBe(200);
        expect(calls.map(c => c.name)).toEqual(['apiKeysAuthenticate', 'limitsEnforce']);
    });

    it('without TOKENS_LIMITS_BACKEND=usage the merged call is never made', async () => {
        delete process.env.TOKENS_LIMITS_BACKEND;
        const calls = fakeUsageFetch({});
        await okHandler(request({ 'x-api-key': 'tk_live' }), {} as never);
        expect(calls.map(c => c.name)).toEqual(['apiKeysAuthenticate']);
    });
});
